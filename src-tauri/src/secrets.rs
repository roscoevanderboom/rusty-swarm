//! Secure API key storage via the OS credential store.
//!
//! Uses the `keyring` crate (v2) which maps to:
//!   - Windows Credential Manager
//!   - macOS Keychain
//!   - Linux Secret Service (or kernel keyring fallback)
//!
//! No extra build dependencies, no libsodium.

use keyring::Entry;

const SERVICE: &str = "rusty-hermes";
const USER: &str = "api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|e| format!("Could not open credential store: {e}"))
}

/// Read the API key from the OS credential store.
/// Returns an empty string if no key has been set.
#[tauri::command]
pub fn get_api_key() -> Result<String, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("Could not read API key: {e}")),
    }
}

/// Write or clear the API key in the OS credential store.
/// Pass an empty string to delete the stored credential.
#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let entry = entry()?;
    if key.is_empty() {
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // already gone, that's fine
            Err(e) => Err(format!("Could not delete API key: {e}")),
        }
    } else {
        entry
            .set_password(&key)
            .map_err(|e| format!("Could not save API key: {e}"))
    }
}

/// Returns the machine's primary local network IP address (the one that would
/// be reachable from other devices on the LAN). Falls back to "127.0.0.1" if
/// nothing useful can be found.
#[tauri::command]
pub fn get_local_ip() -> String {
    // Open a UDP socket toward a public address — no packet is actually sent,
    // but the OS picks the outbound interface and we can read its local address.
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}
