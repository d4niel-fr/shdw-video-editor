// Agent panel: chats with Claude Code or Codex CLI running inside the project
// folder. The agent edits project files; shdw hot-reloads them.

import { store } from "../store";
import { h, I, clear, menu, switchEl } from "./dom";
import { invoke, listen, fs, join, mediaUrl, isAbs } from "../ipc";
import { clipEnd, uid } from "../model";

type Provider = "claude" | "codex";
interface ChatItem { role: "user" | "assistant" | "tool" | "error" | "meta"; text: string; title?: string; detail?: string; image?: string }

const SUGGESTIONS = [
  "Make a 10s Apple-style product intro with kinetic typography",
  "Cut my footage into a punchy 30s edit with music sync",
  "Add animated captions to the whole video",
  "Grade everything warm and cinematic",
  "Create a custom glitch transition and use it between all clips",
  "Look at inspo/ and make motion graphics in that style",
];

export class AgentPanel {
  el: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private chips: HTMLElement;
  private headAv: HTMLElement;
  private headName: HTMLElement;
  private status: HTMLElement;
  private items: ChatItem[] = [];
  private attachments = new Set<string>();
  private runId: string | null = null;
  private sessions: Record<Provider, string | null> = { claude: null, codex: null };
  private cur: HTMLElement | null = null;   // streaming assistant bubble
  private curText = "";
  private sawDelta = false;
  private toolEls = new Map<string, { el: HTMLElement; item: ChatItem }>();
  private started = 0;
  private running: { pid: number; provider: Provider } | null = null;
  private saveT = 0;
  port = 0;

  get provider(): Provider { return (localStorage.getItem("shdw.provider") as Provider) || "claude"; }
  set provider(p: Provider) { localStorage.setItem("shdw.provider", p); this.paintHead(); }
  get model() { return localStorage.getItem(`shdw.model.${this.provider}`) ?? ""; }
  get skip() { return localStorage.getItem("shdw.skipPerms") !== "0"; }

  constructor() {
    this.log = h("div", { class: "agent-log" });
    this.input = h("textarea", { rows: 2, placeholder: "Describe what to make or change…  (Enter to send, Shift+Enter for newline)" }) as HTMLTextAreaElement;
    this.sendBtn = h("button", { class: "send", title: "Send", onclick: () => (this.runId ? this.stop() : this.send()) }, I.send()) as HTMLButtonElement;
    this.chips = h("div", { class: "chips" });
    this.headAv = h("div", { class: "av" });
    this.headName = h("div", { style: { fontWeight: 600 } });
    this.status = h("div", { class: "faint", style: { fontSize: "11px" } });
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener("input", () => { this.input.style.height = "auto"; this.input.style.height = Math.min(200, this.input.scrollHeight) + "px"; });
    const head = h("div", { class: "agent-head" }, this.headAv, h("div", { class: "grow" }, this.headName, this.status),
      h("button", { class: "btn icon sm ghost", title: "New chat", onclick: () => this.newChat() }, I.plus()),
      h("button", { class: "btn icon sm ghost", title: "Agent settings", onclick: (e: MouseEvent) => this.settings(e) }, I.gear()));
    const composer = h("div", { class: "composer" },
      h("div", { class: "box" }, this.chips, this.input,
        h("div", { class: "bar" },
          h("button", { class: "btn sm ghost", title: "Attach selected clips / playhead", onclick: () => this.attachSelection() }, I.link(), "Context"),
          h("button", { class: "btn sm ghost", title: "Attach a file (inspo, media…)", onclick: () => this.attachFile() }, I.plus(), "File"),
          h("div", { class: "grow" }), this.sendBtn)));
    this.el = h("div", { id: "agent" }, h("div", { class: "panel" }, head, this.log, composer));
    this.paintHead();

    void listen<{ runId: string; kind: string; data: any }>("agent-event", (e) => this.onEvent(e.payload));
    store.on("agent-prompt", (text) => { this.show(); this.input.value = text; this.input.dispatchEvent(new Event("input")); this.input.focus(); });
    store.on("agent-attach", (path) => { this.show(); this.attachments.add(path); this.paintChips(); });
    store.on("opened", () => void this.loadHistory());
  }

  show() { this.el.classList.remove("hidden"); store.emit("agent-visibility"); }
  toggle() { this.el.classList.toggle("hidden"); store.emit("agent-visibility"); }

  private paintHead() {
    const p = this.provider;
    this.headAv.className = "av " + p;
    this.headAv.textContent = p === "claude" ? "✳" : "◎";
    this.headName.textContent = p === "claude" ? "Claude Code" : "Codex";
    this.status.textContent = (this.model || "default model") + (this.skip ? " · full access" : " · auto-edit");
  }

