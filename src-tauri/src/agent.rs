//! Runs Claude Code / Codex CLI sessions inside the project folder and streams
//! their JSON event output to the chat panel.

use crate::tools;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct AgentState(pub Arc<Mutex<HashMap<String, Child>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    run_id: String,
    /// "claude" | "codex"
    provider: String,
    prompt: String,
    cwd: String,
    session_id: Option<String>,
    model: Option<String>,
    skip_permissions: bool,
    #[serde(default)]
    extra_dirs: Vec<String>,
}

#[tauri::command]
pub fn agent_start(app: AppHandle, state: State<AgentState>, req: AgentRequest) -> Result<u32, String> {
    let exe = tools::find(&req.provider).ok_or_else(|| format!("`{}` CLI not found on PATH", req.provider))?;
    let mut c = tools::tool_command(&exe);
    c.current_dir(&req.cwd);
    match req.provider.as_str() {
        "claude" => {
            c.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
            if req.skip_permissions {
                c.arg("--dangerously-skip-permissions");
            } else {
                c.args(["--permission-mode", "acceptEdits"]);
            }
            if let Some(s) = &req.session_id {
                c.args(["--resume", s]);
            }
            if let Some(m) = req.model.as_ref().filter(|m| !m.is_empty()) {
                c.args(["--model", m]);
            }
            for d in &req.extra_dirs {
                c.args(["--add-dir", d]);
            }
        }
        "codex" => {
            c.arg("exec");
            if let Some(s) = &req.session_id {
                c.args(["resume", s]);
            }
            c.args(["--json", "--skip-git-repo-check"]);
            if req.skip_permissions {
                c.arg("--dangerously-bypass-approvals-and-sandbox");
            } else {
                c.arg("--full-auto");
            }
            if req.session_id.is_none() {
                c.arg("-C").arg(&req.cwd);
            }
            if let Some(m) = req.model.as_ref().filter(|m| !m.is_empty()) {
                c.args(["-m", m]);
            }
            c.arg("-");
        }
        p => return Err(format!("unknown provider {p}")),
    }
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.env("SHDW", "1").env("PATH", tools::child_path());
    let mut child = c.spawn().map_err(|e| format!("failed to start {}: {e}", req.provider))?;
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = req.prompt.clone();
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let id = req.run_id.clone();
    let pid = child.id();
    state.0.lock().unwrap().insert(id.clone(), child);

    let (a1, id1) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = a1.emit("agent-event", serde_json::json!({ "runId": id1, "kind": "stderr", "data": line }));
        }
    });
    let map = state.0.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app.emit("agent-event", serde_json::json!({ "runId": id, "kind": "line", "data": line }));
        }
        let code = map
            .lock()
            .unwrap()
            .remove(&id)
            .and_then(|mut c| c.wait().ok())
            .and_then(|s| s.code());
        let _ = app.emit("agent-event", serde_json::json!({ "runId": id, "kind": "exit", "data": code }));
    });
    Ok(pid)
}

#[tauri::command]
pub fn agent_stop(state: State<AgentState>, run_id: String) {
    if let Some(mut c) = state.0.lock().unwrap().remove(&run_id) {
        // kill the whole tree (cmd shim + node child)
        tools::kill_tree(c.id());
        let _ = c.kill();
    }
}

/// Kill every running agent process tree (app exit).
pub fn shutdown(state: &AgentState) {
    for (_, mut c) in state.0.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        tools::kill_tree(c.id());
        let _ = c.kill();
    }
}

/// Kill a leftover agent process tree from a previous editor session.
#[tauri::command]
pub fn agent_kill_pid(pid: u32) {
    tools::kill_tree(pid);
}
