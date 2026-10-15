import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/native";
import { vaultGetApiKey } from "../lib/secrets";
import type { Settings } from "../types/schema";

export interface ServerStatus {
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
}

/**
 * Keeps the Rust REST server in sync with settings.
 *
 * The API key is never stored in settings.json — it lives in the Stronghold
 * vault and is fetched here before each (re)start.
 */
export function useApiServer(s: Settings, ready: boolean): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>({ state: "stopped" });

  useEffect(() => {
    if (!ready) return;

    if (!s.apiEnabled) {
      if (isTauri()) void invoke("api_server_stop").catch(() => {});
      setStatus({ state: "stopped" });
      return;
    }
    if (!isTauri()) {
      setStatus({ state: "error", error: "The REST API only runs in the desktop app." });
      return;
    }

    setStatus({ state: "starting" });
    let cancelled = false;

    // Debounce so typing a port number doesn't restart the server on every digit.
    const timer = setTimeout(async () => {
      let apiKey: string;
      try {
        apiKey = await vaultGetApiKey();
      } catch {
        apiKey = "";
      }

      // Safety: refuse to bind to all interfaces without a key.
      if (s.apiHost === "0.0.0.0" && !apiKey) {
        if (!cancelled) {
          setStatus({
            state: "error",
            error: "Generate an API key before binding to 0.0.0.0 (local network).",
          });
        }
        return;
      }

      if (cancelled) return;

      invoke("api_server_start", {
        config: { host: s.apiHost, port: s.apiPort, apiKey },
      })
        .then(() => !cancelled && setStatus({ state: "running" }))
        .catch((e) => !cancelled && setStatus({ state: "error", error: errorMessage(e) }));
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready, s.apiEnabled, s.apiHost, s.apiPort]);
  //                                              ↑ no apiKey dep — key is read from vault at start time

  return status;
}
