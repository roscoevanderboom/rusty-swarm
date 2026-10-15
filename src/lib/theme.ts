import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";

export type AppearanceMode = "light" | "dark" | "system";

const STORAGE_KEY = "rusty-hermes.appearance-mode";

export function getAppearanceMode(): AppearanceMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function applyDocumentTheme(mode: AppearanceMode): void {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
}

export function applyAppearanceMode(mode: AppearanceMode): void {
  applyDocumentTheme(mode);
  localStorage.setItem(STORAGE_KEY, mode);

  if (isTauri()) {
    void setTauriTheme(mode === "system" ? null : mode).catch((error: unknown) => {
      console.error("Could not update the native application theme:", error);
    });
  }
}
