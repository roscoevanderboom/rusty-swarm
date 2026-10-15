mod explorer;
mod files;
mod secrets;
mod server;
mod tray;
mod window;

use tauri_plugin_log::{Target, TargetKind, log::LevelFilter};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Windows drops toasts from unregistered app IDs, so register one under HKCU (no admin needed).
#[cfg(windows)]
fn register_aumid() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\AppUserModelId\rusty-hermes",
            "/v",
            "DisplayName",
            "/t",
            "REG_SZ",
            "/d",
            "rusty-hermes",
            "/f",
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
}

/// Shows a toast. Runs on its own thread so WinRT gets a fresh COM apartment.
fn show_toast(app: &tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_log::log::{error, info};
    info!("Notification: sending \"{title}\" / \"{body}\"");
    let app = app.clone();
    let result = std::thread::spawn(move || -> Result<(), String> {
        // Windows dev builds have no AUMID, so the plugin would send as PowerShell (often disabled).
        #[cfg(windows)]
        {
            let _ = &app;
            register_aumid();
            tauri_winrt_notification::Toast::new("rusty-hermes")
                .title(&title)
                .text1(&body)
                .show()
                .map_err(|e| e.to_string())
        }
        #[cfg(not(windows))]
        {
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|e| e.to_string())
        }
    })
    .join()
    .unwrap_or_else(|_| Err("notification thread panicked".into()));
    match &result {
        Ok(()) => info!("Notification: sent"),
        Err(e) => error!("Notification failed: {e}"),
    }
    result
}

/// App-event notification; honours the "Show notifications" setting.
pub(crate) fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_store::StoreExt;
    let enabled = app
        .store("settings.json")
        .ok()
        .and_then(|s| s.get("notifications"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !enabled {
        return;
    }
    let (app, title, body) = (app.clone(), title.to_string(), body.to_string());
    std::thread::spawn(move || {
        let _ = show_toast(&app, title, body);
    });
}

#[tauri::command]
fn send_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    show_toast(&app, title, body)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Must be registered first: launching a second copy focuses the running window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    LevelFilter::Debug
                } else {
                    LevelFilter::Info
                })
                .max_file_size(2_000_000)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    // Feeds the Logs panel through attachLogger() in useLogs.ts.
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_localhost::Builder::new(8000).build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // Keep last: it restores fs and asset scopes saved by the plugins above.
        .plugin(tauri_plugin_persisted_scope::init())
        .manage(server::ApiServer::default())
        .setup(|app| {
            // Desktop-only plugins are added here so mobile builds still compile.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_autostart::Builder::new().build())?;
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_cli::init())?;
                tray::create(app.handle())?;
            }
            notify(app.handle(), "rusty-hermes", "App loaded");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            send_notification,
            secrets::get_api_key,
            secrets::set_api_key,
            secrets::get_local_ip,
            server::api_server_start,
            server::api_server_stop,
            explorer::explorer_list_dir,
            explorer::explorer_list_drives,
            window::clock_show,
            window::clock_hide,
            window::clock_toggle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