  private settings(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = h("div", { class: "menu", style: { left: r.right - 300 + "px", top: r.bottom + 6 + "px", width: "300px", padding: "12px" } });
    const prov = h("div", { class: "tabs" }, ...(["claude", "codex"] as Provider[]).map((p) => h("button", { class: this.provider === p ? "on" : "", onclick: () => { this.provider = p; box.remove(); this.settings(e); } }, p === "claude" ? "Claude Code" : "Codex")));
    const model = h("input", { type: "text", value: this.model, placeholder: this.provider === "claude" ? "e.g. opus, sonnet, claude-opus-5-5" : "e.g. gpt-5-codex", style: { width: "100%" } }) as HTMLInputElement;
    model.addEventListener("change", () => { localStorage.setItem(`shdw.model.${this.provider}`, model.value.trim()); this.paintHead(); });
    model.addEventListener("keydown", (ev) => ev.stopPropagation());
    const skip = switchEl(this.skip, (v) => { localStorage.setItem("shdw.skipPerms", v ? "1" : "0"); this.paintHead(); });
    const wm = h("select", { style: { width: "100%" } }) as HTMLSelectElement;
    for (const m of ["tiny", "base", "small", "medium", "large-v3-turbo"]) wm.appendChild(h("option", { value: m, selected: (localStorage.getItem("shdw.whisperModel") || "base") === m }, m));
    wm.addEventListener("change", () => localStorage.setItem("shdw.whisperModel", wm.value));
    box.append(h("div", { class: "col" },
      h("div", { class: "mh", style: { padding: 0 } }, "Agent CLI"), prov,
      h("div", { class: "mh", style: { padding: 0 } }, "Model"), model,
      h("div", { class: "row" }, h("div", { class: "grow" }, h("div", {}, "Skip permissions"), h("div", { class: "faint", style: { fontSize: "11px" } }, this.provider === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox")), skip),
      h("div", { class: "mh", style: { padding: 0 } }, "Whisper model (transcripts)"), wm,
      h("div", { class: "faint", style: { fontSize: "11px" } }, `Runs in the project folder. Control API on port ${this.port}.`)));
    document.body.appendChild(box);
    setTimeout(() => { const off = (ev: Event) => { if (!box.contains(ev.target as Node)) { box.remove(); removeEventListener("pointerdown", off, true); } }; addEventListener("pointerdown", off, true); });
  }

  private attachSelection() {
    for (const c of store.selectedClips()) this.attachments.add(`clip:${c.id}`);
    this.attachments.add(`time:${store.playhead.toFixed(2)}`);
    this.paintChips();
  }
  private async attachFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, defaultPath: join(store.dir, "inspo") });
    if (!sel) return;
    for (const p of (Array.isArray(sel) ? sel : [sel]).map(String)) this.attachments.add(store.rel(p));
    this.paintChips();
  }
  private paintChips() {
    clear(this.chips);
    for (const a of this.attachments) this.chips.appendChild(h("span", { class: "chip" }, a, h("button", { onclick: () => { this.attachments.delete(a); this.paintChips(); } }, "×")));
    this.chips.style.marginBottom = this.attachments.size ? "6px" : "0";
  }

  // ---------- history ----------
  private get histPath() { return join(store.dir, ".shdw", "chat.json"); }
  private async loadHistory() {
    this.items = []; this.sessions = { claude: null, codex: null };
    try {
      const j = JSON.parse(await fs.readText(this.histPath));
      this.items = j.items ?? []; this.sessions = { claude: null, codex: null, ...(j.sessions ?? {}) };
      this.running = j.running ?? null;
    } catch { /* fresh */ }
    this.renderAll();
    // an agent run was cut off by an editor restart/crash → kill the orphan and continue the same session
    const r = this.running;
    if (r && this.sessions[r.provider]) {
      try { await invoke("agent_kill_pid", { pid: r.pid }); } catch { /* already gone */ }
      this.running = null;
      if (this.provider !== r.provider) this.provider = r.provider;
      this.push({ role: "meta", text: "↻ Editor restarted mid-task — resuming the same agent session…" });
      setTimeout(() => void this.send("Continue the task exactly where you left off — the shdw editor was restarted while you were working, so your last command may not have completed. Check GET /state and GET /errors first, then finish the job and verify with /frames."), 1500);
    }
  }
  private saveHistory() {
    if (!store.dir) return;
    void fs.writeText(this.histPath, JSON.stringify({ sessions: this.sessions, running: this.running, items: this.items.slice(-400) }, null, 1));
  }
  private newChat() {
    if (this.runId) this.stop();
    this.items = []; this.sessions = { claude: null, codex: null };
    this.saveHistory(); this.renderAll();
  }

