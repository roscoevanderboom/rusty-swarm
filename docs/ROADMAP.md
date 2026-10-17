# Roadmap

rusty-swarm is a Tauri v2 desktop app. This roadmap reflects the current state of the project: all core Phase 1 work is complete, and only the remaining polish and expansion items are left.

---

## Phase 1 — Completed features

This is the full product baseline that is now built and working.

### App shell and desktop integration
- Custom titlebar with minimize, maximize, and close controls
- Close-to-tray support with a configurable setting
- Startup behavior for minimized launch and delayed window reveal
- Settings entry in the titlebar and theme-aware window chrome
- Theme-aware styling, accent color support, and app scaling controls
- Cross-platform window behavior with Linux and Windows path handling in place

### Settings system
- Full settings modal with the following sections:
  - Appearance
  - General
  - Server
  - Logs
  - Storage
  - About
- Store-backed persistence using Tauri store plugin
- Live settings synchronization between the app UI and the backend API
- Autostart, tray behavior, notification toggles, and server settings all wired in

### Plugin integrations
- Tauri store, log, filesystem, shell, CLI, process, dialog, clipboard, opener, notification, SQL, HTTP, and autostart integration are all connected
- Single-instance app behavior and window focus handling are implemented
- File Explorer directory watching and file system access are working
- Terminal shell execution is wired to the proper OS shell

### Server and file hosting
- Axum server with health checks and settings API routes
- Authenticated settings updates and local window control routes
- File hosting routes for list, upload, download, and delete operations
- Path traversal protection and safe file serving behavior
- Uploads and deletion restricted by read-only and hosting toggles

### File Explorer
- Favorites for user folders
- Real directory browsing with breadcrumbs and navigation controls
- List and grid view modes
- File and folder metadata display
- Real-time directory updates from the filesystem watcher
- OS-aware path normalization and Linux mount handling
- Hidden-file toggle for cleaner Linux UX

### HTTP Client
- Resource-based API browsing for the D&D 5e SRD
- Search, JSON viewer, request metadata, and copy action support
- Tauri HTTP plugin integration with browser fallback behavior

### Kanban board
- SQLite-backed task board with columns and cards
- Full CRUD support for tasks and task moves
- Priority labels, metadata, and persistence across sessions

### Terminal
- Command runner with streaming output
- Built-in command registry and working-directory tracking
- Command history, input handling, and output cleanup
- Shell access scoped through Tauri capabilities

### Tray and system behavior
- Tray icon with show and quit actions
- Local app window lifecycle management

---

## Phase 2 — Remaining work

Only the following work remains after the completed Phase 1 baseline.

### 5. REST API extensions
- `GET /v1/logs` streaming endpoint
- Range request support for downloads
- Streaming uploads instead of in-memory buffering
- Optional CORS allow-list for browser clients

### 6. Project quality
- README guide for end-to-end settings and capability wiring
- Rust unit tests for validation, path safety, and auth logic
- CI workflow for Windows, macOS, and Linux builds
- App icon polish and packaging improvements

### 7. Later / ideas
- Real PTY-backed terminal for interactive programs and colors
- Streaming chat or AI-style demo using the HTTP plugin
- Further UX polish based on real-world usage and platform quirks

---

## Summary

Phase 1 is the stable desktop app foundation: shell, settings, explorer, terminal, server, and core integrations are all in place. The remaining work is now intentionally narrow and consists of Phase 2 items 5, 6, and 7 only.