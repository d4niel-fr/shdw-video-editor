// shdw HTML runtime — injected before any page script. Virtualizes time so
// GSAP, CSS animations/transitions, Web Animations, requestAnimationFrame,
// performance.now/Date.now driven code (React "Stage"/useTime, anime.js,
// canvas loops, Lottie, three.js) render deterministically at any frame.
(() => {
  if (window.__shdw) return;
  let T = 0; // ms
  const EPOCH = 1700000000000;
  const realSetTimeout = window.setTimeout.bind(window);
  let rafQ = new Map(); let rafId = 1;
  const errors = [];
  const frameFns = [];
  const q = new URLSearchParams(location.search);

  const _perfNow = performance.now.bind(performance);
  performance.now = () => T;
  const _DateNow = Date.now;
  Date.now = () => EPOCH + T;
  const RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(EPOCH + T); } static now() { return EPOCH + T; } };
  window.requestAnimationFrame = (cb) => { const id = rafId++; rafQ.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { rafQ.delete(id); };
  window.addEventListener("error", (e) => errors.push(String(e.message || e.error)));
  window.addEventListener("unhandledrejection", (e) => errors.push("unhandled rejection: " + String(e.reason)));
  const origErr = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(" ")); origErr(...a); };

  const tick = () => new Promise((r) => realSetTimeout(r, 0));
  // user hooks can't stall the renderer: cap each at 6s
  const capped = (p, what) => Promise.race([Promise.resolve(p), new Promise((r) => realSetTimeout(() => { errors.push(what + " timed out after 6s"); r(); }, 6000))]);

  const api = {
    width: +q.get("w") || innerWidth,
    height: +q.get("h") || innerHeight,
    time: 0, duration: 0, progress: 0, params: {},
    /** register a per-frame callback: fn(t, api) — may be async */
    onFrame(fn) { frameFns.push(fn); },
    ready() { try { if (window.gsap) { gsap.ticker.lagSmoothing(0); } } catch (e) {} },
    /** sync part shared by exact and live frames: params, CSS vars, timelines, CSS animations */
    apply(t, params, duration) {
      const changed = JSON.stringify(params || {}) !== JSON.stringify(api.params);
      api.params = params || {}; api.duration = duration; api.time = t; api.progress = duration ? t / duration : 0;
      T = t * 1000;
      if (changed) {
        for (const [k, v] of Object.entries(api.params)) {
          document.querySelectorAll(`[data-param="${k}"]`).forEach((el) => { el.textContent = String(v); });
          if (typeof v === "string" && v.startsWith("#")) document.documentElement.style.setProperty(`--${k}`, v);
          else if (typeof v === "number") document.documentElement.style.setProperty(`--${k}`, String(v));
        }
        window.dispatchEvent(new CustomEvent("shdw:params", { detail: api.params }));
      }
      document.documentElement.style.setProperty("--t", String(t));
      document.documentElement.style.setProperty("--shdw-progress", String(api.progress));
      // GSAP: global timeline + any paused timelines the author created
      try {
        if (window.gsap) {
          gsap.globalTimeline.pause();
          gsap.globalTimeline.time(t, false);
          for (const tl of gsap.globalTimeline.getChildren(false, true, true)) { if (tl.paused && tl.paused()) tl.time(Math.max(0, t), false); }
        }
        for (const name of ["tl", "timeline", "master", "mainTimeline"]) {
          const tl = window[name];
          if (tl && typeof tl.time === "function" && tl !== (window.gsap && gsap.globalTimeline)) { tl.pause && tl.pause(); tl.time(t, false); }
        }
        if (window.anime && Array.isArray(window.animations)) window.animations.forEach((a) => a.seek(T));
      } catch (e) { errors.push("timeline: " + e); }
      // CSS animations / transitions / WAAPI
      try { for (const a of document.getAnimations()) { a.pause(); a.currentTime = T; } } catch (e) {}
    },
    async frame(t, params, duration) {
      api.apply(t, params, duration);
      // <video>/<audio> inside the composition
      const vids = [...document.querySelectorAll("video")];
      await Promise.all(vids.map((v) => new Promise((res) => {
        v.muted = true; v.pause();
        const off = parseFloat(v.dataset.start || "0");
        const want = Math.max(0, t - off) * (parseFloat(v.dataset.rate || "1"));
        if (Math.abs(v.currentTime - want) < 0.001 && v.readyState >= 2) return res();
        const done = () => { v.removeEventListener("seeked", done); res(); };
        v.addEventListener("seeked", done); realSetTimeout(done, 3000);
        v.currentTime = want;
      })));
      // rAF-driven code (React useTime, canvas loops, three.js, Lottie autoplay)
      for (let pass = 0; pass < 2; pass++) {
        const cbs = rafQ; rafQ = new Map();
        for (const cb of cbs.values()) { try { cb(T); } catch (e) { errors.push(String(e && e.stack || e)); } }
        await tick();
      }
      // explicit hooks
      for (const fn of frameFns) { try { await capped(fn(t, api), "shdw.onFrame hook"); } catch (e) { errors.push(String(e && e.stack || e)); } }
      for (const name of ["shdwRender", "render", "seek", "renderFrame"]) {
        if (typeof window[name] === "function") { try { await capped(window[name](t, api), name + "()"); } catch (e) { errors.push(String(e && e.stack || e)); } break; }
      }
      try { await capped(document.fonts.ready, "font loading"); } catch (e) {}
      await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; realSetTimeout(r, 3000); })));
      await tick();
      return errors.splice(0);
    },
  };

  // ---------- live preview (editor viewer iframe) ----------
  let liveBusy = false, livePending = null;
  async function live(m) {
    api.apply(m.t, m.params, m.duration);
    for (const v of document.querySelectorAll("video")) {
      v.muted = true;
      const want = Math.max(0, m.t - parseFloat(v.dataset.start || "0")) * parseFloat(v.dataset.rate || "1");
      if (m.playing) { if (v.paused) v.play().catch(() => {}); if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want; }
      else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want; }
    }
    if (liveBusy) { livePending = m; return; }
    liveBusy = true;
    try {
      const cbs = rafQ; rafQ = new Map();
      for (const cb of cbs.values()) { try { cb(T); } catch (e) {} }
      for (const fn of frameFns) { try { await capped(fn(m.t, api), "shdw.onFrame hook"); } catch (e) {} }
      for (const name of ["shdwRender", "render", "seek", "renderFrame"]) {
        if (typeof window[name] === "function") { try { await capped(window[name](m.t, api), name + "()"); } catch (e) {} break; }
      }
    } finally {
      liveBusy = false;
      errors.length = 0;
      if (!api.drawn) { api.drawn = true; try { parent.postMessage({ shdw: "drawn" }, "*"); } catch (e) {} }
      if (livePending) { const n = livePending; livePending = null; live(n); }
    }
  }
  window.addEventListener("message", (e) => { const m = e.data; if (m && m.shdw === "frame") live(m); });
  window.__shdw = api;
  window.shdw = api;
})();
