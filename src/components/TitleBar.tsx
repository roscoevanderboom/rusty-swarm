import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLocation, useNavigate } from "react-router-dom";
import { hideMainWindow, getPlatform } from "../lib/native";
import { LuArrowLeft, LuSettings } from "react-icons/lu";

const win = isTauri() ? getCurrentWindow() : null;
const platform = getPlatform();

// SVG icons sized for a compact titlebar
function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 1" fill="currentColor" aria-hidden="true">
      <rect width="10" height="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2.6" y="0.6" width="6.8" height="6.8" rx="1" />
      <path d="M1 3v5.4A1 1 0 002 9.4h5.4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <line x1="1" y1="1" x2="9" y2="9" />
      <line x1="9" y1="1" x2="1" y2="9" />
    </svg>
  );
}

export interface TitleBarProps {
  /** When true, the close button hides the window instead of destroying it. */
  closeToTray: boolean;
  onOpenSettings: () => void;
}

export function TitleBar({ closeToTray, onOpenSettings }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const showBack = location.pathname !== "/";

  useEffect(() => {
    if (!win) return;
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized);
    win.onResized(() => win.isMaximized().then(setMaximized)).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

  const handleClose = () => {
    if (!win) return;
    if (closeToTray) void hideMainWindow();
    else void win.close();
  };

  // In the browser (vite dev without Tauri) render a minimal placeholder so
  // the layout offset is still present and the app doesn't feel broken.
  if (!win) {
    return (
      <div className="titlebar" aria-label="Window titlebar">
        <div className="titlebar-drag">
          {showBack && (
            <button
              className="titlebar-btn titlebar-btn--back"
              title="Back to home"
              aria-label="Back to home"
              onClick={() => navigate("/")}
            >
              <LuArrowLeft size={14} />
            </button>
          )}
        </div>
        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            title="Settings"
            aria-label="Open settings"
            onClick={onOpenSettings}
          >
            <LuSettings size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="titlebar" aria-label="Window titlebar">
      <div className="titlebar-drag" data-tauri-drag-region>
        {showBack && (
          <button
            className="titlebar-btn titlebar-btn--back"
            title="Back to home"
            aria-label="Back to home"
            onClick={() => navigate("/")}
          >
            <LuArrowLeft size={14} />
          </button>
        )}
      </div>
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          title="Settings"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <LuSettings size={14} />
        </button>
        {platform === "windows" && (
          <>
            <div className="titlebar-separator" />
            <button
              className="titlebar-btn titlebar-btn--minimize"
              title="Minimize"
              aria-label="Minimize window"
              onClick={() => void win!.minimize()}
            >
              <MinimizeIcon />
            </button>
            <button
              className="titlebar-btn titlebar-btn--maximize"
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore window" : "Maximize window"}
              onClick={() => void win!.toggleMaximize()}
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button
              className="titlebar-btn titlebar-btn--close"
              title={closeToTray ? "Hide to tray" : "Close"}
              aria-label={closeToTray ? "Hide window to tray" : "Close window"}
              onClick={handleClose}
            >
              <CloseIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
