# Roadmap

rusty-hermes is a Tauri v2 desktop app template. This document tracks what has been built, what is known to be incomplete, and what is planned.

---

## Completed features & demos

### App shell
- Custom titlebar with minimize / maximize / close controls (`decorations: false`)
- Close-to-tray support: the close button hides the window when the setting is on
- Window starts hidden (`visible: false`) and is shown after settings load, to respect "Start minimized"
- Settings gear icon in the titlebar (react-icons `LuSettings`)
- Themed scrollbars (light / dark, matching `data-theme`)
- Global `--titlebar-height` CSS variable; the settings modal overlay clears the bar

### Settings modal
Full settings UI (`SettingsModal.tsx` + `settings.css`) with six tabs:

| Tab | What it does |
|---|---|
| Appearance | Theme mode (light / dark / system), accent color swatches, font size, app scaling |
| General | Launch at login, start minimized, close to tray, show/hide global shortcut recorder, notifications toggle + test |
| Server | REST API enable/disable, host, port, API key generator, allowed-actions permission matrix, file hosting (greyed out when the server is off), live curl example |
| Logs | Live backend log viewer with level filter, search, copy, open folder, clear |
| Storage | App data directory path with open-in-Explorer button |
| About | App version, Tauri version, reset all settings |

Settings are persisted to `settings.json` via `tauri-plugin-store`. The store is the single source of truth: the REST API writes to the same keys and the UI reacts via `onKeyChange` events.

### Plugins fully wired

| Plugin | Where |
|---|---|
| `tauri-plugin-store` | `useSettings.ts`: load, save, watch for external changes |
| `tauri-plugin-log` | `useLogs.ts`: `TargetKind::Webview` feeds the Logs panel |
| `tauri-plugin-autostart` | `useSettingsEffects.ts` + `native.ts`: launch at login |
| `tauri-plugin-global-shortcut` | `useSettingsEffects.ts` + `native.ts`: show/hide shortcut |
| `tauri-plugin-dialog` | `native.ts`: folder picker for file hosting |
| `tauri-plugin-clipboard-manager` | `native.ts`: copy text (API key, base URL, logs) |
| `tauri-plugin-opener` | `native.ts`: open log folder in Explorer |
| `tauri-plugin-single-instance` | `lib.rs`: second launch focuses the running window |
| `tauri-plugin-notification` | `lib.rs` + `native.ts`: permission check on toggle, `send_notification` Rust command, test button in General settings |
| `tauri-plugin-http` | `http.ts`: HTTP Client demo page |
| `tauri-plugin-sql` | `Kanban.tsx`: SQLite-backed task board |
| `tauri-plugin-fs` | `FileExplorer.tsx`: real-time directory watching |
| `tauri-plugin-shell` | `term/shell.ts`: spawn commands, stream output, kill, write to stdin, resolve `cd` |
| `tauri-plugin-cli` | `term/commands.ts`: the `cli` built-in shows the app's launch arguments |
| `tauri-plugin-process` | `term/commands.ts`: the `relaunch` and `exit` built-ins |

### REST API (Axum, port 4891)
Managed by `useApiServer.ts` on the frontend and `server.rs` on the backend.

| Route | Description |
|---|---|
| `GET /health` | Public. Returns app name and version |
| `GET /v1/settings` | Current theme, accent, font size, scale, window visibility |
| `PATCH /v1/settings` | Change `themeMode`, `accent`, `uiScale` (gated by per-permission switches) |
| `POST /v1/window/show` | Show and focus the main window |
| `POST /v1/window/hide` | Hide the main window |
| `GET /files` | List the hosted folder |
| `GET /files/<path>` | Download a file or list a subfolder |
| `PUT /files/<path>` | Upload a file (blocked when read-only) |
| `DELETE /files/<path>` | Delete a file or empty folder (blocked when read-only) |

All routes except `/health` require a Bearer token when an API key is set. File routes additionally check `fileHostingEnabled` and `fileHostingReadOnly` from the store on every request. There is no CORS layer on purpose, and JSON bodies require `Content-Type: application/json`, so other websites cannot drive the API from a browser.

