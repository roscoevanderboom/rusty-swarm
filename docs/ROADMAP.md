# Roadmap

`rusty-swarm` is a Tauri v2 desktop application base template built with React, TypeScript, and Rust. This branch keeps the reusable desktop foundation and removes the sample applications.

## Included foundation

- Cross-platform app shell with native window controls and tray behavior
- Settings modal with persisted appearance, general, server, logs, storage, and about settings
- Theme, accent color, and UI scaling support
- Logging, notifications, autostart, and single-instance behavior
- Optional authenticated local API server with settings and file-hosting routes
- Tauri plugin dependencies and registrations retained as a starting point for application features

## Next steps

- Document setup, settings, capabilities, and plugin usage in the README
- Add focused Rust tests for validation, path safety, and API authentication
- Add CI builds for Windows, macOS, and Linux
- Polish app icons and packaging

Product-specific pages and features belong in downstream applications or separate branches rather than this base template.
