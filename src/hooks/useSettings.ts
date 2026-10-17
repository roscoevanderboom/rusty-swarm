import { isTauri } from "@tauri-apps/api/core";
import { info } from "@tauri-apps/plugin-log";
import { load } from "@tauri-apps/plugin-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAppearanceMode } from "../lib/theme";
import { DEFAULT_SETTINGS, type SetSetting, type SettingKey, type Settings } from"../types/schema";

const STORE_FILE = "settings.json";
const LOCAL_KEY = "rusty-swarm.settings";
const LEGACY_LOCAL_KEY = "rusty-hermes.settings";
const KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** Where settings live. Tauri store in the app, localStorage when running `vite` in a browser. */
interface Backend {
  read(): Promise<Partial<Settings>>;
  write(key: SettingKey, value: unknown): Promise<void>;
  /** Fires when a key changes from outside the UI (e.g. the REST API in Rust). */
  watch(cb: (key: SettingKey, value: unknown) => void): Promise<() => void>;
}

async function openTauriBackend(): Promise<Backend> {
  const store = await load(STORE_FILE, { defaults: {}, autoSave: true });
  return {
    async read() {
      const out: Record<string, unknown> = {};
      for (const key of KEYS) {
        const value = await store.get<unknown>(key);
        if (value !== undefined && value !== null) out[key] = value;
      }
      return out as Partial<Settings>;
    },
    write: (key, value) => store.set(key, value),
    async watch(cb) {
      const offs = await Promise.all(
        KEYS.map((key) => store.onKeyChange<unknown>(key, (value) => cb(key, value))),
      );
      return () => offs.forEach((off) => off());
    },
  };
}

function openLocalBackend(): Backend {
  const readAll = (): Record<string, unknown> => {
    try {
      const saved = localStorage.getItem(LOCAL_KEY);
      if (saved !== null) return JSON.parse(saved);
      const legacy = localStorage.getItem(LEGACY_LOCAL_KEY);
      if (legacy === null) return {};
      localStorage.setItem(LOCAL_KEY, legacy);
      return JSON.parse(legacy);
    } catch {
      return {};
    }
  };
  return {
    read: async () => readAll() as Partial<Settings>,
    write: async (key, value) => {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...readAll(), [key]: value }));
    },
    watch: async () => () => {},
  };
}

/**
 * The theme is also cached in localStorage by theme.ts, so we start from that
 * value instead of the default. That avoids a light/dark flash before the store loads.
 */
function withDefaults(saved: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    themeMode: getAppearanceMode(),
    ...saved,
    apiPermissions: { ...DEFAULT_SETTINGS.apiPermissions, ...saved.apiPermissions },
  };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => withDefaults({}));
  const [ready, setReady] = useState(false);
  const backend = useRef<Backend | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unwatch: (() => void) | undefined;

    (async () => {
      const b = isTauri() ? await openTauriBackend() : openLocalBackend();
      backend.current = b;
      const saved = await b.read();
      if (cancelled) return;
      setSettings(withDefaults(saved));
      setReady(true);

      const off = await b.watch((key, value) =>
        setSettings((s) => ({ ...s, [key]: value ?? DEFAULT_SETTINGS[key] }) as Settings),
      );
      if (cancelled) off();
      else unwatch = off;
    })().catch((error) => {
      console.error("Could not load settings, using defaults:", error);
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, []);

  const setSetting = useCallback<SetSetting>((key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    void backend.current?.write(key, value).catch((error) => {
      console.error(`Could not save "${key}":`, error);
    });
    // Log the key only, never the value (it could be the API key).
    if (isTauri()) void info(`Setting changed: ${key}`).catch(() => {});
  }, []);

  const resetSettings = useCallback(() => {
    const defaults = withDefaults({});
    defaults.themeMode = DEFAULT_SETTINGS.themeMode;
    setSettings(defaults);
    for (const key of KEYS) {
      void backend.current?.write(key, defaults[key]).catch(() => {});
    }
  }, []);

  /**
   * Applies a partial settings object (from an imported backup). Returns how
   * many keys were written. Writes go through the same backend as setSetting,
   * so the effects in useSettingsEffects pick them up.
   */
  const applySettings = useCallback((partial: Partial<Settings>): number => {
    const keys = KEYS.filter((key) => partial[key] !== undefined);
    if (keys.length === 0) return 0;
    setSettings((s) => ({ ...s, ...partial }));
    for (const key of keys) {
      void backend.current?.write(key, partial[key]).catch((error) => {
        console.error(`Could not restore "${key}":`, error);
      });
    }
    if (isTauri()) void info(`Settings imported: ${keys.length} keys`).catch(() => {});
    return keys.length;
  }, []);

  return { settings, setSetting, applySettings, resetSettings, ready };
}
