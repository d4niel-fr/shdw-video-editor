//! Local HTTP control API (127.0.0.1 only). Lets the coding agent drive the
//! running editor: render a frame to PNG to check its work, seek, reload,
//! export, transcribe. Requests are forwarded to the UI which answers via
//! `control_respond`.
//!
//! Hardening (see `security.rs`): every request except `/health` must carry the
//! per-launch token (`X-Shdw-Token` or `Authorization: Bearer`), a loopback Host
//! header and no browser Origin / Sec-Fetch-Site headers. Bodies are size-capped
//! and the number of in-flight requests is bounded.

use crate::security::{self, Meta, TOKEN_HEADER};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MAX_BODY: u64 = 1 << 20;
const MAX_INFLIGHT: usize = 32;

type Pending = Arc<Mutex<HashMap<u64, Sender<(u16, String)>>>>;

#[derive(Default)]
pub struct ControlState {
    pub pending: Pending,
    pub port: Arc<AtomicU16>,
    /// Random per-launch secret; unset only if the OS gave us no randomness (API then stays off).
    pub token: Arc<OnceLock<String>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Shared {
    app: AppHandle,
    pending: Pending,
    token: Arc<OnceLock<String>>,
    port: u16,
}

/// Decrements the in-flight counter even if a handler thread panics.
struct InflightGuard(Arc<AtomicUsize>);
impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn header(req: &tiny_http::Request, name: &'static str) -> Option<String> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
}

fn error_body(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn reply(req: tiny_http::Request, status: u16, body: String) {
    let mut res = tiny_http::Response::from_string(body).with_status_code(status);
    for (k, v) in [("Content-Type", "application/json"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")] {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            res = res.with_header(h);
        }
    }
    let _ = req.respond(res);
}

fn handle(mut req: tiny_http::Request, sh: &Shared) {
    let host = header(&req, "Host");
    let origin = header(&req, "Origin");
    let site = header(&req, "Sec-Fetch-Site");
    let tok = header(&req, TOKEN_HEADER);
    let auth = header(&req, "Authorization");
    let meta = Meta {
        host: host.as_deref(),
        origin: origin.as_deref(),
        sec_fetch_site: site.as_deref(),
        token: tok.as_deref(),
        authorization: auth.as_deref(),
    };
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    let expected = sh.token.get().map(String::as_str).unwrap_or("");
    let verdict = if path == "/health" { security::check_host(meta.host, sh.port) } else { security::check_request(&meta, expected, sh.port) };
    if let Err(d) = verdict {
        return reply(req, d.status(), error_body(d.message()));
    }
    if path == "/health" {
        return reply(req, 200, "{\"ok\":true,\"app\":\"shdw\"}".to_string());
    }

    let mut body = String::new();
    match req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body) {
        Ok(n) if n as u64 > MAX_BODY => return reply(req, 413, error_body("request body too large")),
        Ok(_) => {}
        Err(_) => return reply(req, 400, error_body("request body must be UTF-8")),
    }

    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    sh.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let _ = sh.app.emit("control-request", serde_json::json!({ "id": id, "method": req.method().as_str(), "url": url, "body": body }));
    // the UI enforces per-endpoint limits (≤30 min); this is only a backstop
    let (status, text) = rx.recv_timeout(Duration::from_secs(31 * 60)).unwrap_or((504, error_body("editor did not answer")));
    sh.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    reply(req, status, text);
}

pub fn start(app: AppHandle, state: &ControlState) {
    let mut seed = [0u8; 32];
    if getrandom::getrandom(&mut seed).is_err() {
        eprintln!("shdw: no secure randomness available; control API disabled");
        return;
    }
    let _ = state.token.set(security::token_from_bytes(&seed));
    let (pending, port_slot, token) = (state.pending.clone(), state.port.clone(), state.token.clone());
    std::thread::spawn(move || {
        let server = (47800..47900).find_map(|p| tiny_http::Server::http(("127.0.0.1", p)).ok().map(|s| (s, p)));
        let Some((server, port)) = server else { return };
        port_slot.store(port, Ordering::SeqCst);
        let shared = Arc::new(Shared { app, pending, token, port });
        let inflight = Arc::new(AtomicUsize::new(0));
        for req in server.incoming_requests() {
            if inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT {
                reply(req, 503, error_body("too many requests in flight"));
                continue;
            }
            inflight.fetch_add(1, Ordering::SeqCst);
            let guard = InflightGuard(inflight.clone());
            let shared = shared.clone();
            // one thread per request: a long export must not block /errors or /state
            std::thread::spawn(move || {
                let _guard = guard;
                handle(req, &shared);
            });
        }
    });
}

#[tauri::command]
pub fn control_respond(state: State<ControlState>, id: u64, status: u16, body: String) {
    if let Some(tx) = state.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send((status, body));
    }
}

#[tauri::command]
pub fn control_port(state: State<ControlState>) -> u16 {
    state.port.load(Ordering::SeqCst)
}

/// Resolve a path received over the control API. `kind` is "output" (frames, exports:
/// project-only, media extensions) or "media" (imports).
#[tauri::command]
pub fn control_resolve_path(root: String, path: String, kind: String) -> Result<String, String> {
    let root = Path::new(&root);
    let resolved = match kind.as_str() {
        "output" => security::resolve_output(root, &path)?,
        "media" => security::resolve_media(root, &path)?,
        _ => return Err(format!("unknown path kind '{kind}'")),
    };
    let s = resolved.to_string_lossy().to_string();
    // canonicalize() yields `\\?\C:\…` on Windows, which ffmpeg and the UI path helpers dislike
    Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
}
