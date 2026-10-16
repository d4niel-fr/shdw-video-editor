//! HTML motion clips: renders agent-written HTML/CSS/JS (GSAP, SVG, CSS
//! animations, canvas, Lottie, three.js…) frame-accurately with alpha, using
//! the headless Microsoft Edge that ships with Windows, driven over the Chrome
//! DevTools Protocol. Time is virtualized, so every frame is deterministic.

use crate::tools;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, State};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

pub const RUNTIME: &str = include_str!("../../agent/html_runtime.js");

struct Page {
    session: String,
    #[allow(dead_code)]
    target: String,
    mtime: SystemTime,
    used: u64,
}

struct Browser {
    child: Child,
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next: u64,
    pages: HashMap<String, Page>,
    front: String,
}

/// Pool of independent headless browsers so frames render in parallel.
pub struct HtmlState(Vec<Arc<Mutex<Option<Browser>>>>);
impl Default for HtmlState {
    fn default() -> Self {
        HtmlState((0..3).map(|_| Arc::new(Mutex::new(None))).collect())
    }
}

fn find_browser() -> Option<PathBuf> {
    let cands = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Arc.app/Contents/MacOS/Arc",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ];
    cands.iter().map(PathBuf::from).find(|p| p.is_file())
}

impl Browser {
    fn launch() -> Result<Browser, String> {
        let exe = find_browser().ok_or("No Chromium browser found (Edge, Chrome, Chromium or Brave) — needed for HTML motion clips")?;
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let profile = tools::app_data_dir().join(format!("render-profile-{}-{}", std::process::id(), n % 12));
        let mut child = tools::cmd(exe)
            .args([
                "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
                "--hide-scrollbars", "--mute-audio", "--allow-file-access-from-files", "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--force-color-profile=srgb",
                "--autoplay-policy=no-user-gesture-required", "--disable-features=Translate,MediaRouter",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot start headless browser: {e}"))?;
        let stderr = child.stderr.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(i) = line.find("ws://") {
                    let _ = tx.send(line[i..].trim().to_string());
                }
            }
        });
        let url = rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "headless browser did not expose DevTools")?;
        let (mut ws, _) = tungstenite::connect(url.as_str()).map_err(|e| format!("devtools connect: {e}"))?;
        if let MaybeTlsStream::Plain(s) = ws.get_mut() {
            let _ = s.set_read_timeout(Some(Duration::from_millis(250)));
            let _ = s.set_nodelay(true);
        }
        Ok(Browser { child, ws, next: 1, pages: HashMap::new(), front: String::new() })
    }

    fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        self.ws.send(Message::Text(msg.to_string().into())).map_err(|e| e.to_string())?;
        let limit = if method == "Runtime.evaluate" || method == "Page.captureScreenshot" { 25 } else { 15 };
        let deadline = Instant::now() + Duration::from_secs(limit);
        loop {
            if Instant::now() > deadline {
                return Err(format!("{method}: timeout (composition not responding)"));
            }
            let m = match self.ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(e) => return Err(format!("connection closed: {e}")),
            };
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).map_err(|e| e.to_string())?;
            if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                if let Some(e) = v.get("error") {
                    return Err(format!("{method}: {}", e));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn eval(&mut self, session: &str, expr: &str) -> Result<Value, String> {
        let r = self.call(Some(session), "Runtime.evaluate", json!({ "expression": expr, "awaitPromise": true, "returnByValue": true }))?;
        if let Some(ex) = r.get("exceptionDetails") {
            let msg = ex.pointer("/exception/description").and_then(|d| d.as_str()).or_else(|| ex.get("text").and_then(|d| d.as_str())).unwrap_or("script error");
            return Err(msg.to_string());
        }
        Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    fn page(&mut self, path: &str, w: u32, h: u32, scale: f64) -> Result<String, String> {
        let key = format!("{path}|{w}x{h}|{scale}");
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).map_err(|e| format!("{path}: {e}"))?;
        self.next += 1;
        let now = self.next;
        if let Some(p) = self.pages.get_mut(&key) {
            p.used = now;
            if p.mtime == mtime {
                return Ok(p.session.clone());
            }
            let s = p.session.clone();
            self.navigate(&s, path, w, h)?;
            self.pages.get_mut(&key).unwrap().mtime = mtime;
            return Ok(s);
        }
        // keep at most 8 warm tabs per renderer: close the least recently used
        while self.pages.len() >= 8 {
            let Some(old) = self.pages.iter().min_by_key(|(_, p)| p.used).map(|(k, _)| k.clone()) else { break };
            if let Some(p) = self.pages.remove(&old) {
                let _ = self.call(None, "Target.closeTarget", json!({ "targetId": p.target }));
                if self.front == p.session { self.front.clear(); }
            }
        }
        let t = self.call(None, "Target.createTarget", json!({ "url": "about:blank" }))?;
        let target = t["targetId"].as_str().ok_or("no targetId")?.to_string();
        let a = self.call(None, "Target.attachToTarget", json!({ "targetId": target, "flatten": true }))?;
        let session = a["sessionId"].as_str().ok_or("no sessionId")?.to_string();
        self.call(Some(&session), "Page.enable", json!({}))?;
        self.call(Some(&session), "Page.addScriptToEvaluateOnNewDocument", json!({ "source": RUNTIME }))?;
        self.call(Some(&session), "Emulation.setDeviceMetricsOverride", json!({ "width": w, "height": h, "deviceScaleFactor": scale, "mobile": false }))?;
        self.call(Some(&session), "Emulation.setDefaultBackgroundColorOverride", json!({ "color": { "r": 0, "g": 0, "b": 0, "a": 0 } }))?;
        self.navigate(&session, path, w, h)?;
        self.pages.insert(key, Page { session: session.clone(), target, mtime, used: now });
        Ok(session)
    }

    fn navigate(&mut self, session: &str, path: &str, w: u32, h: u32) -> Result<(), String> {
        let url = format!("file:///{}?w={w}&h={h}", path.replace('\\', "/").trim_start_matches('/'));
        self.call(Some(session), "Page.navigate", json!({ "url": url }))?;
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(20) {
            let ready = self.eval(session, "document.readyState === 'complete' && !!window.__shdw").unwrap_or(Value::Bool(false));
            if ready == Value::Bool(true) {
                let _ = self.eval(session, "window.__shdw.ready()");
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        Err("HTML composition did not finish loading in 20s".into())
    }
}

/// Render one frame of an HTML composition at clip-local time `t` (seconds).
/// Returns PNG bytes with alpha. Runs on a blocking thread; any hang is cut off
/// by per-call timeouts and the headless browser is restarted.
#[tauri::command]
pub async fn html_frame(
    app: AppHandle,
    state: State<'_, HtmlState>,
    path: String,
    t: f64,
    width: u32,
    height: u32,
    scale: f64,
    params: Value,
    duration: f64,
) -> Result<tauri::ipc::Response, String> {
    let slots = state.0.clone();
    let png = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        // first free browser; otherwise wait on one chosen by path so a composition sticks to a warm page
        let mut guard = slots
            .iter()
            .find_map(|m| m.try_lock().ok())
            .unwrap_or_else(|| {
                let i = path.bytes().fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize)) % slots.len();
                slots[i].lock().unwrap_or_else(|e| e.into_inner())
            });
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(Browser::launch()?);
            }
            let b = guard.as_mut().unwrap();
            let res = (|| -> Result<Vec<u8>, String> {
                let s = b.page(&path, width, height, scale)?;
                // headless Chromium can stall screenshots of background tabs: focus this one
                if b.front != s {
                    b.call(Some(&s), "Page.bringToFront", json!({}))?;
                    b.front = s.clone();
                }
                let v = b.eval(&s, &format!("window.__shdw.frame({t}, {}, {duration})", params))?;
                if let Some(errs) = v.as_array().filter(|a| !a.is_empty()) {
                    let _ = app.emit("html-errors", json!({ "path": path, "errors": errs }));
                }
                let shot = b.call(Some(&s), "Page.captureScreenshot", json!({ "format": "png", "fromSurface": true, "optimizeForSpeed": true }))?;
                let data = shot["data"].as_str().ok_or("no screenshot")?;
                base64_decode(data)
            })();
            match res {
                Ok(png) => return Ok(png),
                Err(e) => {
                    let fatal = e.contains("timeout") || e.contains("closed") || e.contains("os error") || e.contains("Connection") || e.contains("did not finish loading");
                    if fatal {
                        // renderer is wedged (e.g. infinite loop in the page) → restart it
                        if let Some(mut old) = guard.take() {
                            let _ = old.child.kill();
                        }
                    }
                    if !(fatal && attempt == 0) || e.contains("timeout") {
                        return Err(e);
                    }
                }
            }
        }
        Err("headless browser failed".into())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
