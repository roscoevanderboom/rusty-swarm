/**
 * Every Tauri plugin call lives here. The rest of the UI never imports a
 * plugin directly, so the app still runs in a plain browser (`vite dev`)
 * and each call is easy to find when you check capabilities.
 */
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { appDataDir, appLogDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath } from "@tauri-apps/plugin-opener";

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* Window */

export async function showMainWindow() {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  await win.show();
  await win.unminimize();
  await win.setFocus();
}

export async function hideMainWindow() {
  if (isTauri()) await getCurrentWindow().hide();
}

export async function toggleMainWindow() {
  if (!isTauri()) return;
  if (await getCurrentWindow().isVisible()) await hideMainWindow();
  else await showMainWindow();
}

/* Scaling: webview zoom in the app, CSS zoom in a browser. */

export async function applyZoom(percent: number) {
  const factor = percent / 100;
  if (isTauri()) await getCurrentWebview().setZoom(factor);
  else document.documentElement.style.setProperty("zoom", String(factor));
}

/* Launch at login */

export async function setAutostart(on: boolean) {
  if (!isTauri()) return;
  const current = await isEnabled();
  if (on && !current) await enable();
  if (!on && current) await disable();
}

/* Global shortcut. Returns a function that unregisters it. */

export async function registerToggleShortcut(accelerator: string, onTrigger: () => void) {
  await register(accelerator, (event) => {
    if (event.state === "Pressed") onTrigger();
  });
  return () => unregister(accelerator);
}

/* Notifications */

export async function ensureNotificationPermission() {
  if (await isPermissionGranted()) return true;
  const result = await requestPermission();
  return result === "granted";
}

export async function sendTestNotification() {
  if (!isTauri()) return;
  await invoke<void>("send_notification", {
    title: "rusty-hermes",
    body: "Notifications are working.",
  });
}

/* Files and clipboard */

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const picked = await open({ directory: true, multiple: false, defaultPath });
  return typeof picked === "string" ? picked : null;
}

export async function copyText(text: string) {
  if (isTauri()) await writeText(text);
  else await navigator.clipboard.writeText(text);
}

export async function openLogFolder() {
  if (isTauri()) await openPath(await appLogDir());
}

export async function getAppDataDir(): Promise<string> {
  if (!isTauri()) return "not available in browser";
  return appDataDir();
}

export async function openAppDataDir() {
  if (isTauri()) await openPath(await appDataDir());
}

/* Settings backup */

const JSON_FILTER = [{ name: "Settings", extensions: ["json"] }];

/**
 * Writes settings to a file the user picks. Returns false when the dialog was
 * cancelled. In a browser it falls back to a normal download.
 */
export async function saveSettingsFile(name: string, contents: string): Promise<boolean> {
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
  const path = await save({ defaultPath: name, filters: JSON_FILTER });
  if (!path) return false;
  await writeTextFile(path, contents);
  return true;
}

/** Reads a JSON settings file the user picks, or null when cancelled. */
export async function pickSettingsFile(): Promise<string | null> {
  if (!isTauri()) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        file.text().then(resolve, reject);
      };
      input.click();
    });
  }
  const path = await open({ multiple: false, filters: JSON_FILTER });
  if (typeof path !== "string") return null;
  return await readTextFile(path);
}

/* About */
export async function getAppInfo() {
  if (!isTauri()) return { version: "dev", tauri: "not running in Tauri" };
  const [version, tauri] = await Promise.all([getVersion(), getTauriVersion()]);
  return { version, tauri };
}

/** Returns the machine's primary LAN IP address, for use in copyable network URLs. */
export async function getLocalIp(): Promise<string> {
  if (!isTauri()) return "127.0.0.1";
  return invoke<string>("get_local_ip");
}

/* Platform detection
 *
 * Tauri exposes the OS via the user-agent string in its webview.
 * Returns "windows" | "macos" | "linux" | "browser".
 * This is synchronous and safe to call during render.
 */
export function getPlatform(): "windows" | "macos" | "linux" | "browser" {
  if (!isTauri()) return "browser";
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac OS") || ua.includes("Macintosh")) return "macos";
  return "linux";
}
