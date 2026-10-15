import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "../css/settings.css";
import {
  ApiHost,
  ApiPermissions,
  FontSize,
  LogEntry,
  LogLevel,
  SetSetting,
  Settings,
} from "../types/schema";
import { ServerStatus } from "../hooks/useApiServer";
import { EffectErrors } from "../hooks/useSettingsEffects";
import {
  copyText,
  errorMessage,
  getAppDataDir,
  getAppInfo,
  getLocalIp,
  openAppDataDir,
  openLogFolder,
  pickFolder,
  pickSettingsFile,
  saveSettingsFile,
  sendTestNotification,
} from "../lib/native";
import {
  parseSettingsFile,
  serializeSettings,
  SETTINGS_FILE_NAME,
} from "../lib/settingsBackup";
import { vaultGetApiKey, vaultSetApiKey } from "../lib/secrets";
import { AppearanceMode } from "../lib/theme";

const APP_NAME = "rusty-hermes";

export interface SettingsModalProps {
  onClose: () => void;
  settings: Settings;
  setSetting: SetSetting;
  applySettings: (partial: Partial<Settings>) => number;
  resetSettings: () => void;
  logs: LogEntry[];
  clearLogs: () => void;
  server: ServerStatus;
  effectErrors: EffectErrors;
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

function Icon({ paths }: { paths: string[] }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="st-group">
      {title && <h3 className="st-group-title">{title}</h3>}
      <div className="st-card">{children}</div>
    </section>
  );
}

function Row({
  title,
  description,
  error,
  stack,
  children,
}: {
  title: string;
  description?: ReactNode;
  error?: string;
  stack?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`st-row${stack ? " st-row--stack" : ""}`}>
      <div className="st-row-text">
        <div className="st-row-title">{title}</div>
        {description && <div className="st-row-desc">{description}</div>}
        {error && (
          <div className="st-row-error" role="alert">
            {error}
          </div>
        )}
      </div>
      {children && <div className="st-row-control">{children}</div>}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="st-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

function ToggleRow({
  title,
  description,
  error,
  value,
  onChange,
  disabled,
}: {
  title: string;
  description?: ReactNode;
  error?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row title={title} description={description} error={error}>
      <Switch
        checked={value}
        onChange={onChange}
        label={title}
        disabled={disabled}
      />
    </Row>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CopyButton(
  { text, label = "Copy" }: { text: string; label?: string },
) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="st-btn"
      onClick={() =>
        copyText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch((e) => console.error("Could not copy:", e))}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Two-step button for destructive actions: click once to arm, again to confirm. */
function ConfirmButton(
  { label, onConfirm }: { label: string; onConfirm: () => void },
) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className="st-btn st-btn--danger"
      data-armed={armed}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? "Click again to confirm" : label}
    </button>
  );
}

/* ---------- Shortcut recorder ---------- */

const IS_MAC = typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform);

function keyFromCode(code: string): string | null {
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return null;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  return code || null;
}

function formatShortcut(accelerator: string) {
  if (!accelerator) return "Not set";
  return accelerator.replace("CommandOrControl", IS_MAC ? "Cmd" : "Ctrl").split(
    "+",
  ).join(" + ");
}

function ShortcutRecorder(
  { value, onChange }: { value: string; onChange: (value: string) => void },
) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // keeps Escape from closing the modal while recording
      if (e.key === "Escape") return setRecording(false);
      const key = keyFromCode(e.code);
      const modifiers = [
        (e.ctrlKey || e.metaKey) && "CommandOrControl",
        e.altKey && "Alt",
        e.shiftKey && "Shift",
      ].filter(
        Boolean,
      ) as string[];
      if (!key || modifiers.length === 0) return; // wait for a modifier plus a key
      onChange([...modifiers, key].join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <>
      <button
        type="button"
        className="st-btn st-keys"
        data-recording={recording}
        onClick={() => setRecording((r) => !r)}
      >
        {recording ? "Press keys... (Esc to cancel)" : formatShortcut(value)}
      </button>
      {value && !recording && (
        <button
          type="button"
          className="st-btn"
          onClick={() => onChange("")}
        >
          Clear
        </button>
      )}
    </>
  );
}


