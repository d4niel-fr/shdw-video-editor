# Hardening changes (local fork)

> **Modified version.** Based on shdw by d4niel-fr — https://github.com/d4niel-fr/shdw-video-editor
> (commit `e77da75`, v1.0.0). This is a locally modified build, **not** the official shdw release and not
> endorsed by the original author. See `NOTICE` for the attribution terms that continue to apply.

## What was wrong in v1.0.0, and what changed

| # | Problem in the original | Fix |
|---|---|---|
| 1 | The agent ran with `--dangerously-skip-permissions` **by default** (`skipPerms !== "0"`). | Default is now *scoped*: `--permission-mode acceptEdits` (edits confined to the project folder) plus one allowed shell command, the control-API helper. Full access is an explicit opt-in toggle. |
| 2 | Control API on `127.0.0.1:47800` had no authentication, no Host/Origin check: any web page open in the user's browser could write files through it. | Per-launch 256-bit token (`X-Shdw-Token` or `Authorization: Bearer`, constant-time compare), loopback `Host` required (DNS rebinding), any `Origin` / `Sec-Fetch-Site` header refused, 1 MiB body cap, bounded concurrency. Only `/health` is open. |
| 3 | `path=` / `out=` / `paths=` accepted any absolute path (arbitrary file overwrite / read). | Rust-side jail (`security::resolve_output`, `resolve_media`): `..` collapsed, symlinks resolved, must stay in the project, media extensions only; imports must be real media files outside hidden folders. |
| 4 | `csp: null`, asset protocol scope `**`, `media://` served any file with `ACAO: *`, unsandboxed live-preview iframes. | CSP on the main webview, asset protocol removed, `media://` serves only known media/web types and never hidden folders (symlinks resolved first), live-composition frames get their own CSP (local + listed CDNs only) and `sandbox` (no top navigation, popups, forms). |
| 5 | Headless Chrome could reach any host (compositions could exfiltrate). | Dead proxy + bypass list: only loopback and cdnjs / jsdelivr / unpkg / Google Fonts are reachable; WebRTC direct UDP and Chrome background networking disabled. |
| 6 | Whisper model download used `curl.exe` (fails on macOS), no integrity check, and the model name flowed into a file path. | Models are pinned by SHA-256 (digests from huggingface.co `x-linked-etag`), name validated against the pin table, downloaded over HTTPS-only to a `.part` file, verified, then moved into place. |
| 7 | UI fonts loaded from Google at every start. | Removed; system font stack. |
| 8 | `reveal` only worked on Windows; media URL hard-coded `http://media.localhost` (Windows form). | `open -R` / `xdg-open`; `media://localhost` on macOS/Linux. |
| 9 | Auto-captions needed an ffmpeg built with the `whisper` filter (stock Homebrew has none). | Falls back to whisper.cpp's `whisper-cli` (`brew install whisper.cpp`) via `src-tauri/src/whisper.rs`; language codes are validated before reaching ffmpeg or the CLI; temp files are unique per call. |

New files: `src-tauri/src/security.rs` (all security rules, 49 unit tests), `src-tauri/src/whisper.rs` (caption back-ends, 8 tests), `src-tauri/src/audio.rs` (audio extraction, 2 tests), `src/engine/avsync.ts` (A/V sync policy, 15 node tests), the helper script it embeds, and
`~/.shdw/bin/shdw-api` (installed at runtime, outside every project so a confined agent cannot rewrite it).

## Playback fix: "voice breaking" (not a security issue)

**Symptom:** speech cut out repeatedly when playing in the editor (macOS).
**Cause (upstream design, measured):** every audio clip was an `<audio>` element that the wall-clock timeline force-seeked whenever it drifted. On WKWebView a seek leaves the element silent for 0.14-0.8 s, so it was "late" again right after each seek and the voice restarted over and over (33 seeks in 6 s of narration; on a pure tone 20 seeks, 29 clicks, silence in 43% of the output). The first fix (drift tolerance + learned seek lead) removed the rapid-fire restarts but the element still fell ~0.3 s behind after every seek, so the voice still cut every 1.5 s on a real clip.
**Fix:** audio is now **decoded once to an `AudioBuffer` and played with `AudioBufferSourceNode` on the AudioContext clock** (sample-accurate, no seeking). Drift is corrected by *restarting* the source, which has no silent gap (8 ms fades avoid clicks); rule and tests in `src/engine/avsync.ts`. Decoding: audio-native files decode directly; video containers, and anything WebKit rejects, are first turned into a cached 48 kHz stereo WAV by ffmpeg (`src-tauri/src/audio.rs`, cache in `~/Library/Application Support/shdw/audio-cache/`). WebKit's decoder rejects **HE-AAC in MP4** (a real-world clip) and `fetch()` of `video/*` responses stalls, so bytes are requested as `?raw=1` (`application/octet-stream`). Files over 30 min, or that fail every route, fall back to the old `<audio>` element path (with the seek-settle logic).
**Measured (real output, identical test):** 9 s pure tone: before 20 seeks / 29 clicks / 95 of 219 buffers silent; after 0 seeks, 0 restarts, 0 clicks, 0 dropouts (3 runs). 25 s of a real speech clip: 0 restarts, 0 element seeks, no frame gaps over 100 ms.
**Do not** correct drift by changing `playbackRate` on an element: on WKWebView that hung the web process when pausing an element wired into WebAudio.
**Diagnostics:** `GET /state` includes `playback` (decode results and timings, restarts, seeks, frame gaps, buffers playing); `POST /play?capture=1` + `POST /pause?capture=0` count clicks and dropouts in the master mix (meaningful for a pure tone, not for speech).

