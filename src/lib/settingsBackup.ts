/**
 * Serialising and validating a settings backup file.
 *
 * The file is a small envelope (`{ app, version, settings }`) so an import can
 * refuse a file this app did not write, and so future versions can migrate
 * instead of guessing.
 */
import {
  DEFAULT_SETTINGS,
  type SettingKey,
  type Settings,
} from "../types/schema";

export const SETTINGS_FILE_VERSION = 1;
export const SETTINGS_FILE_NAME = "rusty-hermes-settings.json";

export interface SettingsFile {
  app: string;
  version: number;
  settings: Partial<Settings>;
}

export interface ImportResult {
  settings: Partial<Settings>;
  /** Keys found in the file but dropped, with the reason. */
  ignored: [string, string][];
}

const KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

const ALLOWED: Partial<Record<SettingKey, readonly string[]>> = {
  themeMode: ["light", "dark", "system"],
  fontSize: ["small", "default", "large"],
  apiHost: ["127.0.0.1", "0.0.0.0"],
  logLevel: ["error", "warn", "info", "debug", "trace"],
};

const LIMITS: Partial<Record<SettingKey, [number, number]>> = {
  uiScale: [80, 150],
  apiPort: [1, 65535],
};

export function serializeSettings(settings: Settings): string {
  const file: SettingsFile = {
    app: "rusty-hermes",
    version: SETTINGS_FILE_VERSION,
    settings,
  };
  return JSON.stringify(file, null, 2) + "\n";
}

function isValid(key: SettingKey, value: unknown): string | null {
  if (key === "apiPermissions") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return "not an object";
    const flags = value as Record<string, unknown>;
    for (const flag of Object.keys(DEFAULT_SETTINGS.apiPermissions)) {
      if (flag in flags && typeof flags[flag] !== "boolean")
        return `"${flag}" is not a boolean`;
    }
    return null;
  }
  if (typeof value !== typeof DEFAULT_SETTINGS[key]) {
    return `expected ${typeof DEFAULT_SETTINGS[key]}`;
  }
  if (key === "uiScale" || key === "apiPort") {
    const [min, max] = LIMITS[key]!;
    if (!Number.isFinite(value) || (value as number) < min || (value as number) > max)
      return `must be ${min}-${max}`;
  }
  if (key in ALLOWED && !ALLOWED[key]!.includes(value as string))
    return `unknown value "${String(value)}"`;
  return null;
}

/**
 * Reads a backup file. Unknown keys, wrong types and out-of-range values are
 * dropped and reported instead of applied, so one bad field cannot break the app.
 */
export function parseSettingsFile(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a JSON file.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Not a rusty-hermes settings file.");

  const root = raw as Record<string, unknown>;
  if (root.app !== "rusty-hermes")
    throw new Error("Not a rusty-hermes settings file.");

  const body = root.settings;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("The file has no settings in it.");

  const settings: Partial<Settings> = {};
  const ignored: [string, string][] = [];
  const source = body as Record<string, unknown>;

  for (const key of KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === undefined || value === null) continue;
    const reason = isValid(key, value);
    if (reason) ignored.push([key, reason]);
    else (settings as Record<string, unknown>)[key] = value;
  }

  for (const key of Object.keys(source)) {
    if (!KEYS.includes(key as SettingKey)) ignored.push([key, "unknown setting"]);
  }

  return { settings, ignored };
}