/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

type PanelProps = Pick<SettingsModalProps, "settings" | "setSetting">;

const THEME_MODES: { id: AppearanceMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

const FONT_SIZES: { id: FontSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
];

const ACCENTS = [
  { label: "Theme default", value: "", preview: "#6366f1" },
  { label: "Violet", value: "#a855f7", preview: "#a855f7" },
  { label: "Rose", value: "#f43f5e", preview: "#f43f5e" },
  { label: "Amber", value: "#f59e0b", preview: "#f59e0b" },
  { label: "Emerald", value: "#10b981", preview: "#10b981" },
  { label: "Sky", value: "#0ea5e9", preview: "#0ea5e9" },
];

const SCALES = [80, 90, 100, 110, 125, 150];

function AppearancePanel({ settings, setSetting }: PanelProps) {
  return (
    <>
      <Group title="Theme">
        <Row title="Mode" description="System follows your operating system.">
          <Segmented
            label="Theme mode"
            options={THEME_MODES}
            value={settings.themeMode}
            onChange={(v) => setSetting("themeMode", v)}
          />
        </Row>
        <Row
          title="Accent color"
          description="Used for buttons, switches and focus rings."
        >
          <div
            className="st-swatches"
            role="radiogroup"
            aria-label="Accent color"
          >
            {ACCENTS.map((a) => (
              <button
                key={a.label}
                type="button"
                role="radio"
                aria-checked={settings.accent === a.value}
                aria-label={a.label}
                title={a.label}
                className="st-swatch"
                style={{
                  background: a.preview,
                  "--swatch": a.preview,
                } as CSSProperties}
                onClick={() => setSetting("accent", a.value)}
              />
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Size">
        <Row
          title="Font size"
          description="Changes text size throughout the app."
        >
          <Segmented
            label="Font size"
            options={FONT_SIZES}
            value={settings.fontSize}
            onChange={(v) => setSetting("fontSize", v)}
          />
        </Row>
        <Row
          title="App scaling"
          description="Zooms the whole window, including spacing and icons."
        >
          <select
            className="st-select st-w-sm"
            aria-label="App scaling"
            value={settings.uiScale}
            onChange={(e) => setSetting("uiScale", Number(e.target.value))}
          >
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {s}%
              </option>
            ))}
          </select>
        </Row>
      </Group>
    </>
  );
}

function GeneralPanel({
  settings,
  setSetting,
  errors,
}: PanelProps & { errors: EffectErrors }) {
  const [testError, setTestError] = useState<string>();

  return (
    <>
      <Group title="Startup">
        <ToggleRow
          title="Launch at login"
          description="Start automatically when you sign in."
          error={errors.autostart}
          value={settings.launchAtLogin}
          onChange={(v) => setSetting("launchAtLogin", v)}
        />
        <ToggleRow
          title="Start minimized"
          description="Open without showing the window. Takes effect on the next launch."
          value={settings.startMinimized}
          onChange={(v) => setSetting("startMinimized", v)}
        />
      </Group>

      <Group title="Window">
        <ToggleRow
          title="Close to tray"
          description="Closing the window hides it instead of quitting. Bring it back with the shortcut below or the tray icon."
          value={settings.closeToTray}
          onChange={(v) => setSetting("closeToTray", v)}
        />
        <Row
          title="Show or hide shortcut"
          description="Works from anywhere, even when the app isn't focused."
          error={errors.shortcut}
        >
          <ShortcutRecorder
            value={settings.toggleShortcut}
            onChange={(v) => setSetting("toggleShortcut", v)}
          />
        </Row>
      </Group>

      <Group title="Notifications">
        <ToggleRow
          title="Show notifications"
          description="Send system notifications for app events."
          error={errors.notifications}
          value={settings.notifications}
          onChange={(v) => setSetting("notifications", v)}
        />
        <Row
          title="Test notification"
          description="Check that notifications reach your desktop."
          error={testError}
        >
          <button
            type="button"
            className="st-btn"
            disabled={!settings.notifications}
            onClick={() => {
              setTestError(undefined);
              sendTestNotification().catch((e) =>
                setTestError(errorMessage(e))
              );
            }}
          >
            Send
          </button>
        </Row>
      </Group>
    </>
  );
}

const API_ACTIONS: {
  key: keyof ApiPermissions;
  title: string;
  description: string;
}[] = [
  {
    key: "themeMode",
    title: "Change theme mode",
    description: "Switch between light, dark and system.",
  },
  {
    key: "accent",
    title: "Change accent color",
    description: "Set or reset the accent color.",
  },
  {
    key: "uiScale",
    title: "Change app scaling",
    description: "Set the interface zoom level.",
  },
  {
    key: "windowVisibility",
    title: "Show and hide the window",
    description: "Bring the window forward or hide it.",
  },
  {
    key: "readMetrics",
    title: "Read system metrics",
    description: "Stream CPU, memory, disk and network data over WebSocket.",
  },
];

const STATUS_LABEL: Record<ServerStatus["state"], string> = {
  stopped: "Stopped",
  starting: "Starting...",
  running: "Running",
  error: "Error",
};

function ServerPanel(
  { settings, setSetting, server }: PanelProps & { server: ServerStatus },
) {
  const host = settings.apiHost === "0.0.0.0" ? "localhost" : settings.apiHost;
  const baseUrl = `http://${host}:${settings.apiPort}`;
  // When bound to 0.0.0.0, fetch the machine's LAN IP so the copied Files URL
  // works from other devices on the network.
  const [localIp, setLocalIp] = useState<string>("0.0.0.0");
  useEffect(() => {
    if (settings.apiHost === "0.0.0.0") {
      getLocalIp().then(setLocalIp).catch(() => {});
    }
  }, [settings.apiHost]);
  const filesHost = settings.apiHost === "0.0.0.0" ? localIp : settings.apiHost;
  const filesBaseUrl = `http://${filesHost}:${settings.apiPort}`;

  // API key lives in the Stronghold vault, not in settings.json.
  const [apiKey, setApiKeyState] = useState("");
  const [keyLoading, setKeyLoading] = useState(true);

  useEffect(() => {
    setKeyLoading(true);
    vaultGetApiKey()
      .then((k) => setApiKeyState(k))
      .finally(() => setKeyLoading(false));
  }, []);

  const saveApiKey = useCallback(async (newKey: string) => {
    await vaultSetApiKey(newKey);
    setApiKeyState(newKey);
    // Restart the server so it picks up the new key immediately.
    if (settings.apiEnabled) {
      setSetting("apiPort", settings.apiPort); // nudge the useApiServer dep
    }
  }, [settings.apiEnabled, settings.apiPort, setSetting]);

  const curl = [
    `curl -X PATCH ${baseUrl}/v1/settings \\`,
    ...(apiKey
      ? [`  -H "Authorization: Bearer ${apiKey}" \\`]
      : []),
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"themeMode": "dark"}'`,
  ].join("\n");

  const setPermission = (key: keyof ApiPermissions, value: boolean) =>
    setSetting("apiPermissions", { ...settings.apiPermissions, [key]: value });

  const serverRunning = server.state === "running";

  const choose = useCallback(async () => {
    const dir = await pickFolder(settings.fileHostingDir || undefined);
    if (dir) setSetting("fileHostingDir", dir);
  }, [settings.fileHostingDir, setSetting]);

  return (
    <>
      {settings.apiHost === "0.0.0.0" && !apiKey && (
        <div className="st-note" role="alert">
          Anyone on your network can reach this API. Generate an API key before
          using the local network option.
        </div>
      )}

      <Group title="REST API">
        <Row
          title="Enable REST API"
          description={
            <span className="st-status">
              <span className="st-dot" data-state={server.state} />
              {STATUS_LABEL[server.state]}
              {server.state === "running" && ` at ${baseUrl}`}
            </span>
          }
          error={server.state === "error" ? server.error : undefined}
        >
          {server.state === "running" && (
            <CopyButton text={baseUrl} label="Copy URL" />
          )}
          <Switch
            checked={settings.apiEnabled}
            onChange={(v) => setSetting("apiEnabled", v)}
            label="Enable REST API"
          />
        </Row>
        <Row title="Host" description="Who can connect.">
          <select
            className="st-select st-w-lg"
            aria-label="Host"
            value={settings.apiHost}
            onChange={(e) => setSetting("apiHost", e.target.value as ApiHost)}
          >
            <option value="127.0.0.1">This computer only (127.0.0.1)</option>
            <option value="0.0.0.0">Local network (0.0.0.0)</option>
          </select>
        </Row>
        <Row title="Port">
          <input
            className="st-input st-input--mono st-w-sm"
            aria-label="Port"
            inputMode="numeric"
            value={settings.apiPort || ""}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ""));
              if (n <= 65535) setSetting("apiPort", n);
            }}
          />
        </Row>
        <Row
          title="API key"
          description="Stored securely in the app vault. Leave empty to allow any local request."
          stack
        >
          <input
            className="st-input st-input--mono"
            aria-label="API key"
            placeholder={keyLoading ? "Loading…" : "No key set"}
            spellCheck={false}
            disabled={keyLoading}
            value={apiKey}
            onChange={(e) => void saveApiKey(e.target.value)}
          />
          <button
            type="button"
            className="st-btn"
            disabled={keyLoading}
            onClick={() => {
              const bytes = new Uint8Array(24);
              crypto.getRandomValues(bytes);
              const newKey = "hk_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
              void saveApiKey(newKey);
            }}
          >
            Generate
          </button>
          {apiKey && <CopyButton text={apiKey} />}
          {apiKey && (
            <button
              type="button"
              className="st-btn st-btn--danger"
              onClick={() => void saveApiKey("")}
            >
              Clear
            </button>
          )}
        </Row>
      </Group>

      <Group title="Allowed actions">
        {API_ACTIONS.map((a) => (
          <ToggleRow
            key={a.key}
            title={a.title}
            description={a.description}
            value={settings.apiPermissions[a.key]}
            onChange={(v) => setPermission(a.key, v)}
          />
        ))}
      </Group>

      <Group title="File hosting">
        {!serverRunning && (
          <div className="st-note" role="note">
            File hosting requires the REST API to be running.
          </div>
        )}
        <ToggleRow
          title="Host files"
          description="Serve a folder over the REST API."
          value={settings.fileHostingEnabled}
          onChange={(v) => setSetting("fileHostingEnabled", v)}
          disabled={!serverRunning}
        />
        <Row title="Folder" stack>
          <input
            className="st-input"
            aria-label="Hosted folder"
            placeholder="No folder selected"
            readOnly
            value={settings.fileHostingDir}
            style={{ opacity: serverRunning ? 1 : 0.45 }}
          />
          <button
            type="button"
            className="st-btn"
            disabled={!serverRunning}
            onClick={() => void choose()}
          >
            Choose folder
          </button>
        </Row>
        <ToggleRow
          title="Read-only"
          description="Clients can download files but can't upload or delete them."
          value={settings.fileHostingReadOnly}
          onChange={(v) => setSetting("fileHostingReadOnly", v)}
          disabled={!serverRunning || !settings.fileHostingEnabled}
        />
        {serverRunning && settings.fileHostingEnabled && settings.fileHostingDir && (
          <Row title="Files URL" description="Opens a styled file browser in any browser. Token included.">
            <CopyButton
              text={`${filesBaseUrl}/files${apiKey ? `?token=${apiKey}` : ""}`}
              label="Copy URL"
            />
          </Row>
        )}
      </Group>

      <Group title="Try it">
        <Row
          title="Example request"
          description="Changes the theme from a terminal."
          stack
        >
          <pre className="st-code">{curl}</pre>
          <CopyButton text={curl} />
        </Row>
      </Group>
    </>
  );
}

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};
const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"];

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false });

