// Runs agent/html_runtime.js against a minimal fake page (no browser needed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// RUNTIME_FILE lets the suite be pointed at another runtime (e.g. to prove the tests fail on the old one).
const SRC = fs.readFileSync(process.env.RUNTIME_FILE ?? new URL("./html_runtime.js", import.meta.url), "utf8");
// The runtime overwrites Date.now/performance.now inside the page. Time the tests with the real clock, and keep
// Date and the other built-ins out of the fake page so the vm context gets its own and cannot leak into ours.
const realNow = () => globalThis.performance.now();

function loadRuntime() {
  const win = {
    setTimeout, clearTimeout, console, URLSearchParams,
    performance: { now: realNow }, // real clock; the runtime virtualizes the page's copy itself
    location: { search: "?w=1920&h=1080" },
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class {},
    parent: { postMessage() {} },
  };
  win.window = win;
  win.document = {
    querySelectorAll: () => [],
    documentElement: { style: { setProperty() {} } },
    getAnimations: () => [],
    fonts: { ready: Promise.resolve() },
    images: [],
  };
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return win.__shdw;
}

/** A GSAP-like timeline: chainable setter that is also a thenable resolving only when it "completes". */
function thenableTimeline() {
  const tl = { time: () => tl, then: () => {} /* never calls back: a paused timeline never completes */ };
  return tl;
}

async function timed(fn) {
  const t0 = realNow();
  const result = await fn();
  return { result, ms: Math.round(realNow() - t0) };
}

test("a hook that returns a thenable (GSAP timeline) does not stall frame()", async () => {
  const api = loadRuntime();
  const tl = thenableTimeline();
  api.onFrame((t) => tl.time(t)); // the form the agent guide recommended
  const { result, ms } = await timed(() => api.frame(0.5, {}, 4));
  assert.ok(ms < 1000, `frame() took ${ms} ms, expected < 1000`);
  assert.equal(JSON.stringify(result), "[]"); // JSON: the array comes from another vm realm
});

test("an async hook is still awaited", async () => {
  const api = loadRuntime();
  let done = false;
  api.onFrame(async () => { await new Promise((r) => setTimeout(r, 50)); done = true; });
  await api.frame(0.1, {}, 4);
  assert.equal(done, true);
});

test("a hanging async hook is capped and reported", async () => {
  const api = loadRuntime();
  api.onFrame(() => new Promise(() => {}));
  const { result, ms } = await timed(() => api.frame(0.1, {}, 4));
  assert.ok(ms < 7500, `cap not applied (${ms} ms)`);
  assert.ok(result.some((e) => e.includes("timed out")), JSON.stringify(result));
});

test("many slow hooks share one frame budget below the 25 s renderer deadline", { timeout: 40000 }, async () => {
  const api = loadRuntime();
  for (let i = 0; i < 8; i++) api.onFrame(() => new Promise(() => {}));
  const { result, ms } = await timed(() => api.frame(0.1, {}, 4));
  assert.ok(ms < 20000, `frame() took ${ms} ms, expected the shared budget to end it before 20 s`);
  assert.ok(result.length >= 1);
});

test("a hook or font wait that finished in time never reports a timeout later", { timeout: 20000 }, async () => {
  // regression: every capped() call left a 6 s timer running that pushed "timed out" even though the
  // promise had already resolved, so any run longer than 6 s ended with a false error
  const api = loadRuntime();
  api.onFrame(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const first = await api.frame(0.1, {}, 4);
  assert.equal(JSON.stringify(first), "[]");
  await new Promise((r) => setTimeout(r, 6600)); // past the 6 s cap
  const later = await api.frame(0.2, {}, 4);
  assert.equal(JSON.stringify(later), "[]", "stale timer reported: " + JSON.stringify(later));
});
