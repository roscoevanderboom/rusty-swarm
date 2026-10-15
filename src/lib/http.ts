/**
 * Wraps the tauri-plugin-http fetch. Falls back to window.fetch in a plain
 * browser (vite dev) — the API sends CORS headers, so both paths work.
 */

import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export interface HttpResponse {
  status: number;
  body: string;
  ms: number;
}

export async function httpGet(url: string): Promise<HttpResponse> {
  const start = performance.now();
  if (!isTauri()) {
    const res = await window.fetch(url);
    return { status: res.status, body: await res.text(), ms: performance.now() - start };
  }
  const res = await tauriFetch(url, { method: "GET" });
  return { status: res.status, body: await res.text(), ms: performance.now() - start };
}
