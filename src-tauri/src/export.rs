//! Final render: the WebGL compositor streams raw RGBA frames here and we pipe
//! them into an ffmpeg encoder together with the mixed-down audio.

use crate::tools;
use serde::Deserialize;
use std::io::Write;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

pub struct ExportJob {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ExportState(pub Mutex<Option<ExportJob>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOpts {
    out: String,
    width: u32,
    height: u32,
    fps: f64,
    audio: Option<String>,
    /// h264 | h265 | prores | vp9 | gif | png
    codec: String,
    quality: Option<u32>,
}

#[tauri::command]
pub fn export_start(state: State<ExportState>, opts: ExportOpts) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut j) = guard.take() {
        let _ = j.child.kill();
    }
    let mut c = tools::cmd(tools::ffmpeg()?);
    c.args(["-hide_banner", "-loglevel", "error", "-y"]);
    c.args([
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{}x{}", opts.width, opts.height),
        "-r", &format!("{}", opts.fps), "-i", "-",
    ]);
    let has_audio = opts.audio.is_some() && opts.codec != "gif" && opts.codec != "png";
    if let (true, Some(a)) = (has_audio, &opts.audio) {
        c.arg("-i").arg(a);
    }
    let q = opts.quality.unwrap_or(18).to_string();
    // WebGL readPixels is bottom-up
    match opts.codec.as_str() {
        "h265" => c.args(["-vf", "vflip", "-c:v", "libx265", "-crf", &q, "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]),
        "prores" => c.args(["-vf", "vflip", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]),
        "prores4444" => c.args(["-vf", "vflip", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"]),
        "vp9" => c.args(["-vf", "vflip", "-c:v", "libvpx-vp9", "-crf", &q, "-b:v", "0", "-pix_fmt", "yuva420p"]),
        "gif" => c.args(["-vf", "vflip,split[a][b];[a]palettegen[p];[b][p]paletteuse"]),
        "png" => c.args(["-vf", "vflip", "-c:v", "png"]),
        _ => c.args(["-vf", "vflip", "-c:v", "libx264", "-crf", &q, "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]),
    };
    if has_audio {
        let acodec = match opts.codec.as_str() {
            "prores" | "prores4444" => "pcm_s16le",
            "vp9" => "libopus",
            _ => "aac",
        };
        c.args(["-map", "0:v", "-map", "1:a", "-c:a", acodec, "-b:a", "320k", "-shortest"]);
    }
    c.arg(&opts.out);
    c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take();
    *guard = Some(ExportJob { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn export_frame(state: State<ExportState>, request: Request) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw frame bytes".into());
    };
    let mut guard = state.0.lock().unwrap();
    let job = guard.as_mut().ok_or("no export running")?;
    let stdin = job.stdin.as_mut().ok_or("encoder closed")?;
    stdin.write_all(bytes).map_err(|e| format!("encoder rejected frame: {e}"))
}

#[tauri::command]
pub async fn export_finish(state: State<'_, ExportState>) -> Result<(), String> {
    let job = state.0.lock().unwrap().take();
    let Some(mut job) = job else { return Err("no export running".into()) };
    drop(job.stdin.take());
    let out = tauri::async_runtime::spawn_blocking(move || job.child.wait_with_output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn export_cancel(state: State<ExportState>) {
    if let Some(mut j) = state.0.lock().unwrap().take() {
        let _ = j.child.kill();
    }
}
