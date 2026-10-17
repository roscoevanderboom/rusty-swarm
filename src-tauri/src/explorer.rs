//! File explorer backend: directory listing and drive enumeration.
//!
//! Commands exposed to the frontend:
//!   explorer_list_dir(path)  → Vec<DirEntry>
//!   explorer_list_drives()   → Vec<DriveInfo>

use std::collections::HashMap;
use std::time::UNIX_EPOCH;

use serde::Serialize;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    /// Byte size; None for directories.
    pub size: Option<u64>,
    /// Unix timestamp (seconds) of last modification.
    pub modified: Option<u64>,
    /// Lower-case file extension, without the leading dot.
    pub ext: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// Display label, e.g. "Local Disk (C:)"
    pub label: String,
    /// Root path, e.g. "C:\\"
    pub path: String,
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// List the direct children of `path`.  Returns an error string on failure.
#[tauri::command]
pub async fn explorer_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut reader = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("Cannot open \"{path}\": {e}"))?;

    let mut entries: Vec<DirEntry> = Vec::new();

    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| format!("Error reading dir: {e}"))?
    {
        // Use symlink_metadata so we don't silently follow symlinks.
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue, // skip unreadable entries
        };

        let name = entry.file_name().to_string_lossy().into_owned();

        // Skip hidden/system entries that start with '$' (Windows volume artefacts).
        // Users can later opt into showing hidden items; skip for now.
        if name.starts_with('$') {
            continue;
        }

        let is_dir = meta.is_dir();

        let size = if is_dir { None } else { Some(meta.len()) };

        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let ext = if is_dir {
            None
        } else {
            std::path::Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
        };

        entries.push(DirEntry {
            name,
            is_dir,
            size,
            modified,
            ext,
        });
    }

    // Folders first, then alphabetical (case-insensitive).
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Enumerate logical drives (Windows) or mount points (Unix).
#[tauri::command]
pub async fn explorer_list_drives() -> Result<Vec<DriveInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        list_drives_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_drives_unix()
    }
}

#[cfg(not(target_os = "windows"))]
fn list_drives_unix() -> Result<Vec<DriveInfo>, String> {
    use sysinfo::Disks;

    let disks = Disks::new_with_refreshed_list();
    let mut by_device: HashMap<String, DriveInfo> = HashMap::new();

    for disk in disks.iter() {
        let mount = disk.mount_point().to_string_lossy().into_owned();

        // Skip pseudo-filesystems and ephemeral mounts that are not actual local drives.
        if mount.starts_with("/snap/")
            || mount.starts_with("/boot")
            || mount.starts_with("/sys")
            || mount.starts_with("/proc")
            || mount.starts_with("/dev")
            || mount.starts_with("/run")
            || mount.starts_with("/tmp")
            || mount.starts_with("/var/tmp")
            || mount == "/etc"
            || mount == "/mnt"
        {
            continue;
        }

        let device = disk.name().to_string_lossy().into_owned();
        let key = if device.is_empty() { mount.clone() } else { device.clone() };
        let candidate = DriveInfo {
            label: if device.is_empty() || device == mount {
                mount.clone()
            } else {
                format!("{device} ({mount})")
            },
            path: mount.clone(),
        };

        match by_device.entry(key) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let existing = entry.get();
                let prefer_new = existing.path != "/" && mount == "/"
                    || (existing.path != "/" && mount.starts_with("/home") && !existing.path.starts_with("/home"));
                if prefer_new {
                    entry.insert(candidate);
                }
            }
        }
    }

    let mut drives: Vec<DriveInfo> = by_device.into_values().collect();

    // Always ensure root is present, even if sysinfo didn't surface it.
    if drives.is_empty() || !drives.iter().any(|d| d.path == "/") {
        drives.insert(
            0,
            DriveInfo {
                label: "/ (root)".to_owned(),
                path: "/".to_owned(),
            },
        );
    }

    // Sort: root first, then alphabetical. De-duplicate multiple partitions from the same disk.
    drives.sort_by(|a, b| {
        if a.path == "/" {
            std::cmp::Ordering::Less
        } else if b.path == "/" {
            std::cmp::Ordering::Greater
        } else {
            a.path.cmp(&b.path)
        }
    });

    Ok(drives)
}

#[cfg(target_os = "windows")]
fn list_drives_windows() -> Result<Vec<DriveInfo>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Storage::FileSystem::{GetLogicalDriveStringsW, GetVolumeInformationW};

    // Build the list of drive root paths from GetLogicalDriveStringsW.
    let mut buf = vec![0u16; 256];
    let len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
    if len == 0 || len as usize > buf.len() {
        return Err("GetLogicalDriveStringsW failed".to_owned());
    }

    let mut drives = Vec::new();
    let mut start = 0usize;
    for i in 0..len as usize {
        if buf[i] == 0 {
            if i > start {
                let os = OsString::from_wide(&buf[start..i]);
                let path = os.to_string_lossy().into_owned(); // e.g. "C:\"

                // Build a null-terminated UTF-16 path for GetVolumeInformationW.
                let mut root_w: Vec<u16> = path.encode_utf16().collect();
                root_w.push(0);

                // Buffer for the volume label.
                let mut vol_label = vec![0u16; 256];
                let ok = unsafe {
                    GetVolumeInformationW(
                        root_w.as_ptr(),
                        vol_label.as_mut_ptr(),
                        vol_label.len() as u32,
                        std::ptr::null_mut(), // lpVolumeSerialNumber
                        std::ptr::null_mut(), // lpMaximumComponentLength
                        std::ptr::null_mut(), // lpFileSystemFlags
                        std::ptr::null_mut(), // lpFileSystemNameBuffer
                        0,
                    )
                };

                // Find the null terminator in the label buffer.
                let label_len = vol_label.iter().position(|&c| c == 0).unwrap_or(0);
                let volume_name = if ok != 0 && label_len > 0 {
                    OsString::from_wide(&vol_label[..label_len])
                        .to_string_lossy()
                        .into_owned()
                } else {
                    String::new()
                };

                // Drive letter, e.g. 'C'
                let letter = path.chars().next().unwrap_or('?').to_ascii_uppercase();
                let label = if volume_name.is_empty() {
                    format!("Local Disk ({letter}:)")
                } else {
                    format!("{volume_name} ({letter}:)")
                };

                drives.push(DriveInfo { label, path });
            }
            start = i + 1;
        }
    }
    Ok(drives)
}
