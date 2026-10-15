import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  homeDir,
  desktopDir,
  downloadDir,
  documentDir,
  pictureDir,
  audioDir,
  videoDir,
} from "@tauri-apps/api/path";
import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import {
  LuChevronLeft,
  LuChevronRight,
  LuArrowUp,
  LuRefreshCw,
  LuLayoutGrid,
  LuList,
  LuFolder,
  LuFolderOpen,
  LuFile,
  LuFileText,
  LuFileImage,
  LuHardDrive,
  LuStar,
  LuDownload,
  LuMonitor,
  LuMusic,
  LuVideo,
  LuHouse,
  LuLoaderCircle,
} from "react-icons/lu";

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = "grid" | "list";

interface FsEntry {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: number; // unix seconds
  ext?: string;
}

interface SidebarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Resolved at runtime; empty string while loading */
  path: string;
}

interface DriveInfo {
  label: string;
  path: string;
}

// ── Path utilities ─────────────────────────────────────────────────────────────

/**
 * Normalise a path so the Tauri fs plugin is happy:
 *   – forward slashes → backslashes on Windows
 *   – trailing backslash preserved only for drive roots (C:\)
 *   – no double slashes
 */
function normPath(p: string): string {
  // Replace all forward slashes with backslashes
  let s = p.replace(/\//g, "\\");
  // Collapse consecutive separators
  s = s.replace(/\\{2,}/g, "\\");
  // Drive root: always keep trailing backslash
  if (/^[A-Za-z]:\\$/.test(s)) return s;
  // Everything else: strip trailing backslash
  s = s.replace(/\\$/, "");
  return s;
}

function joinPath(base: string, name: string): string {
  const b = normPath(base);
  // Drive root already ends with backslash
  if (/^[A-Za-z]:\\$/.test(b)) return b + name;
  return b + "\\" + name;
}

function parentPath(p: string): string | null {
  const s = normPath(p);
  if (/^[A-Za-z]:\\$/.test(s)) return null; // already a drive root
  const last = s.lastIndexOf("\\");
  if (last <= 0) return null;
  const parent = s.slice(0, last);
  // e.g. "C:" → "C:\"
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent;
}

function pathSegments(p: string): { label: string; path: string }[] {
  const s = normPath(p);
  const parts = s.split("\\").filter(Boolean);
  const result: { label: string; path: string }[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0 && part.endsWith(":")) {
      acc = part + "\\";
    } else {
      acc = acc.replace(/\\$/, "") + "\\" + part;
    }
    result.push({ label: i === 0 ? acc : part, path: normPath(acc) });
  }
  return result;
}

/** Format bytes into human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Format a unix timestamp as a locale date string */
function formatDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// ── Icon helpers ───────────────────────────────────────────────────────────────

function fileIcon(entry: FsEntry): React.ReactNode {
  if (entry.isDir) return <LuFolder size={18} />;
  const ext = (entry.ext ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) return <LuFileImage size={18} />;
  if (["mp3", "wav", "flac", "ogg", "aac"].includes(ext)) return <LuMusic size={18} />;
  if (["mp4", "mkv", "avi", "mov", "webm"].includes(ext)) return <LuVideo size={18} />;
  if (["txt", "md", "log", "csv", "json", "xml", "yaml", "toml", "ini"].includes(ext)) return <LuFileText size={18} />;
  return <LuFile size={18} />;
}