  private renderAll() {
    clear(this.log);
    this.toolEls.clear();
    if (!this.items.length) {
      this.log.appendChild(h("div", { class: "empty", style: { height: "auto", paddingTop: "30px" } },
        h("div", { class: "col", style: { alignItems: "center", gap: "14px" } },
          h("div", { style: { font: "700 22px var(--font-display)", letterSpacing: "-0.02em", color: "var(--label)" } }, "What are we making?"),
          h("div", {}, `${this.provider === "claude" ? "Claude" : "Codex"} edits this project directly — timeline, motion graphics, transitions, effects, fonts, captions, grades.`),
          h("div", { class: "suggest" }, ...SUGGESTIONS.map((s) => h("button", { onclick: () => { this.input.value = s; this.input.focus(); } }, s))))));
      return;
    }
    for (const it of this.items) this.log.appendChild(this.itemEl(it));
    this.scroll(true);
  }

  private itemEl(it: ChatItem): HTMLElement {
    if (it.role === "user") return h("div", { class: "msg user" }, it.text);
    if (it.role === "assistant") { const el = h("div", { class: "msg assistant" }); el.innerHTML = md(it.text); return el; }
    if (it.role === "error") return h("div", { class: "msg err" }, it.text);
    if (it.role === "meta") return h("div", { class: "msg meta" }, it.text);
    const el = h("div", { class: "msg tool" },
      h("div", { class: "th", onclick: () => el.classList.toggle("open") }, toolIcon(it.title ?? ""), h("b", {}, it.title ?? "tool"), h("span", { class: "sp" }, it.text)),
      h("div", { class: "td" }, it.detail ?? ""));
    if (it.image) el.appendChild(h("img", { src: it.image, style: { padding: "0 8px 8px" } }));
    return el;
  }

  private push(it: ChatItem) {
    if (!this.items.length) clear(this.log);
    this.items.push(it);
    const el = this.itemEl(it);
    this.log.appendChild(el);
    this.scroll();
    return el;
  }

  private scroll(force = false) {
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 140;
    if (force || nearBottom) requestAnimationFrame(() => (this.log.scrollTop = this.log.scrollHeight));
  }

  // ---------- run ----------
  private context(): string {
    const p = store.project;
    const lines = [
      "", "---", "[shdw editor context — added automatically by the app]",
      `Project folder (cwd): ${store.dir}`,
      `Control API: http://127.0.0.1:${this.port}  (read CLAUDE.md / AGENTS.md for the project format + API)`,
      `Timeline: ${p.settings.width}x${p.settings.height} @ ${p.settings.fps}fps, duration ${store.duration.toFixed(2)}s, ${p.clips.length} clips, ${p.media.length} media. Playhead ${store.playhead.toFixed(2)}s.`,
    ];
    const sel = store.selectedClips();
    if (sel.length) lines.push("Selected clips: " + sel.map((c) => `${c.id} "${c.name ?? ""}" [${c.track}, ${c.source.type}${(c.source as any).module ? " " + (c.source as any).module : ""}, ${c.start.toFixed(2)}–${clipEnd(c).toFixed(2)}s]`).join("; "));
    const att = [...this.attachments];
    if (att.length) lines.push("Attached: " + att.join(", ") + " (file paths are relative to the project; Read images to see them)");
    if (store.errors.length) lines.push("Current editor errors: " + store.errors.slice(-5).map((e) => `${e.source}: ${e.message}`).join(" | "));
    return lines.join("\n");
  }

  async send(override?: string) {
    const text = (override ?? this.input.value).trim();
    if (!text || this.runId) return;
    if (!store.dir) { store.emit("toast", "Open a project first"); return; }
    if (!override) { this.input.value = ""; this.input.style.height = "auto"; }
    this.push({ role: "user", text });
    const prompt = text + "\n" + this.context();
    this.attachments.clear(); this.paintChips();
    const runId = uid("run");
    this.runId = runId;
    this.cur = null; this.curText = ""; this.sawDelta = false; this.started = performance.now();
    this.setBusy(true);
    try {
      const pid = await invoke<number>("agent_start", { req: { runId, provider: this.provider, prompt, cwd: store.dir, sessionId: this.sessions[this.provider], model: this.model || null, skipPermissions: this.skip, extraDirs: [] } });
      this.running = { pid, provider: this.provider };
      this.saveHistory();
    } catch (e: any) {
      this.push({ role: "error", text: String(e) });
      this.runId = null; this.setBusy(false);
    }
  }

