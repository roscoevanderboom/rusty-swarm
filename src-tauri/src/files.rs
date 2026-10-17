//! File hosting for the REST API.
//!
//! Serves the folder chosen in Settings > Storage.
//!
//!   GET    /files                  list / HTML browser for the hosted root
//!   GET    /files/<path>           download a file, list a subfolder, or zip a folder (?zip=1)
//!   PUT    /files/<path>           upload (creates folders as needed; not when read-only)
//!   DELETE /files/<path>           delete a file or an empty folder (not when read-only)
//!
//! Browser behaviour
//!   When the request has an `Accept: text/html` header (i.e. a real browser tab), the
//!   directory listing returns a styled HTML page instead of JSON. Files are linked for
//!   direct download; folders are linked with ?token= forwarded so auth survives navigation.
//!   A "Download as zip" button appears on every folder.
//!
//! Safety: paths may only contain normal names (no `..`, no drive letters), and every
//! resolved path is canonicalized and must stay inside the hosted folder, so symlinks
//! can't be used to escape it. Symlinks are left out of listings.

use std::{
    io::Write as _,
    path::{Component, Path as FsPath, PathBuf},
    time::UNIX_EPOCH,
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use tokio_util::io::ReaderStream;

use crate::server::{ApiError, AppState};

// ── Helpers ──────────────────────────────────────────────────────────────────

struct Hosted {
    root: PathBuf,
    read_only: bool,
}

fn io_err(e: std::io::Error) -> ApiError {
    ApiError::internal(e.to_string())
}

fn outside() -> ApiError {
    ApiError::forbidden("That path is outside the hosted folder.")
}

async fn hosted(state: &AppState) -> Result<Hosted, ApiError> {
    let store = state.store()?;
    let enabled = store
        .get("fileHostingEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dir = store
        .get("fileHostingDir")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let read_only = store
        .get("fileHostingReadOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if !enabled {
        return Err(ApiError::not_found(
            "File hosting is turned off in Settings > Storage.",
        ));
    }
    if dir.is_empty() {
        return Err(ApiError::not_found(
            "No folder is chosen in Settings > Storage.",
        ));
    }
    let root = tokio::fs::canonicalize(&dir)
        .await
        .map_err(|_| ApiError::not_found("The hosted folder can't be found."))?;

    Ok(Hosted { root, read_only })
}

/// Keeps only plain path segments. Rejects `..`, absolute paths and drive prefixes.
fn safe_rel(raw: &str) -> Result<PathBuf, ApiError> {
    let mut out = PathBuf::new();
    for component in FsPath::new(raw).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(ApiError::bad("Invalid path.")),
        }
    }
    Ok(out)
}

fn display(rel: &FsPath) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

async fn resolve_existing(root: &FsPath, raw: &str) -> Result<PathBuf, ApiError> {
    let full = root.join(safe_rel(raw)?);
    let canon = tokio::fs::canonicalize(&full)
        .await
        .map_err(|_| ApiError::not_found("Not found."))?;
    if canon.starts_with(root) {
        Ok(canon)
    } else {
        Err(outside())
    }
}

/// True when the browser signals it can render HTML.
fn wants_html(req: &Request) -> bool {
    req.headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false)
}

/// Extract ?token= from the request URI (already validated by middleware, just forwarded).
fn token_from_query(req: &Request) -> String {
    req.uri()
        .query()
        .and_then(|q| {
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                if k == "token" { Some(v.to_owned()) } else { None }
            })
        })
        .unwrap_or_default()
}

/// True when ?zip=1 is present.
fn wants_zip(req: &Request) -> bool {
    req.uri()
        .query()
        .map(|q| q.split('&').any(|p| p == "zip=1" || p == "zip=true"))
        .unwrap_or(false)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

pub async fn list_root(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    serve(&state, "", req).await
}

pub async fn download(
    State(state): State<AppState>,
    Path(path): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    serve(&state, &path, req).await
}

async fn serve(state: &AppState, raw: &str, req: Request) -> Result<Response, ApiError> {
    let hosted = hosted(state).await?;
    let full = resolve_existing(&hosted.root, raw).await?;
    let meta = tokio::fs::metadata(&full).await.map_err(io_err)?;

    if meta.is_dir() {
        if wants_zip(&req) {
            return zip_dir(&hosted.root, &full).await;
        }
        let token = token_from_query(&req);
        let html = wants_html(&req);
        return list_dir(&hosted.root, &full, html, &token).await;
    }

    let file = tokio::fs::File::open(&full).await.map_err(io_err)?;
    let mime = mime_guess::from_path(&full).first_or_octet_stream();
    let filename = full
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CONTENT_LENGTH, meta.len().to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CONTENT_SECURITY_POLICY, "sandbox".to_owned()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}

// ── Directory listing ─────────────────────────────────────────────────────────

struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: Option<u64>,
}

