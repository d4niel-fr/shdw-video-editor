//! Local HTTP control API (127.0.0.1 only). Lets the coding agent drive the
//! running editor: render a frame to PNG to check its work, seek, reload,
//! export, transcribe. Requests are forwarded to the UI which answers via
//! `control_respond`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU16, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ControlState {
    pub pending: Arc<Mutex<HashMap<u64, Sender<(u16, String)>>>>,
    pub port: Arc<AtomicU16>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn start(app: AppHandle, state: &ControlState) {
    let pending = state.pending.clone();
    let port_slot = state.port.clone();
    std::thread::spawn(move || {
        let server = (47800..47900).find_map(|p| tiny_http::Server::http(("127.0.0.1", p)).ok().map(|s| (s, p)));
        let Some((server, port)) = server else { return };
        port_slot.store(port, Ordering::SeqCst);
        for mut req in server.incoming_requests() {
            // one thread per request: a long export must not block /errors or /state
            let pending = pending.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let url = req.url().to_string();
                if url == "/health" {
                    let _ = req.respond(tiny_http::Response::from_string("{\"ok\":true,\"app\":\"shdw\"}"));
                    return;
                }
                let id = NEXT.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = channel();
                pending.lock().unwrap().insert(id, tx);
                let _ = app.emit(
                    "control-request",
                    serde_json::json!({ "id": id, "method": req.method().as_str(), "url": url, "body": body }),
                );
                // the UI enforces per-endpoint limits (≤30 min); this is only a backstop
                let (status, text) = rx
                    .recv_timeout(Duration::from_secs(31 * 60))
                    .unwrap_or((504, "{\"error\":\"editor did not answer\"}".into()));
                pending.lock().unwrap().remove(&id);
                let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
                let _ = req.respond(tiny_http::Response::from_string(text).with_status_code(status).with_header(header));
            });
        }
    });
}


#[tauri::command]
pub fn control_respond(state: State<ControlState>, id: u64, status: u16, body: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send((status, body));
    }
}

#[tauri::command]
pub fn control_port(state: State<ControlState>) -> u16 {
    state.port.load(Ordering::SeqCst)
}
