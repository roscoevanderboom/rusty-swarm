import type { AppearanceMode } from "../lib/theme";

export type FontSize = "small" | "default" | "large";
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type ApiHost = "127.0.0.1" | "0.0.0.0";

/** What the REST API may change. Anything not listed here is not remotely controllable. */
export interface ApiPermissions {
  themeMode: boolean;
  accent: boolean;
  uiScale: boolean;
  windowVisibility: boolean;
}

/**
 * One flat schema. Every key is a key in the Tauri store (settings.json),
 * so the Rust side can read and write the same values the UI shows.
 */
export interface Settings {
  // Appearance
  themeMode: AppearanceMode;
  accent: string; // hex, or "" to follow the theme's own accent
  fontSize: FontSize;
  uiScale: number; // percent, 80-150

  // General
  launchAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  notifications: boolean;
  toggleShortcut: string; // global shortcut accelerator, "" to disable

  // Server
  apiEnabled: boolean;
  apiHost: ApiHost;
  apiPort: number;
  apiPermissions: ApiPermissions;

  // Logs (view filter only; the Rust log level is set in the backend)
  logLevel: LogLevel;

  // Storage
  fileHostingEnabled: boolean;
  fileHostingDir: string;
  fileHostingReadOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: "system",
  accent: "",
  fontSize: "default",
  uiScale: 100,

  launchAtLogin: false,
  startMinimized: false,
  // Off until the app has a tray icon: a hidden window needs a way back.
  closeToTray: false,
  notifications: true,
  toggleShortcut: "CommandOrControl+Shift+H",

  apiEnabled: false,
  apiHost: "127.0.0.1",
  apiPort: 4891,
  apiPermissions: {
    themeMode: true,
    accent: true,
    uiScale: false,
    windowVisibility: true,
  },

  logLevel: "info",

  fileHostingEnabled: false,
  fileHostingDir: "",
  fileHostingReadOnly: true,
};

export type SettingKey = keyof Settings;
export type SetSetting = <K extends SettingKey>(key: K, value: Settings[K]) => void;

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
}