## Editor stalls and "re-opening" (not a security issue)

**Symptoms:** exports and frame renders of projects with HTML compositions crawled or hung (ffmpeg idle, no error anywhere), and the editor or its headless Chrome kept being restarted/re-opened while editing and running a video.
**Causes (each reproduced on a scratch project with the pre-fix build, then fixed):**
1. *Thenable hook.* `shdw.onFrame(t => tl.time(t))` (the form the agent guide recommended) returns the GSAP timeline. A GSAP timeline is a thenable whose `.then()` stays pending until the timeline has *finished* (`tl.time(t)` with t at or past its duration resolves immediately; verified with GSAP 3.15). So `agent/html_runtime.js` awaited the hook up to its 6 s cap on every frame where the timeline had not ended: a master timeline spanning the clip stalls every frame but the last; a 1 s timeline on a 4 s clip stalls only the first second (so test frames at t=1.3, 2.7 and 3.1 on a 1 s timeline were instant).
   Measured (old runtime, real clock): 1 hook = 6009 ms per frame, 5 hooks = 30009 ms. In the old app: a 15-frame export took 92 s (about 6.1 s per frame); 5 hooks made every `/frame` request take 26 s and hit `Runtime.evaluate: timeout`. Live preview (the playback path, same injected runtime, `mediaproto.rs:159`): in 2 s of simulated playback the drawing hook ran 1 time with the old runtime versus 59 with the new one; the playhead itself kept moving in both builds (240 frames, no gaps).
   **Fix:** only real Promises are awaited; all hooks of one exact `frame()` share a 15 s budget (6 s each); the guide now shows the block-body form. Tests: `agent/html_runtime.test.mjs` (`npm test`).
2. *Chrome kill loop.* A frame that exceeds the 25 s `Runtime.evaluate` deadline gets the whole headless Chrome killed, and the next request launches a fresh one that is killed again (old app, 5 hooks: Chrome gone after request 1, relaunched and killed by request 2, 26-27 s each). This is the "re-opening". The budget in (1) keeps normal compositions far below the deadline.
3. *Silent errors.* The renderer emits `html-errors`, but no UI code listened, so `GET /errors` stayed empty. `src/engine/html.ts` now turns them into editor errors (cleared when the composition file changes).
4. *False "timed out" errors (pre-existing, found while verifying 3).* `capped()` never cancelled its timer, so a hook or `document.fonts.ready` that had resolved instantly still reported "timed out after 6s" six seconds later. Every run longer than 6 s ended with a bogus "font loading timed out after 6s". Fixed (timer cleared when the race settles); regression test included.
5. *Startup killed other processes.* `cleanup_orphans()` killed every process whose command line contained `render-profile-` and `shdw` and was not its own: other editors' headless Chrome (opening a second project killed the first project's renderer) and also unrelated processes, including the tool shell of the agent driving the editor (reproduced with a decoy process; this is what made several launches end with exit code 1 and truncated output). It now acts only on real renderer browsers (`is_renderer_command`: `--headless` plus a `--user-data-dir=...render-profile-...` argument) whose owner shdw PID, parsed from `render-profile-<pid>-<n>`, is no longer alive (`is_orphan`). Tests in `html.rs`. The Windows branch of this function was edited the same way but could not be compiled or run here.
6. *`launch.sh` could start duplicates.* It ran `open -n` whenever `/state` did not answer at that moment: calling it while an editor was still starting opened a second editor on the same project (reproduced: two processes on one project). Against a frozen editor it instead hung for up to 30 min (`curl --max-time 1800`). It now looks for an editor process already on that project (answering: done; starting: wait; stuck: report its PID and ask for a kill, never a second instance), and its own `/state` probe times out after 5 s.

## Verify

```bash
cd src-tauri && cargo test --release     # 49 security + 8 whisper + 2 audio + 7 renderer-cleanup tests
cd .. && npx tsc --noEmit && npm test    # 15 A/V sync + 5 HTML runtime tests (node --test)
```

## Known limits (not fixed)

* **Motion/effect/transition/blend `*.js` modules run inside the editor webview with full IPC** (they are
  `import()`ed there). Treat a project folder from someone else, or code you did not review, as untrusted.
  HTML compositions are different: they render in the network-restricted headless browser.
* Full-access mode (`--dangerously-skip-permissions`) is still available on request and is exactly as
  powerful as it sounds.
* The scoped agent mode relies on Claude Code's permission system; it is not an OS sandbox.
* The `shdw-api` helper is POSIX `sh` (macOS/Linux). On Windows the scoped mode grants no shell, so the
  agent needs full access to call the API.
* Captions: the `whisper-cli` fallback was exercised end to end (transcribe, lay captions, export). The branch that uses ffmpeg's own `whisper` filter was refactored but could not be run here (no such ffmpeg).
* Whisper pins: all five match the published digests; only `base` was actually downloaded and re-hashed (independent SHA-256 matched).
* `/captions` only captions clips on a *video* track: put narration inside a video clip with a linked audio clip.