function fileIconLarge(entry: FsEntry): string {
  if (entry.isDir) return "📁";
  const ext = (entry.ext ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "🖼️";
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "🎵";
  if (["mp4", "mkv", "avi", "mov"].includes(ext)) return "🎬";
  if (["pdf"].includes(ext)) return "📕";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜️";
  if (["txt", "md", "log"].includes(ext)) return "📝";
  if (["exe", "msi"].includes(ext)) return "⚙️";
  return "📄";
}

// ── Component ──────────────────────────────────────────────────────────────────

export function FileExplorer() {
  // ---- Sidebar data (resolved asynchronously) ----
  const [favorites, setFavorites] = useState<SidebarItem[]>([
    { id: "home",      label: "Home",      icon: <LuHouse size={15} />,     path: "" },
    { id: "desktop",   label: "Desktop",   icon: <LuMonitor size={15} />,   path: "" },
    { id: "downloads", label: "Downloads", icon: <LuDownload size={15} />,  path: "" },
    { id: "documents", label: "Documents", icon: <LuFileText size={15} />,  path: "" },
    { id: "pictures",  label: "Pictures",  icon: <LuFileImage size={15} />, path: "" },
    { id: "music",     label: "Music",     icon: <LuMusic size={15} />,     path: "" },
    { id: "videos",    label: "Videos",    icon: <LuVideo size={15} />,     path: "" },
  ]);
  const [drives, setDrives] = useState<DriveInfo[]>([]);

  // ---- Explorer state ----
  const [currentPath, setCurrentPath] = useState("");
  const [history, setHistory]         = useState<string[]>([]);
  const [historyIdx, setHistoryIdx]   = useState(-1);
  const [entries, setEntries]         = useState<FsEntry[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [view, setView]               = useState<ViewMode>("list");
  const [selected, setSelected]       = useState<string | null>(null);
  const [activeSidebar, setActiveSidebar] = useState("home");

  // ---- Watcher cleanup ref ----
  const unwatchRef = useRef<UnwatchFn | null>(null);

  // ── Resolve real favorite paths on mount ──────────────────────────────────

  useEffect(() => {
    async function resolveFavorites() {
      const resolvers: (() => Promise<string>)[] = [
        homeDir,
        desktopDir,
        downloadDir,
        documentDir,
        pictureDir,
        audioDir,
        videoDir,
      ];
      const resolved = await Promise.allSettled(resolvers.map((fn) => fn()));
      setFavorites((prev) =>
        prev.map((item, i) => ({
          ...item,
          path: resolved[i].status === "fulfilled" ? normPath(resolved[i].value) : item.path,
        }))
      );
    }
    resolveFavorites();
  }, []);

  // ── Resolve drives on mount ────────────────────────────────────────────────

  useEffect(() => {
    invoke<DriveInfo[]>("explorer_list_drives")
      .then((d) => setDrives(d))
      .catch((e) => console.error("explorer_list_drives:", e));
  }, []);

  // ── Navigate to home once favorites are resolved ──────────────────────────

  useEffect(() => {
    const home = favorites.find((f) => f.id === "home");
    if (home?.path && currentPath === "") {
      navigateTo(home.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites]);

  // ── Load directory contents ────────────────────────────────────────────────

  const loadDir = useCallback(async (path: string) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setSelected(null);

    // Stop previous watcher
    if (unwatchRef.current) {
      try { unwatchRef.current(); } catch { /* ignore */ }
      unwatchRef.current = null;
    }

    try {
      const result = await invoke<FsEntry[]>("explorer_list_dir", { path });
      setEntries(result);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }

    // Start a new watcher for the directory
    try {
      const unwatch = await watch(
        path,
        () => {
          // Re-fetch entries when anything changes inside this directory
          invoke<FsEntry[]>("explorer_list_dir", { path })
            .then((result) => setEntries(result))
            .catch(() => { /* directory may have been deleted */ });
        },
        { recursive: false }
      );
      unwatchRef.current = unwatch;
    } catch (e) {
      console.warn("watch failed for", path, e);
    }
  }, []);

  // Reload whenever currentPath changes
  useEffect(() => {
    if (currentPath) loadDir(currentPath);
  }, [currentPath, loadDir]);

  // Cleanup watcher on unmount
  useEffect(() => {
    return () => {
      if (unwatchRef.current) {
        try { unwatchRef.current(); } catch { /* ignore */ }
      }
    };
  }, []);

  // ── Navigation helpers ─────────────────────────────────────────────────────

  function navigateTo(path: string) {
    const p = normPath(path);
    setHistory((prev) => {
      const next = prev.slice(0, historyIdx + 1);
      next.push(p);
      setHistoryIdx(next.length - 1);
      return next;
    });
    setCurrentPath(p);
  }

  function goBack() {
    if (historyIdx <= 0) return;
    const idx = historyIdx - 1;
    setHistoryIdx(idx);
    setCurrentPath(history[idx]);
  }

  function goForward() {
    if (historyIdx >= history.length - 1) return;
    const idx = historyIdx + 1;
    setHistoryIdx(idx);
    setCurrentPath(history[idx]);
  }

  function goUp() {
    const parent = parentPath(currentPath);
    if (parent) navigateTo(parent);
  }

  function handleEntryOpen(entry: FsEntry) {
    if (!entry.isDir) return;
    navigateTo(joinPath(currentPath, entry.name));
  }

  function handleSidebarNavigate(item: SidebarItem | DriveInfo, id: string) {
    if (!item.path) return;
    setActiveSidebar(id);
    navigateTo(item.path);
  }

  const canBack    = historyIdx > 0;
  const canForward = historyIdx < history.length - 1;
  const canUp      = parentPath(currentPath) !== null;
  const segments   = pathSegments(currentPath);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="file-explorer">

      {/* ── Toolbar ── */}
      <div className="fe-toolbar">
        <button
          className="fe-toolbar-btn"
          title="Back"
          disabled={!canBack}
          onClick={goBack}
          aria-label="Go back"
        >
          <LuChevronLeft size={16} aria-hidden />
        </button>
        <button
          className="fe-toolbar-btn"
          title="Forward"
          disabled={!canForward}
          onClick={goForward}
          aria-label="Go forward"
        >
          <LuChevronRight size={16} aria-hidden />
        </button>
        <button
          className="fe-toolbar-btn"
          title="Up one level"
          disabled={!canUp}
          onClick={goUp}
          aria-label="Go up"
        >
          <LuArrowUp size={16} aria-hidden />
        </button>
        <button
          className="fe-toolbar-btn"
          title="Refresh"
          onClick={() => loadDir(currentPath)}
          aria-label="Refresh"
        >
          <LuRefreshCw size={14} aria-hidden />
        </button>

        {/* Address breadcrumb */}
        <div className="fe-address-bar" role="navigation" aria-label="Path breadcrumb">
          <div className="fe-address-segments">
            {segments.map((seg, i) => (
              <span key={seg.path} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                {i > 0 && <span className="fe-breadcrumb-sep">›</span>}
                <button
                  className="fe-breadcrumb"
                  onClick={() => navigateTo(seg.path)}
                  title={seg.path}
                >
                  {seg.label}
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="fe-body">

        {/* ── Sidebar ── */}
        <nav className="fe-sidebar" aria-label="File explorer navigation">

          <div className="fe-sidebar-section">
            <div className="fe-sidebar-heading">
              <LuStar size={10} style={{ display: "inline", marginRight: 4 }} aria-hidden />
              Favorites
            </div>
            {favorites.map((item) => (
              <button
                key={item.id}
                className={`fe-sidebar-item${activeSidebar === item.id ? " active" : ""}`}
                onClick={() => handleSidebarNavigate(item, item.id)}
                disabled={!item.path}
                title={item.path || "Loading…"}
              >
                <span className="fe-sidebar-icon" aria-hidden>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>

          <div className="fe-sidebar-divider" role="separator" />

          <div className="fe-sidebar-section">
            <div className="fe-sidebar-heading">
              <LuHardDrive size={10} style={{ display: "inline", marginRight: 4 }} aria-hidden />
              Drives
            </div>
            {drives.length === 0 && (
              <span style={{ padding: "4px 8px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                Loading…
              </span>
            )}
            {drives.map((d) => (
              <button
                key={d.path}
                className={`fe-sidebar-item${activeSidebar === d.path ? " active" : ""}`}
                onClick={() => handleSidebarNavigate(d, d.path)}
              >
                <span className="fe-sidebar-icon" aria-hidden>
                  <LuHardDrive size={15} />
                </span>
                {d.label}
              </button>
            ))}
          </div>

        </nav>

        {/* ── Main panel ── */}
        <div className="fe-main">

          {/* View toggle bar */}
          <div className="fe-view-bar">
            <span className="fe-item-count">
              {loading ? "Loading…" : `${entries.length} item${entries.length !== 1 ? "s" : ""}`}
            </span>
            <div className="fe-view-group" role="group" aria-label="View mode">
              <button
                className={`fe-view-btn${view === "grid" ? " active" : ""}`}
                title="Grid view"
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                aria-label="Grid view"
              >
                <LuLayoutGrid size={15} aria-hidden />
              </button>
              <button
                className={`fe-view-btn${view === "list" ? " active" : ""}`}
                title="List view"
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                aria-label="List view"
              >
                <LuList size={15} aria-hidden />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="fe-content" role="main">
            {error ? (
              <div className="fe-empty" role="alert">
                <LuLoaderCircle size={40} aria-hidden />
                <span>{error}</span>
              </div>
            ) : loading ? (
              <div className="fe-empty" role="status">
                <span className="fe-spinner" aria-label="Loading" />
              </div>
            ) : entries.length === 0 ? (
              <div className="fe-empty" role="status">
                <LuFolderOpen size={48} aria-hidden />
                <span>This folder is empty</span>
              </div>
            ) : view === "grid" ? (
              <div className="fe-grid" role="listbox" aria-label="Files and folders">
                {entries.map((entry) => (
                  <button
                    key={entry.name}
                    className={`fe-grid-item${selected === entry.name ? " selected" : ""}`}
                    role="option"
                    aria-selected={selected === entry.name}
                    onClick={() => setSelected(entry.name)}
                    onDoubleClick={() => handleEntryOpen(entry)}
                    title={entry.name}
                  >
                    <span className="fe-grid-icon" aria-hidden>{fileIconLarge(entry)}</span>
                    <span className="fe-grid-name">{entry.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="fe-list" role="listbox" aria-label="Files and folders">
                <div className="fe-list-header" role="row">
                  <span className="fe-list-header-cell" role="columnheader">Name</span>
                  <span className="fe-list-header-cell" role="columnheader">Date modified</span>
                  <span className="fe-list-header-cell" role="columnheader">Size</span>
                </div>
                {entries.map((entry) => (
                  <button
                    key={entry.name}
                    className={`fe-list-item${selected === entry.name ? " selected" : ""}`}
                    role="option"
                    aria-selected={selected === entry.name}
                    onClick={() => setSelected(entry.name)}
                    onDoubleClick={() => handleEntryOpen(entry)}
                    title={entry.name}
                  >
                    <span className="fe-list-name">
                      <span style={{ color: "var(--accent-color)", flexShrink: 0 }} aria-hidden>
                        {fileIcon(entry)}
                      </span>
                      <span className="fe-list-name-text">{entry.name}</span>
                    </span>
                    <span className="fe-list-cell">{formatDate(entry.modified)}</span>
                    <span className="fe-list-cell">
                      {entry.isDir ? "—" : entry.size != null ? formatSize(entry.size) : "—"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="fe-statusbar" role="status" aria-live="polite">
            <span>{entries.length} item{entries.length !== 1 ? "s" : ""}</span>
            {selected && (
              <span>
                Selected: <strong>{selected}</strong>
              </span>
            )}
            {currentPath && (
              <span style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {currentPath}
              </span>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

export default FileExplorer;
