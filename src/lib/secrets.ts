/**
 * API key storage via the OS credential store (Windows Credential Manager,
 * macOS Keychain, Linux Secret Service).
 *
 * Backed by the `keyring` Rust crate (v2) via two Tauri commands.
 * All operations are no-ops when running outside Tauri (vite dev).
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

/** Read the API key from the OS credential store. Returns "" if none is set. */
export async function vaultGetApiKey(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("get_api_key");
}

/** Write or clear the API key in the OS credential store. Pass "" to delete it. */
export async function vaultSetApiKey(key: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_api_key", { key });
}
