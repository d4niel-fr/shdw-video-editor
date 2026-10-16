// Answers HTTP requests the agent sends to the local control API.

import { invoke, listen, fs, join, isAbs } from "./ipc";
import { store } from "./store";
import { Renderer } from "./engine/renderer";
import { renderFramePNG, renderContactSheet, exportVideo } from "./engine/exporter";
import { playback } from "./engine/playback";
import { importFiles, transcribe } from "./media";
import { captionsFor } from "./actions";
import { invalidateAll } from "./engine/modules";
import { htmlFrames } from "./engine/html";
import { sceneDetect, removeSilence, normalizeLoudness, detectBeats, processClip, PROCS } from "./processing";

let queue: Promise<unknown> = Promise.resolve();

/** Export quality as an x264/x265 CRF: accepts a number or words like "high". */
function crf(q: unknown): number | undefined {
  if (q == null || q === "") return undefined;
  const words: Record<string, number> = { lossless: 0, max: 12, best: 12, ultra: 14, high: 16, good: 18, medium: 20, normal: 20, low: 26, draft: 30 };
  if (typeof q === "string" && q.toLowerCase() in words) return words[q.toLowerCase()];
  const n = Math.round(Number(q));
  return Number.isFinite(n) ? Math.max(0, Math.min(51, n)) : undefined;
}

export function startControl(renderer: Renderer) {
  void listen<{ id: number; method: string; url: string; body: string }>("control-request", (e) => {
    const req = e.payload;
    // serialize: rendering jobs must not interleave
    const long = /^\/(export|process|transcribe|captions|import|frames)/.test(new URL(req.url, "http://x").pathname);
    const job = () => Promise.race([
      handle(renderer, req),
      new Promise<void>((res) => setTimeout(() => { void respond(req.id, 504, { error: "editor timed out on this request; it is still responsive — retry or GET /errors" }); res(); }, long ? 30 * 60000 : 120000)),
    ]);
    // read-only status endpoints answer immediately, even while an export is running
    if (/^\/(state|errors)$/.test(new URL(req.url, "http://x").pathname)) { void job(); return; }
    queue = queue.then(job).catch(() => {});
  });
}

async function respond(id: number, status: number, body: any) {
  await invoke("control_respond", { id, status, body: JSON.stringify(body) });
}

async function handle(renderer: Renderer, req: { id: number; method: string; url: string; body: string }) {
  const u = new URL(req.url, "http://x");
  const q = (k: string) => u.searchParams.get(k);
  const body = (() => { try { return req.body ? JSON.parse(req.body) : {}; } catch { return {}; } })();
  const out = (p: string) => (isAbs(p) ? p : join(store.dir, p));
  try {
    if (!store.dir && u.pathname !== "/state") return respond(req.id, 409, { error: "no project open" });
    switch (u.pathname) {
      case "/state":
        return respond(req.id, 200, { projectDir: store.dir, playhead: store.playhead, playing: store.playing, selection: [...store.selection], duration: store.duration, page: store.page, renderCache: htmlFrames.stats, project: store.project, errors: store.errors.slice(-20) });
      case "/errors":
        return respond(req.id, 200, { errors: store.errors.slice(-50) });
      case "/reload":
        await store.reloadFromDisk(); invalidateAll(); store.emit("frame-ready");
        return respond(req.id, 200, { ok: true });
      case "/seek":
        store.seek(+(q("t") ?? 0));
        return respond(req.id, 200, { ok: true, playhead: store.playhead });
      case "/page": store.emit("set-page", q("name") ?? "edit"); return respond(req.id, 200, { ok: true });
      case "/select": store.select((q("ids") ?? "").split(",").filter(Boolean)); return respond(req.id, 200, { ok: true });
      case "/play": playback.play(); return respond(req.id, 200, { ok: true });
      case "/pause": playback.pause(); return respond(req.id, 200, { ok: true });
      case "/frame": {
        await store.reloadFromDisk();
        const t = +(q("t") ?? store.playhead);
        const path = out(q("path") ?? `renders/frame_${t.toFixed(2)}.png`);
        store.clearErrors();
        const png = await renderFramePNG(renderer, t, +(q("scale") ?? 0.5));
        await fs.writeBytes(path, png);
        return respond(req.id, 200, { path, t, errors: store.errors.slice(-10) });
      }
      case "/frames": {
        await store.reloadFromDisk();
        const from = +(q("from") ?? 0), to = +(q("to") ?? store.duration), count = Math.max(1, Math.min(24, +(q("count") ?? 6)));
        const path = out(q("path") ?? "renders/contact_sheet.png");
        store.clearErrors();
        const png = await renderContactSheet(renderer, from, Math.max(from, to - 1 / store.fps), count, +(q("scale") ?? 0.3));
        await fs.writeBytes(path, png);
        return respond(req.id, 200, { path, from, to, count, errors: store.errors.slice(-10) });
      }
      case "/import": {
        const media = await importFiles((body.paths ?? []).map((p: string) => out(p)), !!body.copy);
        return respond(req.id, 200, { media });
      }
      case "/transcribe": {
        const m = store.project.media.find((x) => x.id === q("media"));
        if (!m) return respond(req.id, 404, { error: "unknown media id" });
        const segments = await transcribe(m, q("force") === "1");
        return respond(req.id, 200, { path: `transcripts/${m.id}.json`, segments });
      }
      case "/captions": {
        const n = await captionsFor(q("media") ?? "", q("track") ?? undefined);
        return respond(req.id, 200, { ok: true, captions: n });
      }
      case "/process": {
        await store.reloadFromDisk();
        const c = store.clip(q("clip") ?? "");
        if (!c) return respond(req.id, 404, { error: "unknown clip id" });
        const op = q("op") ?? "";
        let result: any = null;
        if (op === "scenes") result = await sceneDetect(c, +(q("threshold") ?? 0.32));
        else if (op === "silence") result = await removeSilence(c, +(q("noise") ?? -32), +(q("min") ?? 0.45));
        else if (op === "normalize") result = await normalizeLoudness(c, +(q("target") ?? -14));
        else if (op === "beats") result = detectBeats(c);
        else if (op in PROCS) result = await processClip(c, op as any);
        else return respond(req.id, 400, { error: "op must be scenes|silence|normalize|beats|" + Object.keys(PROCS).join("|") });
        await store.save();
        return respond(req.id, 200, { ok: true, result });
      }
      case "/export": {
        await store.reloadFromDisk();
        const path = await exportVideo(renderer, { out: body.out ?? "renders/export.mp4", codec: body.codec ?? "h264", quality: crf(body.quality), from: body.from, to: body.to, width: body.width, height: body.height }, () => {});
        return respond(req.id, 200, { ok: true, path });
      }
      default:
        return respond(req.id, 404, { error: "unknown endpoint", endpoints: ["/state", "/errors", "/frame", "/frames", "/reload", "/seek", "/play", "/pause", "/import", "/transcribe", "/captions", "/export"] });
    }
  } catch (e: any) {
    return respond(req.id, 500, { error: e?.message ?? String(e) });
  }
}