  stop() {
    if (!this.runId) return;
    void invoke("agent_stop", { runId: this.runId });
    this.push({ role: "meta", text: "Stopped" });
    this.runId = null; this.setBusy(false);
    this.running = null; this.saveHistory();
  }

  private setBusy(b: boolean) {
    this.sendBtn.classList.toggle("stop", b);
    this.sendBtn.replaceChildren(b ? I.stop() : I.send());
    this.typing(b);
    store.emit("agent-busy", b ? "1" : "");
  }

  private typingEl: HTMLElement | null = null;
  private typing(on: boolean) {
    this.typingEl?.remove(); this.typingEl = null;
    if (on) { this.typingEl = h("div", { class: "typing" }, h("i"), h("i"), h("i")); this.log.appendChild(this.typingEl); this.scroll(); }
  }

  private assistantDelta(t: string) {
    if (!this.cur) {
      this.curText = "";
      const item: ChatItem = { role: "assistant", text: "" };
      this.items.push(item);
      this.cur = h("div", { class: "msg assistant" });
      (this.cur as any).__item = item;
      this.log.insertBefore(this.cur, this.typingEl);
    }
    this.curText += t;
    (this.cur as any).__item.text = this.curText;
    this.cur.innerHTML = md(this.curText);
    this.scroll();
  }

  private tool(id: string, name: string, summary: string, detail: string) {
    const item: ChatItem = { role: "tool", title: name, text: summary, detail };
    const el = this.push(item);
    if (this.typingEl) this.log.appendChild(this.typingEl);
    this.toolEls.set(id, { el, item });
    this.cur = null;
    clearTimeout(this.saveT); this.saveT = window.setTimeout(() => this.saveHistory(), 800);
  }

  private toolResult(id: string, content: any) {
    const t = this.toolEls.get(id);
    if (!t) return;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? (c.type === "image" ? "[image]" : "")).join("\n") : JSON.stringify(content);
    t.item.detail = (t.item.detail ? t.item.detail + "\n\n→ " : "→ ") + text.slice(0, 4000);
    const td = t.el.querySelector(".td");
    if (td) td.textContent = t.item.detail;
    // show verification frames the agent rendered / looked at
    const m = (t.item.detail ?? "").match(/([\w\-./\\:]+\.png)/i);
    if (m && /Read|view|frame/i.test(t.item.title + t.item.text) && !t.item.image) {
      const p = isAbs(m[1]) ? m[1] : join(store.dir, m[1]);
      t.item.image = mediaUrl(p) + `?v=${Date.now()}`;
      t.el.appendChild(h("img", { src: t.item.image, style: { padding: "0 8px 8px" } }));
    }
  }

  private onEvent(ev: { runId: string; kind: string; data: any }) {
    if (ev.runId !== this.runId) return;
    if (ev.kind === "exit") {
      this.typing(false);
      if (ev.data && ev.data !== 0) this.push({ role: "meta", text: `exited with code ${ev.data}` });
      this.runId = null; this.setBusy(false); this.cur = null;
      this.running = null;
      this.saveHistory();
      store.emit("agent-done");
      return;
    }
    if (ev.kind === "stderr") {
      const s = String(ev.data);
      if (/error|fatal|not logged|unauthor|ENOENT/i.test(s) && !/warn/i.test(s)) this.push({ role: "error", text: s });
      return;
    }
    let j: any;
    try { j = JSON.parse(ev.data); } catch { if (String(ev.data).trim()) this.assistantDelta(String(ev.data) + "\n"); return; }
    if (this.provider === "claude") this.onClaude(j); else this.onCodex(j);
  }

  private onClaude(j: any) {
    switch (j.type) {
      case "system":
        if (j.subtype === "init" && j.session_id) { this.sessions.claude = j.session_id; this.saveHistory(); }
        break;
      case "stream_event": {
        const e = j.event;
        if (e?.type === "message_start") { this.cur = null; this.sawDelta = false; }
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") { this.sawDelta = true; this.assistantDelta(e.delta.text); }
        if (e?.type === "content_block_start" && e.content_block?.type === "text") { this.cur = null; }
        break;
      }
      case "assistant": {
        for (const b of j.message?.content ?? []) {
          if (b.type === "text" && !this.sawDelta) this.assistantDelta(b.text);
          if (b.type === "tool_use") this.tool(b.id, b.name, summarize(b.name, b.input), JSON.stringify(b.input, null, 2).slice(0, 4000));
        }
        break;
      }
      case "user":
        for (const b of j.message?.content ?? []) if (b.type === "tool_result") this.toolResult(b.tool_use_id, b.content);
        break;
      case "result": {
        if (j.session_id) this.sessions.claude = j.session_id;
        const secs = ((performance.now() - this.started) / 1000).toFixed(0);
        const cost = j.total_cost_usd != null ? ` · $${(+j.total_cost_usd).toFixed(3)}` : "";
        if (j.is_error || j.subtype !== "success") this.push({ role: "error", text: j.result ?? j.subtype ?? "error" });
        this.push({ role: "meta", text: `✓ ${j.num_turns ?? ""} turns · ${secs}s${cost}` });
        this.saveHistory();
        break;
      }
    }
  }

  private onCodex(j: any) {
    const t = j.type ?? j.msg?.type;
    if (t === "thread.started" && j.thread_id) { this.sessions.codex = j.thread_id; this.saveHistory(); return; }
    if (t === "session_configured" || j.session_id) { if (j.session_id) this.sessions.codex = j.session_id; }
    const item = j.item ?? j.msg;
    if (t === "item.started" && item?.type === "command_execution") { this.tool(item.id, "Shell", item.command ?? "", item.command ?? ""); return; }
    if (t === "item.completed" && item) {
      switch (item.type) {
        case "agent_message": this.cur = null; this.assistantDelta(item.text ?? ""); this.cur = null; break;
        case "reasoning": break;
        case "command_execution":
          if (this.toolEls.has(item.id)) this.toolResult(item.id, item.aggregated_output ?? `exit ${item.exit_code}`);
          else this.tool(item.id, "Shell", item.command ?? "", (item.aggregated_output ?? "").slice(0, 4000));
          break;
        case "file_change": this.tool(item.id ?? uid("f"), "Edit", (item.changes ?? []).map((c: any) => c.path).join(", "), JSON.stringify(item.changes ?? [], null, 2)); break;
        case "mcp_tool_call": this.tool(item.id ?? uid("m"), item.tool ?? "MCP", item.server ?? "", JSON.stringify(item, null, 2).slice(0, 3000)); break;
        case "error": this.push({ role: "error", text: item.message ?? "error" }); break;
        default: if (item.text) this.assistantDelta(item.text);
      }
      return;
    }
    if (t === "turn.completed") {
      const u = j.usage;
      this.push({ role: "meta", text: `✓ ${((performance.now() - this.started) / 1000).toFixed(0)}s${u ? ` · ${u.input_tokens ?? 0}→${u.output_tokens ?? 0} tok` : ""}` });
      this.saveHistory();
    }
    if (t === "turn.failed" || t === "error") this.push({ role: "error", text: j.error?.message ?? j.message ?? JSON.stringify(j) });
  }
}

