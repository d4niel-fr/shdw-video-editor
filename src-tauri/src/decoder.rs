//! Sequential ffmpeg frame decoders used by export: each video clip gets an
//! ffmpeg process producing raw, already-scaled, bottom-up RGBA frames at the
//! timeline frame rate — no per-frame seeking.

use crate::tools;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStdout, Stdio};
use std::sync::Mutex;
use tauri::State;

struct Dec {
    child: Child,
    out: ChildStdout,
    frame_bytes: usize,
}

#[derive(Default)]
pub struct DecoderState(Mutex<HashMap<String, Dec>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecOpen {
    id: String,
    path: String,
    start: f64,
    fps: f64,
    speed: f64,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn decoder_open(state: State<DecoderState>, o: DecOpen) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    if let Some(mut d) = map.remove(&o.id) {
        let _ = d.child.kill();
    }
    let speed = if o.speed > 0.0 { o.speed } else { 1.0 };
    let vf = format!(
        "setpts=(PTS-STARTPTS)/{speed:.6},fps={fps},scale={w}:{h}:flags=bicubic,format=rgba,vflip",
        fps = o.fps,
        w = o.width,
        h = o.height
    );
    let mut child = tools::cmd(tools::ffmpeg()?)
        .args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{:.6}", o.start.max(0.0)), "-i"])
        .arg(&o.path)
        .args(["-an", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("no stdout")?;
    map.insert(o.id, Dec { child, out, frame_bytes: (o.width * o.height * 4) as usize });
    Ok(())
}

/// Read `skip` frames (discarded) then one frame. Empty response = end of stream.
#[tauri::command]
pub async fn decoder_read(state: State<'_, DecoderState>, id: String, skip: u32) -> Result<tauri::ipc::Response, String> {
    let mut map = state.0.lock().unwrap();
    let d = map.get_mut(&id).ok_or("decoder not open")?;
    let mut buf = vec![0u8; d.frame_bytes];
    for _ in 0..=skip {
        if d.out.read_exact(&mut buf).is_err() {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
    }
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
pub fn decoder_close_all(state: State<DecoderState>) {
    for (_, mut d) in state.0.lock().unwrap().drain() {
        let _ = d.child.kill();
    }
}
