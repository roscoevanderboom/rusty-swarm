//! Local REST API.
//!
//! The frontend starts and stops it through `api_server_start` / `api_server_stop`
//! (see `useApiServer.ts`). Handlers never touch the UI directly: they write to the
//! same Tauri store the settings modal uses, and the frontend reacts to the change
//! event. That keeps one source of truth, so a PATCH from curl and a click in the
//! modal end up in the same place.
//!
//! Routes
//!   GET   /health                public, no key needed
//!   GET   /v1/settings           current theme, accent, font size, scale, window state
//!   PATCH /v1/settings           change themeMode, accent, uiScale (if allowed)
//!   POST  /v1/window/show        show and focus the window (if allowed)
//!   POST  /v1/window/hide        hide the window (if allowed)
//!   GET   /files                 list the hosted folder (if file hosting is on)
//!   GET   /files/<path>          download a file or list a subfolder
//!   PUT   /files/<path>          upload a file (not when read-only)
//!   DELETE /files/<path>         delete a file or empty folder (not when read-only)

use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Wry};
use tauri_plugin_log::log::{error, info};
use tauri_plugin_store::{Store, StoreExt};
use tokio::{
    net::TcpListener,
    sync::{Mutex, oneshot},
};

use crate::{files, window};

const STORE_FILE: &str = "settings.json";

/// Settings the API is allowed to change. Each one is also gated by the matching
/// switch under Settings > Server > Allowed actions (`apiPermissions` in the store).
const CONTROLLABLE: [&str; 3] = ["themeMode", "accent", "uiScale"];

/* ------------------------------------------------------------------ */
/* Lifecycle: managed state plus the two commands the frontend calls   */
/* ------------------------------------------------------------------ */

struct Running {
    shutdown: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct ApiServer(Mutex<Option<Running>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    host: String,
    port: u16,
    api_key: String,
}

async fn stop_running(slot: &mut Option<Running>) {
    if let Some(running) = slot.take() {
        let _ = running.shutdown.send(());
        let _ = running.task.await; // wait so the port is free again
    }
}

/// Starts the server, or restarts it if it is already running.
#[tauri::command]
pub async fn api_server_start(
    app: AppHandle,
    server: tauri::State<'_, ApiServer>,
    config: ServerConfig,
) -> Result<(), String> {
    let ip: IpAddr = match config.host.as_str() {
        "127.0.0.1" | "0.0.0.0" => config
            .host
            .parse()
            .map_err(|e| format!("Invalid host: {e}"))?,
        other => return Err(format!("Unsupported host: {other}")),
    };
    if config.port == 0 {
        return Err("Enter a port between 1 and 65535.".into());
    }

    let mut slot = server.0.lock().await;
    stop_running(&mut slot).await;

    let addr = SocketAddr::new(ip, config.port);
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Could not listen on {addr}: {e}"))?;

    let notify_app = app.clone();
    let state = AppState {
        app,
        api_key: Arc::from(config.api_key.trim()),
    };
    let (shutdown, shutdown_rx) = oneshot::channel::<()>();

    let task = tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router(state))
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = result {
            error!("REST API stopped with an error: {e}");
        }
    });

    *slot = Some(Running { shutdown, task });
    info!("REST API listening on http://{addr}");
    crate::notify(
        &notify_app,
        "REST API started",
        &format!("Listening on http://{addr}"),
    );
    Ok(())
}

