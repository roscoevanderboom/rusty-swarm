import { isTauri } from "@tauri-apps/api/core";
import { attachLogger, LogLevel as PluginLevel } from "@tauri-apps/plugin-log";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "../types/schema";

const MAX_ENTRIES = 1000;

const LEVELS: Record<number, LogLevel> = {
  [PluginLevel.Trace]: "trace",
  [PluginLevel.Debug]: "debug",
  [PluginLevel.Info]: "info",
  [PluginLevel.Warn]: "warn",
  [PluginLevel.Error]: "error",
};

/**
 * Collects log lines from the Rust `log` plugin (needs TargetKind::Webview).
 * Mount at the top of the app so lines from before the modal opened are kept.
 */
export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    attachLogger(({ level, message }) => {
      const entry: LogEntry = {
        id: nextId.current++,
        ts: Date.now(),
        level: LEVELS[level] ?? "info",
        message,
      };
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);
  return { logs, clearLogs };
}
