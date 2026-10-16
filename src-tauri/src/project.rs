//! Project folder scaffolding, generic file access and the folder watcher that
//! hot-reloads edits made by the coding agent.

use crate::tools;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, State};

pub const AGENT_GUIDE: &str = include_str!("../../agent/SHDW_AGENT_GUIDE.md");
pub const PROJECT_DIRS: &[&str] = &["media", "motion", "transitions", "effects", "blends", "fonts", "inspo", "luts", "renders", "transcripts", ".shdw"];

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<notify::RecommendedWatcher>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: f64,
}

fn write_guides(dir: &Path, port: u16) -> Result<(), String> {
    let guide = AGENT_GUIDE.replace("{{PORT}}", &port.to_string());
    std::fs::write(dir.join("CLAUDE.md"), &guide).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("AGENTS.md"), &guide).map_err(|e| e.to_string())?;
    let _ = std::fs::write(dir.join(".shdw").join("port"), port.to_string());
    Ok(())
}

#[tauri::command]
pub fn project_init(dir: String, port: u16, default_project: String) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    for sub in PROJECT_DIRS {
        std::fs::create_dir_all(d.join(sub)).map_err(|e| e.to_string())?;
    }
    let pj = d.join("project.shdw.json");
    if !pj.exists() {
        std::fs::write(&pj, default_project).map_err(|e| e.to_string())?;
    }
    write_guides(&d, port)?;
    std::fs::read_to_string(pj).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watch_dir(app: AppHandle, state: State<WatchState>, dir: String) -> Result<(), String> {
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths: Vec<String> = ev
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .filter(|p| !p.contains("\\.shdw\\") && !p.contains("/.shdw/"))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("fs-change", paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(Path::new(&dir), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(w);
    Ok(())
}

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(p) = Path::new(&path).parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Raw-body write: header `x-path` carries the destination.
#[tauri::command]
pub fn write_bytes(request: Request) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|s| String::from_utf8_lossy(&decode_uri(s)).to_string())
        .ok_or("missing x-path header")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    if let Some(p) = Path::new(&path).parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

fn decode_uri(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

#[tauri::command]
pub fn list_dir(path: String, recursive: bool) -> Result<Vec<Entry>, String> {
    let mut out = vec![];
    walk(Path::new(&path), recursive, &mut out, 0)?;
    Ok(out)
}

fn walk(dir: &Path, recursive: bool, out: &mut Vec<Entry>, depth: u32) -> Result<(), String> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if depth == 0 => return Err(e.to_string()),
        Err(_) => return Ok(()),
    };
    for e in rd.flatten() {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        out.push(Entry { name: name.clone(), path: e.path().to_string_lossy().to_string(), is_dir: md.is_dir(), size: md.len(), modified });
        if recursive && md.is_dir() && !name.starts_with('.') && depth < 6 {
            walk(&e.path(), recursive, out, depth + 1)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> Result<(), String> {
    if let Some(p) = Path::new(&dst).parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn reveal(path: String) {
    let _ = tools::cmd("explorer").arg(format!("/select,{}", path.replace('/', "\\"))).spawn();
}

#[tauri::command]
pub fn startup_project() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_dir())
}

#[tauri::command]
pub fn env_info() -> serde_json::Value {
    let f = |n: &str| tools::find(n).map(|p| p.to_string_lossy().to_string());
    let v = |n: &str| tools::find(n).and_then(|p| tools::version_of(&p));
    serde_json::json!({
        "ffmpeg": f("ffmpeg"),
        "ffprobe": f("ffprobe"),
        "claude": f("claude"),
        "claudeVersion": v("claude"),
        "codex": f("codex"),
        "codexVersion": v("codex"),
        "home": std::env::var("USERPROFILE").ok(),
        "appData": tools::app_data_dir().to_string_lossy(),
        "fontsDir": std::env::var("WINDIR").ok().map(|w| format!("{w}\\Fonts")),
    })
}
