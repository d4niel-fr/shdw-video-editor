//! Security helpers for the control API, file jail, media protocol and agent CLI
//! arguments. Deliberately free of Tauri types so every rule is unit-testable
//! with plain `rustc --test`.
#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};

/// Header carrying the per-launch control-API token.
pub const TOKEN_HEADER: &str = "x-shdw-token";

const OUTPUT_EXTS: &[&str] = &["png", "jpg", "jpeg", "mp4", "m4v", "mov", "mkv", "webm", "gif"];
const IMPORT_EXTS: &[&str] = &[
    // video
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "mxf", "mts", "m2ts", "wmv", "flv", "3gp", "ts", "mpg", "mpeg",
    // audio
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff", "wma",
    // image
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif",
];
/// Everything the webview legitimately loads through `media://` (mirrors the MIME table).
const SERVABLE_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "png", "jpg", "jpeg", "gif",
    "webp", "svg", "ttf", "otf", "woff", "woff2", "js", "mjs", "json", "html", "htm", "css",
];

const PRIVATE_DIR: &str = ".shdw";
/// Inside `.shdw` only cached media may be served, never `token`, `port` or `chat.json`.
const PRIVATE_DIR_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "mp4", "m4v", "mov", "webm", "mkv", "mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"];

/// Source of the control-API helper the editor installs outside every project folder.
pub const API_HELPER_SCRIPT: &str = r#"#!/bin/sh
# shdw control-API helper (installed by the editor; do not edit).
#   shdw-api GET /state
#   shdw-api POST /export '{"out":"renders/final.mp4","codec":"h264"}'
# Run it from the project folder. It reads the per-launch token and port from ./.shdw/
# and only ever talks to 127.0.0.1.
set -eu
method="${1:-}"; path="${2:-}"; body="${3:-}"
case "$method" in GET|POST) ;; *) echo "shdw-api: method must be GET or POST" >&2; exit 2 ;; esac
case "$path" in /*) ;; *) echo "shdw-api: path must start with /" >&2; exit 2 ;; esac
if [ ! -r .shdw/token ] || [ ! -r .shdw/port ]; then
  echo "shdw-api: run from a shdw project folder while the editor is open" >&2; exit 2
fi
token="$(cat .shdw/token)"; port="$(cat .shdw/port)"
case "$port" in ''|*[!0-9]*) echo "shdw-api: bad .shdw/port" >&2; exit 2 ;; esac
if [ -n "$body" ]; then
  exec curl -sS --max-time 1800 -X "$method" -H "X-Shdw-Token: $token" -H "Content-Type: application/json" --data-raw "$body" "http://127.0.0.1:$port$path"
fi
exec curl -sS --max-time 1800 -X "$method" -H "X-Shdw-Token: $token" "http://127.0.0.1:$port$path"
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    /// Host header is not the loopback address:port we listen on (DNS rebinding).
    BadHost,
    /// Request came from a browser context (Origin / Sec-Fetch-Site present).
    BrowserOrigin,
    /// Token missing or wrong.
    Unauthorized,
}

impl Denied {
    pub fn status(self) -> u16 {
        match self {
            Denied::Unauthorized => 401,
            Denied::BadHost | Denied::BrowserOrigin => 403,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Denied::BadHost => "host not allowed",
            Denied::BrowserOrigin => "browser-originated requests are not allowed",
            Denied::Unauthorized => "missing or invalid X-Shdw-Token",
        }
    }
}

/// Header values of one request, as seen by the control server.
#[derive(Debug, Default, Clone, Copy)]
pub struct Meta<'a> {
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub sec_fetch_site: Option<&'a str>,
    pub token: Option<&'a str>,
    pub authorization: Option<&'a str>,
}

pub fn token_from_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn check_host(host: Option<&str>, port: u16) -> Result<(), Denied> {
    let host = host.ok_or(Denied::BadHost)?.to_ascii_lowercase();
    if host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}") {
        Ok(())
    } else {
        Err(Denied::BadHost)
    }
}

fn bearer(authorization: Option<&str>) -> Option<&str> {
    let (scheme, value) = authorization?.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| value.trim())
}

pub fn check_request(m: &Meta, expected_token: &str, port: u16) -> Result<(), Denied> {
    check_host(m.host, port)?;
    // browsers always label cross-site traffic; curl and agents never do
    if m.origin.is_some() || m.sec_fetch_site.is_some() {
        return Err(Denied::BrowserOrigin);
    }
    let presented = m.token.or_else(|| bearer(m.authorization)).ok_or(Denied::Unauthorized)?;
    if expected_token.is_empty() || !constant_time_eq(presented.as_bytes(), expected_token.as_bytes()) {
        return Err(Denied::Unauthorized);
    }
    Ok(())
}

/// Resolve `candidate` (absolute or relative to `root`) and prove the result stays
/// inside `root` after `..` collapsing and symlink resolution.
pub fn resolve_within(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    if candidate.is_empty() || candidate.contains('\0') {
        return Err("invalid path".into());
    }
    let root_c = std::fs::canonicalize(root).map_err(|e| format!("project folder: {e}"))?;
    let cand = candidate.replace('\\', "/");
    let p = Path::new(&cand);
    let joined = if p.is_absolute() { p.to_path_buf() } else { root_c.join(p) };

    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("path escapes the project folder".into());
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }

    // canonicalise the deepest part that exists (resolves symlinks), then re-append the rest
    let mut existing = normalized;
    let mut tail = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        let name = existing.file_name().ok_or("invalid path")?.to_owned();
        tail.push(name);
        if !existing.pop() {
            return Err("invalid path".into());
        }
    }
    let mut out = std::fs::canonicalize(&existing).map_err(|_| "path cannot be resolved (dangling link?)".to_string())?;
    out.extend(tail.iter().rev());
    if out.starts_with(&root_c) {
        Ok(out)
    } else {
        Err("path escapes the project folder".into())
    }
}

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| list.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Resolve a control-API *output* path (frames, exports): must stay inside the project
/// folder and use a media extension.
pub fn resolve_output(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    let p = resolve_within(root, candidate)?;
    if !output_ext_allowed(&p) {
        return Err(format!("output extension not allowed (use one of: {})", OUTPUT_EXTS.join(", ")));
    }
    Ok(p)
}

/// Resolve a control-API *import* path: relative paths stay inside the project; absolute
/// paths may point anywhere but must be an existing media file outside hidden folders.
pub fn resolve_media(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    if candidate.is_empty() || candidate.contains('\0') {
        return Err("invalid path".into());
    }
    let cand = candidate.replace('\\', "/");
    let wanted = if Path::new(&cand).is_absolute() { PathBuf::from(&cand) } else { resolve_within(root, &cand)? };
    // canonicalise first so the checks below apply to the symlink *target*
    let canon = std::fs::canonicalize(&wanted).map_err(|e| format!("{candidate}: {e}"))?;
    if !canon.is_file() {
        return Err(format!("{candidate}: not a file"));
    }
    if !import_ext_allowed(&canon) {
        return Err(format!("{candidate}: media extension not allowed"));
    }
    if has_hidden_component(&canon) {
        return Err(format!("{candidate}: hidden folders cannot be imported"));
    }
    Ok(canon)
}

pub fn output_ext_allowed(path: &Path) -> bool {
    ext_in(path, OUTPUT_EXTS)
}

pub fn import_ext_allowed(path: &Path) -> bool {
    ext_in(path, IMPORT_EXTS)
}

fn hidden_segment(s: &str) -> bool {
    s.replace('\\', "/").split('/').any(|seg| seg.starts_with('.'))
}

pub fn has_hidden_component(path: &Path) -> bool {
    hidden_segment(&path.to_string_lossy())
}

/// May the `media://` protocol serve this (already canonicalised) path?
pub fn is_servable(path: &Path) -> bool {
    is_servable_with(path, None)
}

/// Like [`is_servable`], but `allow_prefix` (the app-data dir, which lives under a hidden
/// folder on Linux) is exempt from the hidden-folder rule.
pub fn is_servable_with(path: &Path, allow_prefix: Option<&Path>) -> bool {
    let checked = match allow_prefix.and_then(|p| path.strip_prefix(p).ok()) {
        Some(rest) => rest.to_string_lossy().replace('\\', "/"),
        None => path.to_string_lossy().replace('\\', "/"),
    };
    let mut in_private = false;
    for seg in checked.split('/').filter(|s| s.starts_with('.')) {
        // `.shdw` is the project's private cache (thumbs, proxies); every other hidden folder is off limits
        if seg != PRIVATE_DIR {
            return false;
        }
        in_private = true;
    }
    ext_in(path, if in_private { PRIVATE_DIR_EXTS } else { SERVABLE_EXTS })
}

/// Remote hosts compositions may load libraries, styles and fonts from (documented in the
/// agent guide). Everything else, including raw IP addresses, is unreachable.
pub const CDN_HOSTS: &[&str] = &["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

/// Chrome `--proxy-bypass-list` value: with a dead `--proxy-server`, only these hosts connect.
pub fn chrome_proxy_bypass() -> String {
    ["localhost", "127.0.0.1"].iter().chain(CDN_HOSTS).copied().collect::<Vec<_>>().join(";")
}

/// `Content-Security-Policy` for live HTML compositions in the editor webview.
pub fn live_csp() -> String {
    let cdn: Vec<String> = CDN_HOSTS.iter().map(|h| format!("https://{h}")).collect();
    format!(
        "default-src media: http://media.localhost https://media.localhost data: blob: {} 'unsafe-inline' 'unsafe-eval'; form-action 'none'",
        cdn.join(" ")
    )
}

pub fn claude_args(skip_permissions: bool, session_id: Option<&str>, model: Option<&str>, extra_dirs: &[String], api_helper: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].map(String::from).to_vec();
    if skip_permissions {
        a.push("--dangerously-skip-permissions".into());
    } else {
        a.extend(["--permission-mode".to_string(), "acceptEdits".to_string()]);
    }
    if let Some(s) = session_id {
        a.extend(["--resume".to_string(), s.to_string()]);
    }
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        a.extend(["--model".to_string(), m.to_string()]);
    }
    for d in extra_dirs {
        a.extend(["--add-dir".to_string(), d.clone()]);
    }
    if !skip_permissions && !api_helper.is_empty() {
        // Edits/reads stay inside the project via --permission-mode acceptEdits. The only shell
        // command allowed is the helper, which lives outside the project so the agent cannot rewrite it.
        a.push("--allowedTools".into());
        a.push(format!("Bash({api_helper} *)"));
    }
    a
}

pub fn codex_args(skip_permissions: bool, session_id: Option<&str>, model: Option<&str>, cwd: &str) -> Vec<String> {
    let mut a = vec!["exec".to_string()];
    if let Some(s) = session_id {
        a.extend(["resume".to_string(), s.to_string()]);
    }
    a.extend(["--json".to_string(), "--skip-git-repo-check".to_string()]);
    a.push(if skip_permissions { "--dangerously-bypass-approvals-and-sandbox" } else { "--full-auto" }.into());
    if session_id.is_none() {
        a.extend(["-C".to_string(), cwd.to_string()]);
    }
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        a.extend(["-m".to_string(), m.to_string()]);
    }
    a.push("-".into());
    a
}

#[derive(Debug, PartialEq, Eq)]
pub struct WhisperModel {
    pub file: String,
    pub sha256: &'static str,
}

/// Only models with a pinned SHA-256 may be downloaded; the name never reaches a path unchecked.
/// Digests are the `x-linked-etag` published by huggingface.co/ggerganov/whisper.cpp (2026-11-15).
pub fn whisper_model(name: &str) -> Option<WhisperModel> {
    let sha256 = match name {
        "tiny" => "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        "base" => "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        "small" => "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        "medium" => "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        "large-v3-turbo" => "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        _ => return None,
    };
    Some(WhisperModel { file: format!("ggml-{name}.bin"), sha256 })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 47800;
    const HELPER: &str = "/home/u/.shdw/bin/shdw-api";
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn meta<'a>() -> Meta<'a> {
        Meta { host: Some("127.0.0.1:47800"), token: Some(TOKEN), ..Meta::default() }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shdw-sec-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ---------- token / constant-time compare ----------

    #[test]
    fn token_is_lowercase_hex_of_every_byte() {
        assert_eq!(token_from_bytes(&[0x00, 0xff, 0x0a, 0xb1]), "00ff0ab1");
        assert_eq!(token_from_bytes(&[0u8; 32]).len(), 64);
    }

    #[test]
    fn constant_time_eq_matches_only_identical_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
    }

    // ---------- control API request checks ----------

    #[test]
    fn accepts_loopback_ip_host_with_correct_token() {
        assert_eq!(check_request(&meta(), TOKEN, PORT), Ok(()));
    }

    #[test]
    fn accepts_localhost_host_case_insensitively() {
        let m = Meta { host: Some("LocalHost:47800"), ..meta() };
        assert_eq!(check_request(&m, TOKEN, PORT), Ok(()));
    }

    #[test]
    fn rejects_dns_rebinding_hosts() {
        for h in ["evil.example:47800", "127.0.0.1.evil.com:47800", "127.0.0.1:47801", "127.0.0.1", "localhost.evil.com:47800", ""] {
            let m = Meta { host: Some(h), ..meta() };
            assert_eq!(check_request(&m, TOKEN, PORT), Err(Denied::BadHost), "host {h:?}");
        }
        let m = Meta { host: None, ..meta() };
        assert_eq!(check_request(&m, TOKEN, PORT), Err(Denied::BadHost));
    }

    #[test]
    fn rejects_any_browser_origin_even_with_valid_token() {
        for o in ["http://evil.example", "null", "http://127.0.0.1:47800"] {
            let m = Meta { origin: Some(o), ..meta() };
            assert_eq!(check_request(&m, TOKEN, PORT), Err(Denied::BrowserOrigin), "origin {o:?}");
        }
    }

    #[test]
    fn rejects_requests_carrying_sec_fetch_site() {
        let m = Meta { sec_fetch_site: Some("cross-site"), ..meta() };
        assert_eq!(check_request(&m, TOKEN, PORT), Err(Denied::BrowserOrigin));
    }

    #[test]
    fn rejects_missing_or_wrong_token() {
        let none = Meta { token: None, ..meta() };
        assert_eq!(check_request(&none, TOKEN, PORT), Err(Denied::Unauthorized));
        let wrong = Meta { token: Some("nope"), ..meta() };
        assert_eq!(check_request(&wrong, TOKEN, PORT), Err(Denied::Unauthorized));
        let longer = Meta { token: Some(&format!("{TOKEN}0")), ..meta() };
        assert_eq!(check_request(&longer, TOKEN, PORT), Err(Denied::Unauthorized));
    }

    #[test]
    fn never_authorises_when_server_token_is_empty() {
        let m = Meta { token: Some(""), ..meta() };
        assert_eq!(check_request(&m, "", PORT), Err(Denied::Unauthorized));
    }

    #[test]
    fn accepts_bearer_authorization_header() {
        let m = Meta { token: None, authorization: Some(&format!("Bearer {TOKEN}")), ..meta() };
        assert_eq!(check_request(&m, TOKEN, PORT), Ok(()));
        let lower = Meta { token: None, authorization: Some(&format!("bearer {TOKEN}")), ..meta() };
        assert_eq!(check_request(&lower, TOKEN, PORT), Ok(()));
    }

    #[test]
    fn rejects_non_bearer_authorization_schemes() {
        let m = Meta { token: None, authorization: Some(&format!("Basic {TOKEN}")), ..meta() };
        assert_eq!(check_request(&m, TOKEN, PORT), Err(Denied::Unauthorized));
    }

    #[test]
    fn host_check_alone_ignores_token() {
        assert_eq!(check_host(Some("127.0.0.1:47800"), PORT), Ok(()));
        assert_eq!(check_host(Some("attacker.test:47800"), PORT), Err(Denied::BadHost));
    }

    #[test]
    fn denied_maps_to_http_statuses() {
        assert_eq!(Denied::Unauthorized.status(), 401);
        assert_eq!(Denied::BadHost.status(), 403);
        assert_eq!(Denied::BrowserOrigin.status(), 403);
        assert!(!Denied::Unauthorized.message().is_empty());
    }

    // ---------- path jail ----------

    #[test]
    fn resolves_relative_path_inside_root() {
        let root = tmp("rel");
        std::fs::create_dir_all(root.join("renders")).unwrap();
        let got = resolve_within(&root, "renders/x.png").unwrap();
        assert!(got.starts_with(std::fs::canonicalize(&root).unwrap()));
        assert!(got.ends_with("renders/x.png"));
    }

    #[test]
    fn collapses_dotdot_that_stays_inside_root() {
        let root = tmp("dotdot-ok");
        std::fs::create_dir_all(root.join("renders")).unwrap();
        let got = resolve_within(&root, "renders/../media/a.png").unwrap();
        assert!(got.ends_with("media/a.png"));
        assert!(!got.to_string_lossy().contains(".."));
    }

    #[test]
    fn rejects_dotdot_escape_variants() {
        let root = tmp("dotdot-bad");
        for c in ["../outside.png", "renders/../../x.png", "a/b/../../../x.png", "..\\..\\x.png", "./../x.png"] {
            assert!(resolve_within(&root, c).is_err(), "should reject {c:?}");
        }
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let root = tmp("abs-out");
        assert!(resolve_within(&root, "/etc/passwd").is_err());
        assert!(resolve_within(&root, "/tmp/other.png").is_err());
    }

    #[test]
    fn accepts_absolute_path_inside_root() {
        let root = tmp("abs-in");
        let inside = root.join("renders").join("f.png");
        assert!(resolve_within(&root, inside.to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_sibling_directory_sharing_the_root_prefix() {
        let base = tmp("sibling");
        let root = base.join("proj");
        let evil = base.join("proj-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        assert!(resolve_within(&root, evil.join("x.png").to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_empty_and_nul_paths() {
        let root = tmp("empty");
        assert!(resolve_within(&root, "").is_err());
        assert!(resolve_within(&root, "a\0b.png").is_err());
    }

    #[test]
    fn dot_resolves_to_the_root_itself() {
        let root = tmp("dot");
        assert_eq!(resolve_within(&root, ".").unwrap(), std::fs::canonicalize(&root).unwrap());
    }

    #[test]
    fn accepts_deep_nonexistent_paths_inside_root() {
        let root = tmp("deep");
        assert!(resolve_within(&root, "a/b/c/d.png").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_that_escapes_the_root() {
        let base = tmp("symlink");
        let root = base.join("proj");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(resolve_within(&root, "link/evil.png").is_err());
        assert!(resolve_within(&root, "link").is_err());
    }

    // ---------- control-API path resolvers ----------

    #[test]
    fn output_paths_must_be_in_project_with_media_extension() {
        let root = tmp("out");
        assert!(resolve_output(&root, "renders/x.png").unwrap().ends_with("renders/x.png"));
        assert!(resolve_output(&root, "renders/final.MP4").is_ok());
        assert!(resolve_output(&root, "renders/x.sh").unwrap_err().contains("extension"));
        assert!(resolve_output(&root, "../x.png").is_err());
        assert!(resolve_output(&root, "/tmp/elsewhere.png").is_err());
    }

    #[test]
    fn media_relative_paths_stay_in_project_and_must_exist() {
        let root = tmp("media-rel");
        std::fs::create_dir_all(root.join("media")).unwrap();
        std::fs::write(root.join("media/clip.mp4"), b"x").unwrap();
        let got = resolve_media(&root, "media/clip.mp4").unwrap();
        assert_eq!(got, std::fs::canonicalize(root.join("media/clip.mp4")).unwrap());
        assert!(resolve_media(&root, "media/missing.mp4").is_err());
        assert!(resolve_media(&root, "../x.mp4").is_err());
        assert!(resolve_media(&root, "media").is_err(), "a directory is not a file");
    }

    #[test]
    fn media_absolute_paths_may_live_anywhere_but_only_as_media_files() {
        let base = tmp("media-abs");
        let root = base.join("proj");
        let other = base.join("footage");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("shot.mov"), b"x").unwrap();
        std::fs::write(other.join("notes.txt"), b"x").unwrap();
        assert!(resolve_media(&root, other.join("shot.mov").to_str().unwrap()).is_ok());
        assert!(resolve_media(&root, other.join("notes.txt").to_str().unwrap()).unwrap_err().contains("extension"));
    }

    #[test]
    fn media_refuses_hidden_folders() {
        let base = tmp("media-hidden");
        let root = base.join("proj");
        std::fs::create_dir_all(base.join(".ssh")).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join(".ssh/looks_like.png"), b"x").unwrap();
        assert!(resolve_media(&root, base.join(".ssh/looks_like.png").to_str().unwrap()).unwrap_err().contains("hidden"));
    }

    #[cfg(unix)]
    #[test]
    fn media_extension_is_checked_on_the_symlink_target() {
        let base = tmp("media-link");
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("secret"), b"top secret").unwrap();
        std::os::unix::fs::symlink(base.join("secret"), root.join("innocent.mp4")).unwrap();
        assert!(resolve_media(&root, "innocent.mp4").is_err());
        assert!(resolve_media(&root, root.join("innocent.mp4").to_str().unwrap()).is_err());
    }

    // ---------- extension allow-lists ----------

    #[test]
    fn output_allows_only_media_extensions() {
        for ok in ["renders/a.png", "x.MP4", "a.mov", "a.webm", "a.gif", "a.jpg", "a.mkv", "a.m4v"] {
            assert!(output_ext_allowed(Path::new(ok)), "{ok}");
        }
        for bad in ["a.sh", "a", ".zshrc", "a.plist", "a.command", "a.py", "a.html", "a.json", "a.png.sh", "a."] {
            assert!(!output_ext_allowed(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn import_allows_only_video_audio_image_extensions() {
        for ok in ["a.mp4", "a.WAV", "a.png", "a.mkv", "a.flac", "a.svg"] {
            assert!(import_ext_allowed(Path::new(ok)), "{ok}");
        }
        for bad in ["id_rsa", "a.pem", "a.sh", "a.txt", "a.json", "credentials", ".env"] {
            assert!(!import_ext_allowed(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn detects_hidden_path_components() {
        assert!(has_hidden_component(Path::new("/Users/a/.ssh/key.png")));
        assert!(has_hidden_component(Path::new("/Users/a/proj/.shdw/token")));
        assert!(has_hidden_component(Path::new("C:\\Users\\a\\.aws\\x.png")));
        assert!(has_hidden_component(Path::new("/a/../b")));
        assert!(!has_hidden_component(Path::new("/Users/a/proj/media/clip.mp4")));
        assert!(!has_hidden_component(Path::new("/Users/a/Library/Application Support/shdw/x.png")));
    }

    // ---------- media protocol allow-list ----------

    #[test]
    fn media_protocol_serves_project_media_and_compositions() {
        for ok in ["/Users/a/proj/media/clip.mp4", "/Users/a/proj/motion/title.html", "/Users/a/proj/fonts/Inter.ttf", "/Users/a/p/CLIP.MP4",
            "/Users/a/proj/.shdw/thumbs/m1/thumb_0001.jpg", "/Users/a/proj/.shdw/proxy/m1.mp4"] {
            assert!(is_servable(Path::new(ok)), "{ok}");
        }
    }

    #[test]
    fn media_protocol_refuses_secrets_and_unknown_types() {
        for bad in [
            "/Users/a/.ssh/id_rsa",
            "/Users/a/.ssh/looks_like.png",
            "/Users/a/proj/.shdw/token",
            "/Users/a/proj/notes.pem",
            "/Users/a/proj/noext",
            "/etc/passwd",
            "/Users/a/Library/Keychains/login.keychain-db",
            "/Users/a/proj/../.aws/credentials.json",
            "/Users/a/proj/.shdw/chat.json",
            "/Users/a/proj/.shdw/port",
            "/Users/a/.ssh/.shdw/x.png",
        ] {
            assert!(!is_servable(Path::new(bad)), "{bad}");
        }
    }

    // ---------- composition network policy ----------

    #[test]
    fn proxy_bypass_lists_loopback_and_known_cdns_only() {
        let list = chrome_proxy_bypass();
        let hosts: Vec<&str> = list.split(';').collect();
        assert!(hosts.contains(&"localhost") && hosts.contains(&"127.0.0.1"));
        for h in CDN_HOSTS {
            assert!(hosts.contains(h), "{h} missing");
        }
        assert_eq!(hosts.len(), CDN_HOSTS.len() + 2, "no extra entries");
        assert!(hosts.iter().all(|h| !h.contains('*') && !h.is_empty()), "no wildcards: {list}");
    }

    #[test]
    fn live_csp_allows_only_local_content_and_listed_cdns() {
        let csp = live_csp();
        for h in CDN_HOSTS {
            assert!(csp.contains(&format!("https://{h}")), "{h} missing");
        }
        let default_src = csp.split(';').map(str::trim).find(|d| d.starts_with("default-src")).unwrap();
        for tok in default_src.split_whitespace().skip(1) {
            assert!(!matches!(tok, "*" | "http:" | "https:" | "ws:" | "wss:"), "too broad: {tok}");
        }
        assert!(csp.contains("form-action 'none'"));
        assert!(!csp.contains("connect-src *"));
    }

    // ---------- control-API helper script ----------

    #[test]
    fn helper_script_is_a_loopback_only_posix_sh_script() {
        let sh = API_HELPER_SCRIPT;
        assert!(sh.starts_with("#!/bin/sh\n"));
        assert!(sh.contains("set -eu"));
        assert!(sh.contains("http://127.0.0.1:"));
        assert!(sh.contains("--data-raw"), "@file bodies must not be read");
        assert!(!sh.contains("--data-binary") && !sh.contains("eval "));
        assert!(sh.contains("GET|POST"));
    }

    #[cfg(unix)]
    fn run_helper(dir: &Path, args: &[&str]) -> (i32, String, String) {
        let script = dir.join("shdw-api");
        std::fs::write(&script, API_HELPER_SCRIPT).unwrap();
        let out = std::process::Command::new("sh").arg(&script).args(args).current_dir(dir).output().unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }

    #[cfg(unix)]
    #[test]
    fn helper_script_has_valid_shell_syntax() {
        let dir = tmp("helper-syntax");
        let script = dir.join("shdw-api");
        std::fs::write(&script, API_HELPER_SCRIPT).unwrap();
        let st = std::process::Command::new("sh").arg("-n").arg(&script).status().unwrap();
        assert!(st.success());
    }

    #[cfg(unix)]
    #[test]
    fn helper_script_rejects_bad_arguments_and_missing_project() {
        let dir = tmp("helper-args");
        std::fs::create_dir_all(dir.join(".shdw")).unwrap();
        std::fs::write(dir.join(".shdw/token"), "tok").unwrap();
        std::fs::write(dir.join(".shdw/port"), "47800").unwrap();
        assert_eq!(run_helper(&dir, &["DELETE", "/state"]).0, 2);
        assert_eq!(run_helper(&dir, &["GET", "state"]).0, 2);
        assert_eq!(run_helper(&dir, &["GET", "http://evil.example/"]).0, 2);
        std::fs::write(dir.join(".shdw/port"), "47800; rm -rf /").unwrap();
        assert_eq!(run_helper(&dir, &["GET", "/state"]).0, 2, "port must be digits only");
        let empty = tmp("helper-empty");
        assert_eq!(run_helper(&empty, &["GET", "/state"]).0, 2);
    }

    #[cfg(unix)]
    #[test]
    fn helper_script_sends_token_and_body_to_loopback_only() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut sock = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(_) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
                    Err(_) => return String::from("(no connection)"),
                }
            };
            sock.set_nonblocking(false).unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
            req
        });
        let dir = tmp("helper-live");
        std::fs::create_dir_all(dir.join(".shdw")).unwrap();
        std::fs::write(dir.join(".shdw/token"), "sekret-token").unwrap();
        std::fs::write(dir.join(".shdw/port"), port.to_string()).unwrap();
        let (code, out, err) = run_helper(&dir, &["POST", "/export", "{\"out\":\"renders/a.mp4\"}"]);
        let req = server.join().unwrap();
        assert_eq!(code, 0, "stderr: {err}");
        assert_eq!(out, "{\"ok\":true}");
        assert!(req.starts_with("POST /export HTTP/1.1"), "{req}");
        assert!(req.to_lowercase().contains("x-shdw-token: sekret-token"), "{req}");
        assert!(req.contains("{\"out\":\"renders/a.mp4\"}"), "{req}");
        assert!(req.contains(&format!("Host: 127.0.0.1:{port}")), "{req}");
    }

    // ---------- agent CLI arguments ----------

    fn has(args: &[String], flag: &str) -> bool {
        args.iter().any(|a| a == flag)
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    #[test]
    fn claude_defaults_never_skip_permissions() {
        let a = claude_args(false, None, None, &[], HELPER);
        assert!(!has(&a, "--dangerously-skip-permissions"));
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
        assert!(has(&a, "--allowedTools"));
        assert!(has(&a, "-p"));
    }

    #[test]
    fn claude_safe_mode_allows_only_the_api_helper() {
        let a = claude_args(false, None, None, &[], HELPER);
        let i = a.iter().position(|x| x == "--allowedTools").unwrap();
        let tools: Vec<&str> = a[i + 1..].iter().take_while(|x| !x.starts_with("--")).map(String::as_str).collect();
        // file access comes from --permission-mode acceptEdits (project folder only); a bare
        // Read/Edit/Write rule would widen it to the whole disk, and curl/cat/ls rules are bypassable
        assert_eq!(tools, vec![format!("Bash({HELPER} *)")]);
    }

    #[test]
    fn claude_safe_mode_without_a_helper_grants_no_shell_at_all() {
        let a = claude_args(false, None, None, &[], "");
        assert!(!has(&a, "--allowedTools"), "an empty helper path must not produce a Bash( *) rule");
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
    }

    #[test]
    fn claude_explicit_opt_in_skips_permissions_and_drops_mode_flags() {
        let a = claude_args(true, None, None, &[], HELPER);
        assert!(has(&a, "--dangerously-skip-permissions"));
        assert!(!has(&a, "--permission-mode"));
        assert!(!has(&a, "--allowedTools"));
    }

    #[test]
    fn claude_passes_session_model_and_extra_dirs() {
        let a = claude_args(false, Some("sess-1"), Some("opus"), &["/x".to_string(), "/y".to_string()], HELPER);
        assert_eq!(value_after(&a, "--resume"), Some("sess-1"));
        assert_eq!(value_after(&a, "--model"), Some("opus"));
        assert_eq!(a.iter().filter(|x| x.as_str() == "--add-dir").count(), 2);
        let empty = claude_args(false, None, Some(""), &[], HELPER);
        assert!(!has(&empty, "--model"), "empty model means default");
    }

    #[test]
    fn codex_defaults_to_sandboxed_full_auto() {
        let a = codex_args(false, None, None, "/proj");
        assert!(has(&a, "--full-auto"));
        assert!(!has(&a, "--dangerously-bypass-approvals-and-sandbox"));
        assert_eq!(value_after(&a, "-C"), Some("/proj"));
        assert_eq!(a.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn codex_opt_in_bypasses_sandbox_and_resume_skips_cwd_flag() {
        let a = codex_args(true, Some("t-9"), Some("gpt-5-codex"), "/proj");
        assert!(has(&a, "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!has(&a, "--full-auto"));
        assert!(!has(&a, "-C"));
        assert_eq!(value_after(&a, "-m"), Some("gpt-5-codex"));
    }

    // ---------- whisper model pinning ----------

    #[test]
    fn whisper_models_are_pinned_to_sha256() {
        for name in ["tiny", "base", "small", "medium", "large-v3-turbo"] {
            let m = whisper_model(name).unwrap_or_else(|| panic!("{name} unpinned"));
            assert_eq!(m.file, format!("ggml-{name}.bin"));
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn whisper_rejects_unknown_and_traversal_names() {
        for bad in ["", "BASE", "base ", "../../etc/x", "base/../x", "large-v2", "tiny.en\0"] {
            assert!(whisper_model(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn app_data_prefix_is_exempt_from_the_hidden_folder_rule() {
        let base = Path::new("/home/u/.local/share/shdw");
        let thumb = Path::new("/home/u/.local/share/shdw/models/x.png");
        assert!(!is_servable(thumb), "hidden parent is refused by default");
        assert!(is_servable_with(thumb, Some(base)));
        // the exemption covers the prefix only, not hidden folders below it
        assert!(!is_servable_with(Path::new("/home/u/.local/share/shdw/.secret/x.png"), Some(base)));
        // and never anything outside the prefix
        assert!(!is_servable_with(Path::new("/home/u/.ssh/x.png"), Some(base)));
    }
}
