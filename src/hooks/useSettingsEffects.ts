import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { applyAppearanceMode } from "../lib/theme";
import {
  applyZoom,
  ensureNotificationPermission,
  errorMessage,
  hideMainWindow,
  registerToggleShortcut,
  setAutostart,
  showMainWindow,
  toggleMainWindow,
} from "../lib/native";
import type { FontSize, Settings } from "../types/schema";

export interface EffectErrors {
  autostart?: string;
  shortcut?: string;
  notifications?: string;
}

const FONT_SIZE: Record<FontSize, string> = {
  small: "87.5%",
  default: "100%",
  large: "112.5%",
};

/**
 * Turns settings into real behavior. Mount once, at the top of the app, so
 * settings keep working while the settings modal is closed.
 */
export function useSettingsEffects(s: Settings, ready: boolean) {
  const [errors, setErrors] = useState<EffectErrors>({});
  const setError = useCallback((key: keyof EffectErrors, message?: string) => {
    setErrors((prev) => (prev[key] === message ? prev : { ...prev, [key]: message }));
  }, []);

  // Theme: data-theme on <html> plus the native window theme (see theme.ts).
  useEffect(() => {
    applyAppearanceMode(s.themeMode);
  }, [s.themeMode]);

  // Accent: empty means "use the theme's own accent".
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement.style;
    if (s.accent) {
      root.setProperty("--accent-color", s.accent);
      root.setProperty("--accent-hover", `color-mix(in srgb, ${s.accent} 82%, black)`);
    } else {
      root.removeProperty("--accent-color");
      root.removeProperty("--accent-hover");
    }
  }, [ready, s.accent]);

  // Font size: rem units follow the root size.
  useEffect(() => {
    if (ready) document.documentElement.style.fontSize = FONT_SIZE[s.fontSize];
  }, [ready, s.fontSize]);

  // App scaling.
  useEffect(() => {
    if (ready) applyZoom(s.uiScale).catch((e) => console.error("Could not set zoom:", e));
  }, [ready, s.uiScale]);

  // Launch at login.
  useEffect(() => {
    if (!ready || !isTauri()) return;
    setAutostart(s.launchAtLogin)
      .then(() => setError("autostart", undefined))
      .catch((e) => setError("autostart", errorMessage(e)));
  }, [ready, s.launchAtLogin, setError]);

  // Global shortcut: show or hide the window from anywhere.
  useEffect(() => {
    if (!ready || !isTauri() || !s.toggleShortcut) {
      setError("shortcut", undefined);
      return;
    }
    let cancelled = false;
    let unregister: (() => Promise<void>) | undefined;
    registerToggleShortcut(s.toggleShortcut, () => void toggleMainWindow())
      .then((off) => {
        if (cancelled) void off();
        else {
          unregister = off;
          setError("shortcut", undefined);
        }
      })
      .catch((e) => setError("shortcut", errorMessage(e)));
    return () => {
      cancelled = true;
      void unregister?.();
    };
  }, [ready, s.toggleShortcut, setError]);

  // Notifications: ask for permission when the user turns them on.
  useEffect(() => {
    if (!ready || !isTauri() || !s.notifications) {
      setError("notifications", undefined);
      return;
    }
    ensureNotificationPermission()
      .then((ok) => setError("notifications", ok ? undefined : "Notifications are blocked in your system settings."))
      .catch((e) => setError("notifications", errorMessage(e)));
  }, [ready, s.notifications, setError]);

  // Close to tray: hide instead of quitting.
  useEffect(() => {
    if (!ready || !isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (s.closeToTray) {
          event.preventDefault();
          void hideMainWindow();
        }
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [ready, s.closeToTray]);

  // Start minimized: the window is created hidden (tauri.conf.json "visible": false)
  // and shown here once settings are loaded, which avoids a flash on startup.
  useEffect(() => {
    if (!ready || !isTauri() || s.startMinimized) return;
    void showMainWindow();
    // Only on first ready: later changes to startMinimized affect the next launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return { errors };
}
