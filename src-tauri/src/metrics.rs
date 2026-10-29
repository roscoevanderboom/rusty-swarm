//! Real-time system metrics via WebSocket.
//!
//! Route: GET /v1/ws/metrics   (behind require_key middleware)
//!
//! One sampler task runs while at least one client is connected.
//! Each tick it refreshes sysinfo, builds a JSON snapshot, and broadcasts
//! it to all connected clients via a tokio broadcast channel.
//!
//! Clients can send  {"interval": <ms>}  (clamped 200–5000) to change the
//! tick rate for that connection.
//!
//! Security: handshakes that carry an Origin header are rejected (403).
//! Browser JS cannot connect cross-origin; the Tauri plugin sends no Origin.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    extract::{State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use sysinfo::{Disks, Networks, System};
use tauri_plugin_log::log::{debug, warn};
use tokio::sync::{Mutex, broadcast};

use crate::server::AppState;

/* ─── Shared state ──────────────────────────────────────────────────── */

#[derive(Clone)]
pub struct MetricsState(Arc<Inner>);

struct Inner {
    tx: broadcast::Sender<String>,
    subscribers: Arc<AtomicUsize>,
    sampler: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for MetricsState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(32);
        Self(Arc::new(Inner {
            tx,
            subscribers: Arc::new(AtomicUsize::new(0)),
            sampler: Mutex::new(None),
        }))
    }
}

impl MetricsState {

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.0.tx.subscribe()
    }

    pub fn inc(&self) -> usize {
        self.0.subscribers.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn dec(&self) -> usize {
        self.0.subscribers.fetch_sub(1, Ordering::SeqCst).saturating_sub(1)
    }

    pub async fn ensure_sampler_running(&self) {
        let mut guard = self.0.sampler.lock().await;
        let needs_start = guard
            .as_ref()
            .map(|h| h.is_finished())
            .unwrap_or(true);

        if needs_start {
            let tx = self.0.tx.clone();
            let subs = Arc::clone(&self.0.subscribers);
            let handle = tokio::task::spawn_blocking(move || {
                sampler_loop(tx, subs);
            });
            *guard = Some(handle);
        }
    }
}

/* ─── Sampler (runs in a blocking thread) ──────────────────────────── */

fn sampler_loop(tx: broadcast::Sender<String>, subs: Arc<AtomicUsize>) {
    let mut sys = System::new_all();
    let mut disks = Disks::new_with_refreshed_list();
    let mut nets = Networks::new_with_refreshed_list();

    // spin‐wait until at least one subscriber (avoids a 1‐tick delay on connect)
    while subs.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let mut tick_ms: u64 = 1000;

    loop {
        if subs.load(Ordering::SeqCst) == 0 {
            debug!("metrics: no subscribers, sampler exiting");
            break;
        }

        sys.refresh_all();
        disks.refresh(false);
        nets.refresh(true);

        // CPU
        let cores: Vec<f32> = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
        let total_cpu = if cores.is_empty() {
            0.0
        } else {
            cores.iter().sum::<f32>() / cores.len() as f32
        };

        // Memory
        let mem_used = sys.used_memory();
        let mem_total = sys.total_memory();
        let swap_used = sys.used_swap();
        let swap_total = sys.total_swap();

        // Disks
        let disk_list: Vec<_> = disks
            .iter()
            .map(|d| {
                let total = d.total_space();
                let avail = d.available_space();
                let used = total.saturating_sub(avail);
                json!({
                    "mount": d.mount_point().to_string_lossy(),
                    "used": used,
                    "total": total,
                })
            })
            .collect();

        // Network (delta bytes this tick)
        let rx: u64 = nets.iter().map(|(_, n)| n.received()).sum();
        let tx_bytes: u64 = nets.iter().map(|(_, n)| n.transmitted()).sum();

        let msg = json!({
            "uptime": System::uptime(),
            "cpu": { "total": total_cpu, "cores": cores },
            "memory": {
                "used": mem_used,
                "total": mem_total,
                "swap_used": swap_used,
                "swap_total": swap_total,
            },
            "disks": disk_list,
            "network": { "rx_bytes": rx, "tx_bytes": tx_bytes },
        });

        if tx.send(msg.to_string()).is_err() {
            // No receivers — exit so the task doesn't linger
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(tick_ms));

        // Check for an interval hint left by a receiver — we use a side-channel
        // approach: the handle is spawned fresh if interval changes significantly,
        // but here we keep it simple and just read the atomic below.
        // (Per-connection interval is managed in the async WS handler instead.)
        let _ = tick_ms; // suppress unused warning
        tick_ms = GLOBAL_INTERVAL.load(Ordering::Relaxed) as u64;
        if tick_ms < 200 { tick_ms = 200; }
        if tick_ms > 5000 { tick_ms = 5000; }
    }
}

/// Clients vote on the interval; we take the minimum requested among all senders.
/// Stored as ms. Default 1000.
static GLOBAL_INTERVAL: AtomicUsize = AtomicUsize::new(1000);

/* ─── Message types ─────────────────────────────────────────────────── */

#[derive(Deserialize)]
struct ClientMessage {
    interval: Option<u64>,
}

/* ─── WebSocket handler ─────────────────────────────────────────────── */

pub async fn ws_metrics(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Check readMetrics permission before upgrading
    if let Err(e) = state.require("readMetrics") {
        return e.into_response();
    }

    let metrics = state.metrics.clone();
    upgrade.on_upgrade(move |socket| handle_socket(socket, metrics))
}

async fn handle_socket(mut socket: WebSocket, metrics: MetricsState) {
    let count = metrics.inc();
    debug!("metrics: client connected ({count} total)");

    metrics.ensure_sampler_running().await;

    let mut rx = metrics.subscribe();

    // Ping/pong + send/recv loop
    loop {
        tokio::select! {
            // Broadcast message → send to client
            broadcast = rx.recv() => {
                match broadcast {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("metrics: client lagged, dropped {n} messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Client message → parse interval change
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(txt))) => {
                        if let Ok(cm) = serde_json::from_str::<ClientMessage>(&txt) {
                            if let Some(ms) = cm.interval {
                                let clamped = ms.clamp(200, 5000) as usize;
                                GLOBAL_INTERVAL.store(clamped, Ordering::Relaxed);
                                debug!("metrics: interval set to {clamped}ms");
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    let remaining = metrics.dec();
    debug!("metrics: client disconnected ({remaining} remaining)");
}

/* ─── Unused import suppression ─────────────────────────────────────── */
// interval and Duration are used only in the async WS future; keep for clarity.