function LogsPanel({
  settings,
  setSetting,
  logs,
  clearLogs,
}: PanelProps & Pick<SettingsModalProps, "logs" | "clearLogs">) {
  const [query, setQuery] = useState("");
  const [folderError, setFolderError] = useState<string>();
  const viewRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const q = query.trim().toLowerCase();
  const visible = logs.filter(
    (l) =>
      LEVEL_RANK[l.level] <= LEVEL_RANK[settings.logLevel] &&
      (!q || l.message.toLowerCase().includes(q)),
  );

  useEffect(() => {
    const el = viewRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const asText = () =>
    visible.map((l) =>
      `${formatTime(l.ts)} ${l.level.toUpperCase().padEnd(5)} ${l.message}`
    ).join("\n");

  return (
    <>
      <div className="st-toolbar">
        <select
          className="st-select st-w-sm"
          aria-label="Minimum log level"
          value={settings.logLevel}
          onChange={(e) => setSetting("logLevel", e.target.value as LogLevel)}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input
          className="st-input st-w-md"
          type="search"
          aria-label="Search logs"
          placeholder="Search logs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="st-spacer" />
        <CopyButton text={asText()} label="Copy" />
        <button
          type="button"
          className="st-btn"
          onClick={() =>
            openLogFolder().catch((e) => setFolderError(errorMessage(e)))}
        >
          Open folder
        </button>
        <button type="button" className="st-btn" onClick={clearLogs}>
          Clear
        </button>
      </div>
      {folderError && (
        <div className="st-row-error" role="alert" style={{ marginBottom: 8 }}>
          {folderError}
        </div>
      )}

      <div
        ref={viewRef}
        className="st-log"
        role="log"
        aria-label="Backend logs"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {visible.length === 0
          ? (
            <span className="st-log-empty">
              {logs.length === 0
                ? "Backend logs appear here in the desktop app."
                : "No lines match this filter."}
            </span>
          )
          : (
            visible.map((l) => (
              <div key={l.id} className="st-log-line">
                <span className="st-log-time">{formatTime(l.ts)}</span>
                <span className={`st-lv-${l.level}`}>
                  {l.level.toUpperCase()}
                </span>
                <span className="st-log-msg">{l.message}</span>
              </div>
            ))
          )}
      </div>
    </>
  );
}

function StoragePanel() {
  const [dataDir, setDataDir] = useState<string>();
  const [dirError, setDirError] = useState<string>();

  useEffect(() => {
    getAppDataDir().then(setDataDir).catch((e) => setDirError(errorMessage(e)));
  }, []);

  return (
    <Group title="App data">
      <Row
        title="Data directory"
        description="Where settings, logs and other app data are stored."
        error={dirError}
        stack
      >
        <input
          className="st-input st-input--mono"
          aria-label="App data directory"
          readOnly
          value={dataDir ?? "Loading..."}
        />
        <button
          type="button"
          className="st-btn"
          disabled={!dataDir}
          onClick={() => void openAppDataDir().catch((e) => setDirError(errorMessage(e)))}
        >
          Open folder
        </button>
      </Row>
    </Group>
  );
}

function AboutPanel({
  settings,
  applySettings,
  resetSettings,
}: {
  settings: Settings;
  applySettings: (partial: Partial<Settings>) => number;
  resetSettings: () => void;
}) {
  const [info, setInfo] = useState<{ version: string; tauri: string }>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAppInfo().then(setInfo).catch(() => {});
  }, []);

  const onExport = async () => {
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    try {
      const saved = await saveSettingsFile(
        SETTINGS_FILE_NAME,
        serializeSettings(settings),
      );
      if (saved) setMessage("Settings exported.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    try {
      const text = await pickSettingsFile();
      if (text === null) return; // dialog cancelled
      const { settings: imported, ignored } = parseSettingsFile(text);
      const applied = applySettings(imported);
      const skipped = ignored.length ? ` ${ignored.length} unknown value(s) skipped.` : "";
      setMessage(
        applied === 0 && ignored.length > 0
          ? `Nothing to import.${skipped}`
          : `Imported ${applied} setting${applied === 1 ? "" : "s"}.${skipped}`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group>
        <Row title="Version">
          <span>{info?.version ?? "..."}</span>
        </Row>
        <Row title="Tauri">
          <span>{info?.tauri ?? "..."}</span>
        </Row>
      </Group>
      <Group title="Backup">
        <Row
          title="Export settings"
          description="Saves every setting to a JSON file. The API key is included — keep the file private."
        >
          <button
            type="button"
            className="st-btn"
            disabled={busy}
            onClick={() => void onExport()}
          >
            Export…
          </button>
        </Row>
        <Row
          title="Import settings"
          description="Replaces your current settings with the ones in the file."
          error={error}
        >
          <button
            type="button"
            className="st-btn"
            disabled={busy}
            onClick={() => void onImport()}
          >
            Import…
          </button>
        </Row>
        {message && (
          <div className="st-row">
            <span className="st-row-desc" role="status">
              {message}
            </span>
          </div>
        )}
      </Group>
      <Group title="Reset">
        <Row
          title="Reset all settings"
          description="Restores every setting to its default. Your data files are not touched."
        >
          <ConfirmButton label="Reset" onConfirm={resetSettings} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

type TabId = "appearance" | "general" | "server" | "logs" | "storage" | "about";

const TABS: {
  id: TabId;
  label: string;
  description: string;
  icon: string[];
}[] = [
  {
    id: "appearance",
    label: "Appearance",
    description: `Choose how ${APP_NAME} looks.`,
    icon: [
      "M12 3a9 9 0 000 18h1a2 2 0 002-2c0-1-1-1.5-1-2.5 0-1 .8-1.5 2-1.5h2a2 2 0 002-2 9 9 0 00-8-10z",
      "M8 9.5h.01",
      "M12.5 7.5h.01",
      "M8.5 14.5h.01",
    ],
  },
  {
    id: "general",
    label: "General",
    description:
      `Control how ${APP_NAME} starts, closes and stays out of your way.`,
    icon: ["M4 6h16", "M4 12h16", "M4 18h16", "M9 4v4", "M15 10v4", "M8 16v4"],
  },
  {
    id: "server",
    label: "Server",
    description:
      `Control the local REST API and file hosting. File hosting requires the server to be running.`,
    icon: ["M3 5h18v6H3z", "M3 13h18v6H3z", "M7 8h.01", "M7 16h.01"],
  },
  {
    id: "logs",
    label: "Logs",
    description: "Live output from the backend.",
    icon: ["M4 5l4 4-4 4", "M12 19h8"],
  },
  {
    id: "storage",
    label: "Storage",
    description: "App data location on this machine.",
    icon: [
      "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
    ],
  },
  {
    id: "about",
    label: "About",
    description: `${APP_NAME} — a Tauri v2 app template.`,
    icon: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 11v5", "M12 8h.01"],
  },
];

export function SettingsModal(props: SettingsModalProps) {
  const { onClose, settings, setSetting } = props;
  const [tab, setTab] = useState<TabId>("appearance");
  const dialogRef = useRef<HTMLDivElement>(null);
  const active = TABS.find((t) => t.id === tab)!;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="st-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="st-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <nav
          className="st-sidebar"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
        >
          <div className="st-sidebar-title">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`st-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="st-panel"
              className="st-nav"
              onClick={() => setTab(t.id)}
            >
              <Icon paths={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="st-main">
          <header className="st-head">
            <div>
              <h2 className="st-title">{active.label}</h2>
              <div className="st-subtitle">{active.description}</div>
            </div>
            <button
              type="button"
              className="st-close"
              onClick={onClose}
              aria-label="Close settings"
            >
              <Icon paths={["M6 6l12 12", "M18 6L6 18"]} />
            </button>
          </header>

          <div
            className={`st-body${tab === "logs" ? " st-body--logs" : ""}`}
            id="st-panel"
            role="tabpanel"
            aria-labelledby={`st-tab-${tab}`}
          >
            {tab === "appearance" && (
              <AppearancePanel settings={settings} setSetting={setSetting} />
            )}
            {tab === "general" && (
              <GeneralPanel
                settings={settings}
                setSetting={setSetting}
                errors={props.effectErrors}
              />
            )}
            {tab === "server" && (
              <ServerPanel
                settings={settings}
                setSetting={setSetting}
                server={props.server}
              />
            )}
            {tab === "logs" && (
              <LogsPanel
                settings={settings}
                setSetting={setSetting}
                logs={props.logs}
                clearLogs={props.clearLogs}
              />
            )}
            {tab === "storage" && <StoragePanel />}
            {tab === "about" && (
              <AboutPanel
                settings={props.settings}
                applySettings={props.applySettings}
                resetSettings={props.resetSettings}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
