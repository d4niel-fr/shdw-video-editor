//! `media://` URI scheme: serves local files to the webview with CORS and HTTP
//! byte-range support so <video> can seek and WebGL can sample frames without
//! tainting. URL form: http://media.localhost/<encodeURIComponent(absPath)>
//! Live HTML preview form: http://media.localhost/live/C:/dir/motion/x.html —
//! path-style so relative URLs inside compositions resolve; HTML gets the shdw
//! runtime injected ahead of any page script.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{Request, Response, StatusCode};

const CHUNK: u64 = 4 * 1024 * 1024;

fn percent_decode(s: &str) -> String {
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
    String::from_utf8_lossy(&out).to_string()
}

fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css",
        _ => "application/octet-stream",
    }
}

fn err(code: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

pub fn serve(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = req.uri().path().trim_start_matches('/');
    let live = raw.starts_with("live/");
    let path = percent_decode(if live { &raw[5..] } else { raw });
    let mut f = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return err(StatusCode::NOT_FOUND, "not found"),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ty = mime(&path);
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());

    let base = || {
        Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-cache")
            .header("Content-Type", ty)
    };

    if let Some(r) = range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        let mut it = r.splitn(2, '-');
        let s = it.next().unwrap_or("");
        let e = it.next().unwrap_or("");
        let (start, end) = if s.is_empty() {
            let n: u64 = e.parse().unwrap_or(0).min(len);
            (len - n, len.saturating_sub(1))
        } else {
            let st: u64 = s.parse().unwrap_or(0);
            let en: u64 = if e.is_empty() { (st + CHUNK - 1).min(len.saturating_sub(1)) } else { e.parse::<u64>().unwrap_or(len - 1).min(len.saturating_sub(1)) };
            (st, en)
        };
        if start >= len || end < start {
            return base()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{len}"))
                .body(vec![])
                .unwrap();
        }
        let n = end - start + 1;
        let mut buf = vec![0u8; n as usize];
        if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
        }
        return base()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("Content-Range", format!("bytes {start}-{end}/{len}"))
            .header("Content-Length", n.to_string())
            .body(buf)
            .unwrap();
    }

    let mut buf = Vec::with_capacity(len as usize);
    if f.read_to_end(&mut buf).is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
    }
    if live && ty.starts_with("text/html") {
        // after <!doctype ...> so the page stays in standards mode
        let head = String::from_utf8_lossy(&buf[..buf.len().min(64)]).trim_start().to_ascii_lowercase();
        let at = if head.starts_with("<!doctype") { buf.iter().position(|&b| b == b'>').map(|i| i + 1).unwrap_or(0) } else { 0 };
        let mut out = buf[..at].to_vec();
        out.extend_from_slice(format!("<script>{}</script>", crate::html::RUNTIME).as_bytes());
        out.extend_from_slice(&buf[at..]);
        let n = out.len();
        return base().status(StatusCode::OK).header("Content-Length", n.to_string()).body(out).unwrap();
    }
    base().status(StatusCode::OK).header("Content-Length", len.to_string()).body(buf).unwrap()
}
