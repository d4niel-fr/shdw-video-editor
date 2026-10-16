//! Locating external executables (ffmpeg, ffprobe, claude, codex) and spawning
//! them without flashing console windows on Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a `Command` that never opens a console window.
pub fn cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

fn env_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        dirs.push(local.join("Programs").join("claude"));
    }
    if let Some(app) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app).join("npm"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("scoop").join("shims"));
    }
    dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    // macOS/Linux: GUI apps don't inherit the shell PATH, so add the usual install dirs
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for d in [".local/bin", ".claude/local", ".cargo/bin", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
                dirs.push(home.join(d));
            }
            // newest nvm node first
            if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
                v.sort();
                dirs.extend(v.into_iter().rev());
            }
        }
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"] {
            dirs.push(PathBuf::from(d));
        }
    }
    dirs
}

/// Find an executable by name. Prefers real `.exe` binaries, then `.cmd` shims.
pub fn find(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
    for ext in exts {
        for dir in env_dirs() {
            let p = if ext.is_empty() { dir.join(name) } else { dir.join(format!("{name}.{ext}")) };
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // WinGet package fallback for ffmpeg family
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let pk = PathBuf::from(local).join("Microsoft").join("WinGet").join("Packages");
        if let Ok(rd) = std::fs::read_dir(&pk) {
            for e in rd.flatten() {
                if !e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg") {
                    continue;
                }
                if let Some(p) = search_bin(&e.path(), &format!("{name}.exe"), 3) {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn search_bin(dir: &Path, file: &str, depth: u32) -> Option<PathBuf> {
    let direct = dir.join(file);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        if e.path().is_dir() {
            if let Some(p) = search_bin(&e.path(), file, depth - 1) {
                return Some(p);
            }
        }
    }
    None
}

/// Command for a tool that may be a `.cmd` shim (needs `cmd /C`).
pub fn tool_command(path: &Path) -> Command {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
        let mut c = cmd("cmd");
        c.arg("/C").arg(path);
        c
    } else {
        cmd(path)
    }
}

pub fn ffmpeg() -> Result<PathBuf, String> {
    find("ffmpeg").ok_or_else(|| "ffmpeg not found — install with: winget install Gyan.FFmpeg".into())
}

pub fn ffprobe() -> Result<PathBuf, String> {
    find("ffprobe").ok_or_else(|| "ffprobe not found — install with: winget install Gyan.FFmpeg".into())
}

pub fn version_of(path: &Path) -> Option<String> {
    let out = tool_command(path).arg("--version").output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    s.lines().next().map(|l| l.trim().to_string())
}

pub fn app_data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(if cfg!(target_os = "macos") { "Library/Application Support" } else { ".local/share" })))
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join("shdw");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Put shdw in a Job Object with KILL_ON_JOB_CLOSE: every child (headless render
/// browsers, ffmpeg, agent CLIs) dies with the app, even on crash or force-kill.
#[cfg(windows)]
pub fn kill_children_on_exit() {
    use std::ffi::c_void;
    #[repr(C)]
    struct Basic { per_process_time: i64, per_job_time: i64, flags: u32, min_ws: usize, max_ws: usize, active: u32, affinity: usize, priority: u32, scheduling: u32 }
    #[repr(C)]
    struct Extended { basic: Basic, io: [u64; 6], process_mem: usize, job_mem: usize, peak_process: usize, peak_job: usize }
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *mut c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
    }
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: Extended = std::mem::zeroed();
        info.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, &mut info as *mut _ as *mut c_void, std::mem::size_of::<Extended>() as u32);
        AssignProcessToJobObject(job, GetCurrentProcess());
        // handle deliberately kept open for the app's lifetime; the OS closes it on exit
    }
}

#[cfg(not(windows))]
pub fn kill_children_on_exit() {}

/// Kill a process and everything it spawned (agent CLI shims start node children).
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = cmd("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    #[cfg(not(windows))]
    {
        let _ = cmd("pkill").args(["-KILL", "-P", &pid.to_string()]).status();
        let _ = cmd("kill").args(["-KILL", &pid.to_string()]).status();
    }
}

/// PATH for child processes: the inherited PATH plus the usual install dirs, so a
/// CLI started from a GUI app (no login shell on macOS) still finds node, ffmpeg, git.
pub fn child_path() -> std::ffi::OsString {
    std::env::join_paths(env_dirs()).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}