function summarize(name: string, input: any): string {
  if (!input) return "";
  if (input.file_path) return String(input.file_path).replace(/\\/g, "/").split("/").slice(-2).join("/");
  if (input.command) return String(input.command).slice(0, 140);
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.description) return input.description;
  if (name === "TodoWrite") return `${input.todos?.length ?? 0} todos`;
  return Object.keys(input).join(", ");
}

function toolIcon(name: string) {
  const s = /Edit|Write|file/i.test(name) ? I.edit() : /Bash|Shell/i.test(name) ? I.code() : /Read|view/i.test(name) ? I.eye() : I.spark();
  (s as any).style.cssText = "width:13px;height:13px;flex:none";
  return s;
}

/** Minimal, safe markdown → HTML. */
function md(src: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = src.split(/```/);
  let out = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) { const nl = part.indexOf("\n"); out += `<pre><code>${esc(nl >= 0 ? part.slice(nl + 1) : part)}</code></pre>`; return; }
    const lines = esc(part).split("\n");
    let list: string | null = null;
    let para: string[] = [];
    const flushP = () => { if (para.length) { out += `<p>${inline(para.join("<br>"))}</p>`; para = []; } };
    const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const ln of lines) {
      const ul = ln.match(/^\s*[-*•]\s+(.*)/), ol = ln.match(/^\s*\d+[.)]\s+(.*)/), hd = ln.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) { flushP(); const tag = ul ? "ul" : "ol"; if (list !== tag) { flushL(); out += `<${tag}>`; list = tag; } out += `<li>${inline((ul ?? ol)![1])}</li>`; continue; }
      flushL();
      if (hd) { flushP(); out += `<p><b>${inline(hd[1])}</b></p>`; continue; }
      if (!ln.trim()) { flushP(); continue; }
      para.push(ln);
    }
    flushP(); flushL();
  });
  return out;
}
const inline = (s: string) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");

export { menu };
