# Contributing to shdw

Thanks for helping! A few notes:

1. **Fork → branch → PR.** Keep PRs focused; include a screenshot or short clip for UI changes.
2. **Dev setup:** `npm install` then `npx tauri dev`. Type-check with `npx tsc --noEmit`, Rust with `cargo check` in `src-tauri/`.
3. **Platforms:** shdw ships for Windows and macOS. If you touch process spawning, paths or the headless renderer, keep both working (`#[cfg(windows)]` / `#[cfg(not(windows))]`).
4. **Agent guide:** if you change the project format or the control API, update `agent/SHDW_AGENT_GUIDE.md` — that's what Claude Code / Codex read inside every project.
5. **License:** by contributing you agree your contribution is licensed under the project's AGPL-3.0 + attribution terms (see `LICENSE` and `NOTICE`).

Bug? Open an issue with your OS, shdw version, and what `GET http://127.0.0.1:47800/errors` returns.
