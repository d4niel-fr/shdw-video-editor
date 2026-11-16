//! Audio extraction for sample-accurate playback. WebKit's `decodeAudioData` rejects some audio
//! (HE-AAC in MP4, for example) and stalls `fetch()` of video/* responses, so the editor asks ffmpeg to
//! turn a media file's audio into a cached 48 kHz stereo WAV that WebAudio always decodes.

use crate::{security, tools};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Stable cache name for one version of a source file (path + size + modified time).
pub fn cache_key(path: &str, len: u64, modified_secs: u64) -> String {
    let digest = Sha256::digest(format!("{path}\u{0}{len}\u{0}{modified_secs}").as_bytes());
    // lowercase hex of the first 16 bytes
    security::token_from_bytes(&digest[..16])
}

/// ffmpeg arguments that write `input`'s audio as 48 kHz stereo 16-bit PCM WAV to `output`.
pub fn extract_args(input: &Path, output: &Path) -> Vec<String> {
    let p = |x: &Path| x.to_string_lossy().to_string();
    ["-hide_banner", "-loglevel", "error", "-y", "-i", &p(input), "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", &p(output)]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn cache_dir() -> PathBuf {
    tools::app_data_dir().join("audio-cache")
}

/// Extract (or reuse) the audio of `path` as a WAV in the app cache and return its path.
#[tauri::command]
pub async fn extract_audio(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // only real media files outside hidden folders (the webview is a privileged caller)
        let src = security::resolve_media(Path::new("/"), &path)?;
        let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let dir = cache_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("{}.wav", cache_key(&src.to_string_lossy(), meta.len(), modified)));
        if std::fs::metadata(&out).map(|m| m.len() > 44).unwrap_or(false) {
            return Ok(out.to_string_lossy().to_string());
        }
        let part = out.with_extension("part");
        let _ = std::fs::remove_file(&part);
        let o = tools::cmd(tools::ffmpeg()?).args(extract_args(&src, &part)).output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            let _ = std::fs::remove_file(&part);
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_32_hex_and_changes_with_the_source() {
        let a = cache_key("/m/a.mp4", 100, 5);
        assert_eq!(a, cache_key("/m/a.mp4", 100, 5));
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, cache_key("/m/a.mp4", 101, 5), "size changed");
        assert_ne!(a, cache_key("/m/a.mp4", 100, 6), "modified time changed");
        assert_ne!(a, cache_key("/m/b.mp4", 100, 5), "different file");
    }

    #[test]
    fn extract_args_write_48k_stereo_pcm_from_the_input_only() {
        let a = extract_args(Path::new("/m/in.mp4"), Path::new("/c/out.part"));
        let pos = |f: &str| a.iter().position(|x| x == f).unwrap_or_else(|| panic!("{f} missing in {a:?}"));
        assert_eq!(a[pos("-i") + 1], "/m/in.mp4");
        assert!(a.contains(&"-vn".to_string()), "no video");
        assert_eq!(a[pos("-ac") + 1], "2");
        assert_eq!(a[pos("-ar") + 1], "48000");
        assert_eq!(a[pos("-c:a") + 1], "pcm_s16le");
        assert_eq!(a[pos("-f") + 1], "wav", "output name has no .wav extension, so the muxer must be explicit");
        assert_eq!(a.last().map(String::as_str), Some("/c/out.part"));
    }
}