async fn collect_entries(dir: &FsPath) -> Result<Vec<Entry>, ApiError> {
    let mut reader = tokio::fs::read_dir(dir).await.map_err(io_err)?;
    let mut entries = Vec::new();
    while let Some(e) = reader.next_entry().await.map_err(io_err)? {
        let Ok(meta) = e.metadata().await else { continue };
        let is_dir = meta.is_dir();
        if !is_dir && !meta.is_file() {
            continue; // skip symlinks
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir,
            size: meta.len(),
            modified,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

async fn list_dir(
    root: &FsPath,
    dir: &FsPath,
    html: bool,
    token: &str,
) -> Result<Response, ApiError> {
    let entries = collect_entries(dir).await?;
    let rel_path = dir.strip_prefix(root).map(display).unwrap_or_default();

    if !html {
        let json_entries: Vec<_> = entries
            .iter()
            .map(|e| {
                json!({
                    "name": e.name,
                    "type": if e.is_dir { "dir" } else { "file" },
                    "size": e.size,
                    "modified": e.modified,
                })
            })
            .collect();
        return Ok(
            Json(json!({ "path": rel_path, "entries": json_entries })).into_response(),
        );
    }

    Ok(html_listing(&rel_path, &entries, token).into_response())
}

// ── HTML listing ──────────────────────────────────────────────────────────────

fn format_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

fn format_ts(secs: Option<u64>) -> String {
    match secs {
        None => "—".into(),
        Some(s) => {
            // Minimal ISO-like date: we don't have chrono, so just display the raw seconds
            // in a human readable way by using standard time math.
            let secs_in_day = s % 86400;
            let days = s / 86400;
            // Days since Unix epoch → approximate Gregorian date (good enough for a file listing)
            let year = 1970 + days / 365;
            let day_of_year = days % 365;
            let month = (day_of_year / 30).min(11) + 1;
            let day = (day_of_year % 30) + 1;
            let h = secs_in_day / 3600;
            let m = (secs_in_day % 3600) / 60;
            format!("{year}-{month:02}-{day:02} {h:02}:{m:02}")
        }
    }
}

fn html_listing(rel_path: &str, entries: &[Entry], token: &str) -> impl IntoResponse {
    let token_param = if token.is_empty() {
        String::new()
    } else {
        format!("?token={token}")
    };

    // Breadcrumbs
    let mut breadcrumbs = String::from(r#"<a href="/files"#);
    breadcrumbs.push_str(&token_param);
    breadcrumbs.push_str(r#"" class="bc">⌂ Home</a>"#);

    if !rel_path.is_empty() {
        let mut acc = String::new();
        for part in rel_path.split('/') {
            acc.push('/');
            acc.push_str(part);
            breadcrumbs.push_str(&format!(
                r#" <span class="sep">›</span> <a href="/files{acc}{token_param}" class="bc">{part}</a>"#
            ));
        }
    }

    // Entry rows
    let mut rows = String::new();
    if !rel_path.is_empty() {
        // Parent link
        let parent = rel_path
            .rsplit_once('/')
            .map(|(p, _)| format!("/files/{p}"))
            .unwrap_or_else(|| "/files".into());
        rows.push_str(&format!(
            r#"<tr><td class="ic">📁</td><td><a href="{parent}{token_param}" class="name">..</a></td><td></td><td></td><td></td></tr>"#
        ));
    }

    for e in entries {
        let href = if rel_path.is_empty() {
            format!("/files/{}{token_param}", e.name)
        } else {
            format!("/files/{}/{}{token_param}", rel_path, e.name)
        };
        let zip_href = if rel_path.is_empty() {
            format!("/files/{}?zip=1{}", e.name, if token.is_empty() { String::new() } else { format!("&token={token}") })
        } else {
            format!("/files/{}/{}?zip=1{}", rel_path, e.name, if token.is_empty() { String::new() } else { format!("&token={token}") })
        };

        let (icon, size_str, actions) = if e.is_dir {
            (
                "📁",
                "—".into(),
                format!(r#"<a href="{zip_href}" class="btn" title="Download as zip" download>⬇ zip</a>"#),
            )
        } else {
            (
                icon_for(&e.name),
                format_size(e.size),
                format!(r#"<a href="{href}" class="btn" download>⬇</a>"#),
            )
        };

        let modified = format_ts(e.modified);
        let name_cell = if e.is_dir {
            format!(r#"<a href="{href}" class="name dir">{}</a>"#, e.name)
        } else {
            format!(r#"<a href="{href}" class="name">{}</a>"#, e.name)
        };

        rows.push_str(&format!(
            "<tr><td class=\"ic\">{icon}</td><td>{name_cell}</td><td class=\"sz\">{size_str}</td><td class=\"ts\">{modified}</td><td class=\"ac\">{actions}</td></tr>"
        ));
    }

    let title = if rel_path.is_empty() {
        "Files".into()
    } else {
        format!("/{rel_path}")
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rusty-swarm · {title}</title>
<style>
  :root {{
    --bg: #0f172a; --surface: #1e293b; --border: #334155;
    --fg: #f1f5f9; --muted: #94a3b8; --accent: #818cf8;
    --hover: #273449; --radius: 8px; --font: system-ui, sans-serif;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--fg); font-family: var(--font);
          font-size: 14px; padding: 32px 24px; min-height: 100vh; }}
  .shell {{ max-width: 960px; margin: 0 auto; }}
  header {{ display: flex; align-items: center; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }}
  .logo {{ font-size: 20px; font-weight: 700; color: var(--accent); white-space: nowrap; }}
  .breadcrumbs {{ display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 13px; }}
  .bc {{ color: var(--accent); text-decoration: none; }}
  .bc:hover {{ text-decoration: underline; }}
  .sep {{ color: var(--muted); }}
  .card {{ background: var(--surface); border: 1px solid var(--border);
           border-radius: var(--radius); overflow: hidden; }}
  table {{ width: 100%; border-collapse: collapse; }}
  thead tr {{ background: #0f172a; }}
  th {{ padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }}
  td {{ padding: 9px 14px; border-top: 1px solid var(--border); vertical-align: middle; }}
  tr:hover td {{ background: var(--hover); }}
  .ic {{ width: 28px; font-size: 16px; padding-right: 0; }}
  .name {{ color: var(--fg); text-decoration: none; font-weight: 500; display: block; }}
  .name:hover {{ color: var(--accent); }}
  .name.dir {{ color: var(--accent); }}
  .sz {{ width: 90px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }}
  .ts {{ width: 140px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }}
  .ac {{ width: 80px; text-align: right; }}
  .btn {{ display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
          border-radius: 5px; background: transparent; border: 1px solid var(--border);
          color: var(--muted); font-size: 12px; text-decoration: none; white-space: nowrap; }}
  .btn:hover {{ border-color: var(--accent); color: var(--accent); background: rgba(129,140,248,.08); }}
  .empty {{ padding: 48px; text-align: center; color: var(--muted); }}
  @media (max-width: 600px) {{ .ts, .sz {{ display: none; }} }}
</style>
</head>
<body>
<div class="shell">
  <header>
    <span class="logo">rusty-swarm</span>
    <nav class="breadcrumbs">{breadcrumbs}</nav>
  </header>
  <div class="card">
    <table>
      <thead><tr>
        <th></th><th>Name</th><th class="sz">Size</th><th class="ts">Modified</th><th class="ac"></th>
      </tr></thead>
      <tbody>
        {rows_or_empty}
      </tbody>
    </table>
  </div>
</div>
</body>
</html>"#,
        rows_or_empty = if rows.is_empty() {
            r#"<tr><td colspan="5" class="empty">This folder is empty.</td></tr>"#.into()
        } else {
            rows
        }
    );

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}

fn icon_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "ico" | "bmp" => "🖼",
        "mp4" | "mkv" | "mov" | "avi" | "webm" => "🎬",
        "mp3" | "flac" | "wav" | "ogg" | "aac" | "m4a" => "🎵",
        "pdf" => "📄",
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" | "rar" => "📦",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "c" | "cpp" | "h" | "cs" | "java"
        | "rb" | "php" | "swift" | "kt" | "sh" | "bat" | "ps1" => "📝",
        "json" | "toml" | "yaml" | "yml" | "xml" | "csv" | "html" | "css" | "md" => "📋",
        "exe" | "msi" | "dmg" | "deb" | "rpm" | "apk" => "⚙",
        _ => "📄",
    }
}

// ── Zip streaming ─────────────────────────────────────────────────────────────

async fn zip_dir(root: &FsPath, dir: &FsPath) -> Result<Response, ApiError> {
    let dir = dir.to_owned();
    let root = root.to_owned();

    let folder_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "files".into());

    let dir_clone = dir.to_owned();
    let root_clone = root.to_owned();
    let zip_bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        add_dir_to_zip(&mut zip, &root_clone, &dir_clone, opts)?;
        let cursor = zip.finish().map_err(|e| e.to_string())?;
        Ok(cursor.into_inner())
    })
    .await
    .map_err(|e| ApiError::internal(format!("Zip task failed: {e}")))?
    .map_err(ApiError::internal)?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{folder_name}.zip\""),
            ),
            (
                header::CONTENT_LENGTH,
                zip_bytes.len().to_string(),
            ),
        ],
        zip_bytes,
    )
        .into_response())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>,
    root: &FsPath,
    dir: &FsPath,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("Could not read dir {dir:?}: {e}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable entries
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue;
        }

        // Path inside the zip, relative to the folder being zipped.
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        if meta.is_dir() {
            let _ = zip.add_directory(&rel, opts); // ignore errors for individual dirs
            add_dir_to_zip(zip, root, &path, opts)?;
        } else if meta.is_file() {
            // Skip files we can't read (locked, permission denied, etc.)
            let data = match std::fs::read(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            if zip.start_file(&rel, opts).is_ok() {
                let _ = zip.write_all(&data); // best-effort
            }
        }
    }
    Ok(())
}

// ── Upload / Delete ───────────────────────────────────────────────────────────

pub async fn upload(
    State(state): State<AppState>,
    Path(path): Path<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let hosted = hosted(&state).await?;
    if hosted.read_only {
        return Err(ApiError::forbidden(
            "The hosted folder is read-only. Turn off Read-only in Settings > Storage to allow uploads.",
        ));
    }

    let rel = safe_rel(&path)?;
    if rel.as_os_str().is_empty() {
        return Err(ApiError::bad(
            "Give the file a name, for example PUT /files/notes.txt.",
        ));
    }
    let full = hosted.root.join(&rel);
    let parent = full
        .parent()
        .ok_or_else(|| ApiError::bad("Invalid path."))?;

    for ancestor in parent.ancestors() {
        if let Ok(canon) = tokio::fs::canonicalize(ancestor).await {
            if !canon.starts_with(&hosted.root) {
                return Err(outside());
            }
            break;
        }
    }
    tokio::fs::create_dir_all(parent).await.map_err(io_err)?;

    if let Ok(existing) = tokio::fs::canonicalize(&full).await {
        if !existing.starts_with(&hosted.root) {
            return Err(outside());
        }
        if existing.is_dir() {
            return Err(ApiError::conflict(
                "A folder with that name already exists.",
            ));
        }
    }

    tokio::fs::write(&full, &body).await.map_err(io_err)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "path": display(&rel), "size": body.len() })),
    )
        .into_response())
}

pub async fn remove(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    let hosted = hosted(&state).await?;
    if hosted.read_only {
        return Err(ApiError::forbidden(
            "The hosted folder is read-only. Turn off Read-only in Settings > Storage to allow deleting.",
        ));
    }

    let full = resolve_existing(&hosted.root, &path).await?;
    if full == hosted.root {
        return Err(ApiError::bad("The hosted folder itself can't be deleted."));
    }

    let is_dir = tokio::fs::metadata(&full).await.map_err(io_err)?.is_dir();
    if is_dir {
        tokio::fs::remove_dir(&full).await.map_err(|e| {
            ApiError::conflict(format!("Couldn't remove the folder. Is it empty? ({e})"))
        })?;
    } else {
        tokio::fs::remove_file(&full).await.map_err(io_err)?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