### File hosting (`server/files.rs`)
Server-side routes are fully implemented:
- Path traversal protection (no `..`, no drive letters, canonical path check)
- MIME type detection via `mime_guess`
- `Content-Security-Policy: sandbox` and `nosniff` on served files
- Symlinks excluded from directory listings
- Uploads create parent folders as needed, after checking the nearest existing parent stays inside the hosted folder

### File Explorer (`FileExplorer.tsx` + `explorer.rs`)
Two-panel file browser wired to the real filesystem:
- Sidebar with resolved favorites (Home, Desktop, Downloads, Documents, Pictures, Music, Videos) via `@tauri-apps/api/path`
- Drive enumeration via `GetLogicalDriveStringsW` + real volume labels via `GetVolumeInformationW` (**Windows only**, see "Cross-platform support")
- Directory listing via the `explorer_list_dir` Tauri command (Rust, async `tokio::fs`)
- List and grid view modes, breadcrumb address bar, back/forward/up navigation
- Real-time directory watching via `tauri-plugin-fs` `watch()`: external changes (delete, create, rename) show up without a manual refresh
- Broad fs scope permissions for all user folders and drive roots (`C:\` through `F:\`)

### HTTP Client (`HttpClient.tsx` + `http.ts`)
Demo page for `tauri-plugin-http` against the D&D 5e SRD API (public, no auth, GET only):
- Resource sidebar: spells, monsters, equipment, classes, races, conditions, damage-types, magic-schools
- `?name=` search via the plugin's `fetch` (falls back to `window.fetch` in the browser)
- Collapsible JSON response tree with copy-to-clipboard
- Status bar with status code, request duration, and entry count
- Scoped in `capabilities/default.json` to `https://www.dnd5eapi.co/*`

### Kanban task board (`Kanban.tsx`)
SQLite-backed task board via `tauri-plugin-sql`:
- Four default columns (Backlog, In Progress, Review, Done), seeded on first launch
- Full CRUD: add card (modal), edit card (click to open, all fields editable including column), delete card (× on hover or from the edit modal)
- Priority levels (Low / Medium / High) with colour-coded badges
- Column dropdown in the edit modal doubles as a move-to-column action (UPDATE)
- Data persists to `kanban.db` in the app data directory across sessions
- Fluid column layout: columns share available width and shrink gracefully

### Terminal (`Terminal.tsx` + `term/`)
Real command-line page, built on `tauri-plugin-shell`:
- Output on top, input pinned to the bottom; the page fits the window (`100dvh` minus `--titlebar-height`) and only the output area scrolls
- One block per command: working directory, command, colored status edge, ✓/✕ with duration, hover Copy button
- Runs commands in PowerShell on Windows and `sh` elsewhere, streaming output line by line (batched, capped at 5000 lines per block and 200 blocks)
- Ctrl+C stops a running process; typing while one runs sends the text to its stdin
- Working directory is tracked by the terminal: `cd` is resolved through the shell, and a bare drive letter like `d:` switches drive on Windows
- Built-ins in a small registry (`commands.ts`): `help`, `clear`, `cd`, `pwd`, `echo`, `date`, `history`, `about`, `cli`, `relaunch`, `exit`
- Command history (↑/↓), Tab completion for built-ins, Ctrl+L to clear, auto-follow with a "↓ Latest" button when scrolled up
- Blank lines trimmed from output, ANSI escape codes stripped, font ligatures off so table dashes stay readable
- Follows the theme and accent color; styles are self-contained in `terminal.css`
- Shell access is granted by its own file, `capabilities/terminal.json`; deleting it removes all shell access

### Tray icon (`tray.rs`)
Left click shows the window; the menu has **Show** and **Quit**. Uses the default app icon.

---

## Known limitations

Things that work today but that anyone copying the template should know about.

- **Windows-only code paths.** Drive enumeration and volume labels use Win32 calls, and the fs scopes are hardcoded to `C:\` through `F:\`. See "Cross-platform support".
- **Broad filesystem access.** `explorer_list_dir` is a custom command, so it is not limited by the fs plugin scopes, and the scopes cover all user folders and drive roots. This suits a file browser but should be narrowed in a real app.
- **Open API by default.** With no API key set, any local process can change settings and, once read-only is off, write and delete hosted files.
- **API key stored in plain text** in `settings.json`.
- **Uploads are buffered in memory** (256 MB cap). Downloads are streamed but do not support `Range` requests.
- **Custom titlebar** (`decorations: false`) has only been checked on Windows. macOS and Linux may need native window controls, traffic lights, or resize handles.
- **Tray on Linux** needs `libayatana-appindicator` installed.
- **The Terminal can run any command.** `capabilities/terminal.json` allows arbitrary commands through the shell scope, so anything that can run script in the webview can run commands on the machine. Remove that file to remove shell access.
- **The Terminal is not a PTY.** Full-screen programs (`vim`, `htop`) and interactive prompts that need a real terminal don't work, ANSI colors are stripped, and environment changes don't persist between commands.
- **The Terminal's `cli` built-in** only shows arguments declared under `plugins.cli` in `tauri.conf.json`.

---

## To Do

Ordered by priority.

### 1. Cross-platform support ✓ (code complete, runtime verification pending)

**Done:**
- `explorer_list_drives` uses `sysinfo::Disks` on macOS/Linux for real mount points and volume names; Win32 path stays behind `#[cfg(target_os = "windows")]`
- fs scopes split into `capabilities/windows.json` (drive letters, `platforms: ["windows"]`) so they don't apply on other platforms
- `decorations` split across `tauri.windows.conf.json` (false) / `tauri.macos.conf.json` + `tauri.linux.conf.json` (true)
- Custom titlebar and Win32 window controls only render on Windows; macOS/Linux use native window chrome
- `--titlebar-height` zeroed out on macOS/Linux via `data-platform` CSS selector so layout has no gap
- Settings accessible on macOS/Linux via `Ctrl+,` / `Cmd+,` keyboard shortcut

**Needs runtime verification on hardware:**
- Titlebar appearance and drag region on macOS and Linux
- Global shortcut recorder, autostart, and tray on all three platforms
- Terminal (`sh` path and `terminal.json` scope) on macOS and Linux

### 3. File hosting UI and upload demo
The REST API file routes are complete (`GET/PUT/DELETE /files`). The in-app side is not built yet. Plan:
- Give `FileExplorer` a provider interface with two implementations: local (`explorer.rs`) and hosted (the REST `/files` routes through `tauri-plugin-http`)
- Drag-and-drop upload with a progress bar via `tauri-plugin-upload`
- Check the HTTP method `tauri-plugin-upload` uses against the server route (`PUT` only today) and add a `POST` alias if needed
- Download and delete actions in the hosted view

### 4. Plugin demo pages
Two registered plugins still have no UI: `tauri-plugin-websocket` (below) and `tauri-plugin-upload`.

**System monitor (`tauri-plugin-websocket`).** Planned:
- Axum WebSocket route `/v1/ws/metrics` on the existing server, with one sampler task (`sysinfo`) that broadcasts to all clients and only samples while at least one is connected
- One JSON message per tick: CPU total and per core, memory and swap, disk usage per mount, network up/down, uptime; clients can send `{"interval": 500}` to change the rate
- New "Read system metrics" switch under Allowed actions, off by default
- Reject WebSocket handshakes that carry an `Origin` header, since browsers don't apply CORS to WebSockets (the plugin sends none, so it is unaffected)
- System Monitor page using the websocket plugin: CPU gauge with sparkline, per-core bars, memory bar, network throughput, disk list, plain SVG, reconnect with backoff
- Also helps the cross-platform item, since `sysinfo` replaces Windows-only disk code

### 5. REST API extensions
- `GET /v1/logs` as a server-sent events stream, so scripts can tail the same logs the Logs panel shows
- `Range` request support for downloads
- Streaming uploads instead of buffering
- Optional CORS allow-list setting for browser clients

### 6. Project quality
- README with a "how to add a setting end to end" checklist (schema, panel, effect, API route) and a capabilities/permissions guide
- Rust unit tests for `validate`, path safety (`safe_rel`, canonical checks) and the auth middleware
- GitHub Actions workflow building on Windows, macOS and Linux
- App icon (currently using the Tauri default icons)

### 7. Later / ideas
- Real PTY-backed Terminal (`portable-pty` in Rust plus xterm.js) for full-screen programs, colors and interactive prompts
- Streaming chat demo with `tauri-plugin-http` (OpenAI-compatible base URL, token streaming, Stop button, provider adapter)