pub fn html_reset(state: State<HtmlState>) {
    shutdown(&state);
}

pub fn shutdown(state: &HtmlState) {
    for m in &state.0 {
        if let Some(mut b) = m.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = b.child.kill();
        }
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut table = [255u8; 256];
    for (i, c) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().enumerate() {
        table[*c as usize] = i as u8;
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            let v = table[*b as usize];
            if v == 255 {
                return Err("bad base64".into());
            }
            n |= (v as u32) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[allow(dead_code)]
fn _unused(_: &Path) {}

/// Startup: kill headless renderers orphaned by an earlier crash (they lock their
/// profiles and eat CPU) and delete stale profile dirs.
pub fn cleanup_orphans() {
    std::thread::spawn(|| {
        let me = std::process::id();
        #[cfg(windows)]
        {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | Where-Object {{ $_.CommandLine -like '*shdw*render-profile*' -and $_.CommandLine -notlike '*render-profile-{me}-*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let _ = tools::cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).status();
        }
        #[cfg(not(windows))]
        if let Ok(out) = tools::cmd("ps").args(["-axo", "pid=,command="]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let line = line.trim_start();
                let (pid, command) = line.split_once(' ').unwrap_or((line, ""));
                if command.contains("render-profile-") && command.contains("shdw") && !command.contains(&format!("render-profile-{me}-")) {
                    let _ = tools::cmd("kill").args(["-9", pid]).status();
                }
            }
        }
        if let Ok(rd) = std::fs::read_dir(tools::app_data_dir()) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("render-profile-") && !name.starts_with(&format!("render-profile-{me}-")) {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    });
}
