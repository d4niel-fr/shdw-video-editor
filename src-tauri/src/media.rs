//! Media operations backed by ffmpeg/ffprobe: probing, thumbnails, waveform
//! peaks, optimized-media proxies, audio mixdown and whisper transcription.

use crate::tools;
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn probe(path: String) -> Result<String, String> {
    let out = tools::cmd(tools::ffprobe()?)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Extract evenly spaced thumbnails into `out_dir` (thumb_0001.jpg ...).
/// Returns the interval in seconds between thumbnails.
#[tauri::command]
pub async fn thumbnails(path: String, out_dir: String, duration: f64) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        let interval = (duration / 80.0).max(0.5);
        let pattern = Path::new(&out_dir).join("thumb_%04d.jpg");
        let st = tools::cmd(tools::ffmpeg()?)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&path)
            .args(["-vf", &format!("fps=1/{interval:.4},scale=-2:90"), "-q:v", "5"])
            .arg(pattern)
            .status()
            .map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("thumbnail extraction failed".into());
        }
        Ok(interval)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Waveform peaks: one byte (0..255) per 10ms of audio, mono.
#[tauri::command]
pub async fn waveform(path: String) -> Result<tauri::ipc::Response, String> {
    let peaks = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut child = tools::cmd(tools::ffmpeg()?)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&path)
            .args(["-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        child.stdout.take().unwrap().read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let _ = child.wait();
        let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        Ok(samples
            .chunks(80)
            .map(|c| {
                let m = c.iter().map(|s| (*s as i32).unsigned_abs()).max().unwrap_or(0);
                ((m as f32 / 32768.0).sqrt() * 255.0).min(255.0) as u8
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(peaks))
}

/// Transcode to an edit-friendly H.264/AAC "optimized media" file.
#[tauri::command]
pub async fn make_proxy(app: AppHandle, id: String, path: String, out: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = Path::new(&out).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let st = tools::cmd(tools::ffmpeg()?)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&path)
            .args([
                "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
            ])
            .arg(&out)
            .status()
            .map_err(|e| e.to_string())?;
        let _ = app.emit("proxy-done", serde_json::json!({ "id": id, "ok": st.success(), "out": out }));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClip {
    path: String,
    source_in: f64,
    start: f64,
    duration: f64,
    volume: f64,
    #[serde(default)]
    pan: f64,
    #[serde(default)]
    fade_in: f64,
    #[serde(default)]
    fade_out: f64,
    #[serde(default = "one")]
    speed: f64,
}
fn one() -> f64 {
    1.0
}

fn atempo_chain(speed: f64) -> String {
    let mut s = speed.clamp(0.0625, 16.0);
    let mut parts = vec![];
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-4 {
        parts.push(format!("atempo={s:.5}"));
    }
    parts.join(",")
}

/// Mix every audible clip of the timeline into one 48 kHz stereo WAV.
#[tauri::command]
pub async fn mixdown(clips: Vec<AudioClip>, total: f64, out: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = tools::cmd(tools::ffmpeg()?);
        c.args(["-hide_banner", "-loglevel", "error", "-y"]);
        let mut graph = String::new();
        let mut labels = String::new();
        for (i, k) in clips.iter().enumerate() {
            c.arg("-i").arg(&k.path);
            let src_len = k.duration * k.speed;
            let mut f = format!(
                "[{i}:a]atrim=start={:.4}:duration={:.4},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo",
                k.source_in, src_len
            );
            let tempo = atempo_chain(k.speed);
            if !tempo.is_empty() {
                f += &format!(",{tempo}");
            }
            f += &format!(",volume={:.4}", k.volume.max(0.0));
            if k.pan.abs() > 0.001 {
                let l = (1.0 - k.pan).min(1.0);
                let r = (1.0 + k.pan).min(1.0);
                f += &format!(",pan=stereo|c0={l:.3}*c0|c1={r:.3}*c1");
            }
            if k.fade_in > 0.0 {
                f += &format!(",afade=t=in:st=0:d={:.4}", k.fade_in);
            }
            if k.fade_out > 0.0 {
                f += &format!(",afade=t=out:st={:.4}:d={:.4}", (k.duration - k.fade_out).max(0.0), k.fade_out);
            }
            let ms = (k.start * 1000.0).round().max(0.0) as i64;
            f += &format!(",adelay={ms}|{ms}[a{i}];");
            graph += &f;
            labels += &format!("[a{i}]");
        }
        let n = clips.len();
        c.args(["-f", "lavfi", "-t", &format!("{total:.4}"), "-i", "anullsrc=r=48000:cl=stereo"]);
        graph += &format!("{labels}[{n}:a]amix=inputs={}:normalize=0:duration=longest[out]", n + 1);
        c.args(["-filter_complex", &graph, "-map", "[out]", "-t", &format!("{total:.4}"), "-c:a", "pcm_s16le"]);
        c.arg(&out);
        let o = c.output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn whisper_model(name: &str) -> Result<PathBuf, String> {
    let dir = tools::app_data_dir().join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("ggml-{name}.bin"));
    if file.is_file() && std::fs::metadata(&file).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(file);
    }
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin");
    let st = tools::cmd("curl.exe")
        .args(["-L", "--fail", "-s", "-o"])
        .arg(&file)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl failed: {e}"))?;
    if !st.success() {
        let _ = std::fs::remove_file(&file);
        return Err(format!("could not download whisper model {name}"));
    }
    Ok(file)
}

/// Speech-to-text via ffmpeg's built-in whisper.cpp filter. Returns JSON lines
/// of segments `{start,end,text}` (seconds).
#[tauri::command]
pub async fn transcribe(app: AppHandle, path: String, model: Option<String>, language: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let model_name = model.unwrap_or_else(|| "base".into());
        let _ = app.emit("transcribe-status", format!("preparing model {model_name}"));
        let model_path = whisper_model(&model_name)?;
        let tmp = std::env::temp_dir().join(format!("shdw_tx_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let esc = |p: &Path| p.to_string_lossy().replace('\\', "/").replace(':', "\\\\:");
        let filter = format!(
            "aresample=16000,aformat=sample_fmts=flt:channel_layouts=mono,whisper=model={}:language={}:queue=3:use_gpu=false:destination={}:format=json",
            esc(&model_path),
            language.unwrap_or_else(|| "auto".into()),
            esc(&tmp)
        );
        let _ = app.emit("transcribe-status", "transcribing");
        let o = tools::cmd(tools::ffmpeg()?)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&path)
            .args(["-vn", "-af", &filter, "-f", "null", "-"])
            .output()
            .map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        let txt = std::fs::read_to_string(&tmp).map_err(|e| format!("no transcript produced: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        let _ = app.emit("transcribe-status", "done");
        Ok(txt)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ffmpeg_stderr(args: &[&str], path: &str, tail: &[&str]) -> Result<String, String> {
    let o = tools::cmd(tools::ffmpeg()?)
        .args(["-hide_banner", "-nostats"])
        .args(args)
        .arg("-i")
        .arg(path)
        .args(tail)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&o.stderr).to_string())
}

/// Shot-change detection (Resolve "Scene Cut Detector"). Returns cut times in seconds.
#[tauri::command]
pub async fn detect_scenes(path: String, threshold: Option<f64>) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let th = threshold.unwrap_or(0.32);
        let vf = format!("scale=320:-2,select='gt(scene,{th})',showinfo");
        let err = ffmpeg_stderr(&[], &path, &["-an", "-vf", &vf, "-f", "null", "-"])?;
        Ok(err
            .lines()
            .filter(|l| l.contains("showinfo") && l.contains("pts_time:"))
            .filter_map(|l| l.split("pts_time:").nth(1)?.split_whitespace().next()?.parse::<f64>().ok())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Silent ranges [start,end] (seconds) below `noise_db` lasting ≥ `min_dur`.
#[tauri::command]
pub async fn detect_silence(path: String, noise_db: Option<f64>, min_dur: Option<f64>) -> Result<Vec<[f64; 2]>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let af = format!("silencedetect=noise={}dB:d={}", noise_db.unwrap_or(-32.0), min_dur.unwrap_or(0.45));
        let err = ffmpeg_stderr(&[], &path, &["-vn", "-af", &af, "-f", "null", "-"])?;
        let mut out = vec![];
        let mut start: Option<f64> = None;
        for l in err.lines() {
            if let Some(v) = l.split("silence_start: ").nth(1) {
                start = v.split_whitespace().next().and_then(|x| x.parse().ok());
            } else if let Some(v) = l.split("silence_end: ").nth(1) {
                if let (Some(s), Some(e)) = (start.take(), v.split_whitespace().next().and_then(|x| x.parse::<f64>().ok())) {
                    out.push([s.max(0.0), e]);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Integrated loudness (LUFS, EBU R128).
#[tauri::command]
pub async fn loudness(path: String) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let err = ffmpeg_stderr(&[], &path, &["-vn", "-af", "ebur128", "-f", "null", "-"])?;
        err.lines()
            .rev()
            .find_map(|l| l.trim().strip_prefix("I:").and_then(|v| v.trim().split_whitespace().next()?.parse::<f64>().ok()))
            .ok_or_else(|| "could not measure loudness".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Generic processing job (stabilize, denoise, reverse, retime…): ffmpeg -i input <args> output.
#[tauri::command]
pub async fn ffmpeg_process(input: String, args: Vec<String>, output: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = Path::new(&output).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let o = tools::cmd(tools::ffmpeg()?)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&input)
            .args(&args)
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        Ok(output)
    })
    .await
    .map_err(|e| e.to_string())?
}