#[tauri::command]
pub async fn api_server_stop(
    app: AppHandle,
    server: tauri::State<'_, ApiServer>,
) -> Result<(), String> {
    let mut slot = server.0.lock().await;
    if slot.is_some() {
        stop_running(&mut slot).await;
        info!("REST API stopped");
        crate::notify(
            &app,
            "REST API stopped",
            "The REST API is no longer running.",
        );
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Router, auth and errors                                             */
/* ------------------------------------------------------------------ */

#[derive(Clone)]
pub(crate) struct AppState {
    app: AppHandle,
    api_key: Arc<str>,
}

impl AppState {
    pub(crate) fn store(&self) -> Result<Arc<Store<Wry>>, ApiError> {
        self.app
            .store(STORE_FILE)
            .map_err(|e| ApiError::internal(format!("Could not open settings: {e}")))
    }

    fn require(&self, permission: &str) -> Result<(), ApiError> {
        let store = self.store()?;
        if allowed(&store, permission) {
            Ok(())
        } else {
            Err(ApiError::forbidden(format!(
                "This action is turned off in Settings > Server > Allowed actions ({permission})."
            )))
        }
    }
}

fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/settings", get(get_settings).patch(patch_settings))
        .route("/v1/window/show", post(show_window))
        .route("/v1/window/hide", post(hide_window))
        .route("/files", get(files::list_root))
        .route(
            "/files/{*path}",
            get(files::download)
                .put(files::upload)
                .delete(files::remove),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_key));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(state)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Bearer-token check. With no key set, any local request is accepted.
/// Also accepts the key as a `?token=` query parameter so browser links work.
///
/// There is no CORS layer on purpose: browsers can't call this API from other
/// sites, and the JSON extractor requires `Content-Type: application/json`,
/// which forces a preflight that is then refused.
async fn require_key(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if state.api_key.is_empty() {
        return next.run(req).await;
    }

    // Check Authorization header first, then ?token= query param.
    let header_token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);

    let query_token = req
        .uri()
        .query()
        .and_then(|q| {
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                if k == "token" { Some(v.to_owned()) } else { None }
            })
        });

    let provided = header_token.or(query_token).unwrap_or_default();
    let authorized = constant_time_eq(provided.as_bytes(), state.api_key.as_bytes());

    if authorized {
        next.run(req).await
    } else {
        ApiError::new(StatusCode::UNAUTHORIZED, "Missing or invalid API key.").into_response()
    }
}

pub(crate) struct ApiError(StatusCode, String);

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }
    pub(crate) fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */

/// Reads `apiPermissions.<name>` from the store, falling back to the frontend defaults.
fn allowed(store: &Store<Wry>, name: &str) -> bool {
    let default = matches!(name, "themeMode" | "accent" | "windowVisibility");
    store
        .get("apiPermissions")
        .and_then(|p| p.get(name).and_then(Value::as_bool))
        .unwrap_or(default)
}

fn value_or(store: &Store<Wry>, key: &str, default: Value) -> Value {
    store.get(key).unwrap_or(default)
}

fn snapshot(store: &Store<Wry>, app: &AppHandle) -> Value {
    json!({
        "themeMode": value_or(store, "themeMode", json!("system")),
        "accent": value_or(store, "accent", json!("")),
        "fontSize": value_or(store, "fontSize", json!("default")),
        "uiScale": value_or(store, "uiScale", json!(100)),
        "window": { "visible": window::is_main_window_visible(app) },
    })
}

fn validate(key: &str, value: &Value) -> Result<(), ApiError> {
    let ok = match key {
        "themeMode" => matches!(value.as_str(), Some("light" | "dark" | "system")),
        "accent" => value.as_str().is_some_and(|s| {
            s.is_empty()
                || (s.len() == 7
                    && s.starts_with('#')
                    && s[1..].chars().all(|c| c.is_ascii_hexdigit()))
        }),
        "uiScale" => value.as_u64().is_some_and(|n| (80..=150).contains(&n)),
        _ => false,
    };
    if ok {
        return Ok(());
    }
    Err(ApiError::bad(match key {
        "themeMode" => "themeMode must be \"light\", \"dark\" or \"system\".",
        "accent" => "accent must be a hex color like \"#10b981\", or \"\" for the theme default.",
        _ => "uiScale must be a whole number from 80 to 150.",
    }))
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "name": "rusty-hermes",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn get_settings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let store = state.store()?;
    Ok(Json(snapshot(&store, &state.app)))
}

async fn patch_settings(
    State(state): State<AppState>,
    Json(body): Json<Map<String, Value>>,
) -> Result<Json<Value>, ApiError> {
    let store = state.store()?;

    // Validate everything first so a bad request changes nothing.
    for (key, value) in &body {
        if !CONTROLLABLE.contains(&key.as_str()) {
            return Err(ApiError::bad(format!(
                "Unknown or read-only setting: {key}"
            )));
        }
        if !allowed(&store, key) {
            return Err(ApiError::forbidden(format!(
                "Changing {key} is turned off in Settings > Server > Allowed actions."
            )));
        }
        validate(key, value)?;
    }

    for (key, value) in body {
        store.set(key, value); // emits a change event the frontend listens for
    }
    if let Err(e) = store.save() {
        error!("Could not save settings: {e}");
    }

    Ok(Json(snapshot(&store, &state.app)))
}

async fn show_window(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.require("windowVisibility")?;
    window::show_main_window(&state.app);
    Ok(Json(json!({ "visible": true })))
}

async fn hide_window(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.require("windowVisibility")?;
    window::hide_main_window(&state.app);
    Ok(Json(json!({ "visible": false })))
}
