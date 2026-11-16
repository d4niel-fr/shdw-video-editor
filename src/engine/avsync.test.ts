import test from "node:test";
import assert from "node:assert/strict";
import { decideSync, nextLead, shouldRestartBuffered, BUFFER_DRIFT, BUFFER_SETTLE_MS, HARD_DRIFT, INITIAL_LEAD, SEEK_SETTLE_MS, LEAD_MIN, LEAD_MAX, type SyncAction } from "./avsync.ts";

const settled = Infinity;
const none: SyncAction = { kind: "none" };
const seek: SyncAction = { kind: "seek" };

test("does nothing while a seek is still in flight", () => {
  assert.deepEqual(decideSync({ drift: -2, seeking: true, sinceSeekMs: settled }), none);
});

test("does not re-seek 130 ms after a seek (the voice-restart loop)", () => {
  assert.deepEqual(decideSync({ drift: -0.14, seeking: false, sinceSeekMs: 130 }), none);
  assert.deepEqual(decideSync({ drift: -0.14, seeking: false, sinceSeekMs: settled }), none);
});

test("hard-seeks when badly out of sync and settled", () => {
  assert.deepEqual(decideSync({ drift: -(HARD_DRIFT + 0.2), seeking: false, sinceSeekMs: settled }), seek);
  assert.deepEqual(decideSync({ drift: HARD_DRIFT + 0.2, seeking: false, sinceSeekMs: settled }), seek);
});

test("inside the settle window only a gross failure (> 1 s) may re-seek", () => {
  assert.deepEqual(decideSync({ drift: -0.6, seeking: false, sinceSeekMs: SEEK_SETTLE_MS - 100 }), none);
  assert.deepEqual(decideSync({ drift: -1.2, seeking: false, sinceSeekMs: SEEK_SETTLE_MS - 100 }), seek);
});

test("never asks for a playback-rate change (hangs WKWebView when pausing WebAudio-wired elements)", () => {
  for (const drift of [-0.5, -0.1, -0.02, 0.02, 0.1, 0.5]) {
    const a = decideSync({ drift, seeking: false, sinceSeekMs: settled });
    assert.ok(a.kind === "none" || a.kind === "seek", `unexpected action ${JSON.stringify(a)}`);
  }
});

test("seek lead moves halfway toward the measured latency and stays clamped", () => {
  assert.ok(Math.abs(nextLead(0.12, 0.2) - 0.16) < 1e-9);
  assert.equal(nextLead(0.12, 5), LEAD_MAX);
  assert.equal(nextLead(0.04, 0), LEAD_MIN);
});

/** Tiny model of a media element: after a seek it sits at the target for `seekLatency` s, then plays. */
function simulate(opts: { seekLatency: number; seconds: number; startLag: number }) {
  const dt = 1 / 60;
  let t = 0; // timeline clock
  let ct = -opts.startLag; // element position (starts late, like a cold audio element)
  let lead = INITIAL_LEAD;
  let parkedUntil = 0; // element does not advance until this wall time
  let lastSeek = -Infinity;
  let seeks = 0;
  let maxAbsDrift = 0;
  for (let step = 0; step < opts.seconds / dt; step++) {
    t += dt;
    const seeking = t < parkedUntil;
    if (!seeking) ct += dt;
    const act = decideSync({ drift: ct - t, seeking, sinceSeekMs: (t - lastSeek) * 1000 });
    if (act.kind === "seek") {
      seeks++;
      ct = t + lead; // seek to "want" plus the learned lead
      parkedUntil = t + opts.seekLatency;
      lastSeek = t;
      lead = nextLead(lead, opts.seekLatency); // 'seeked' event reports the latency
    }
    if (t > 3) maxAbsDrift = Math.max(maxAbsDrift, Math.abs(ct - t));
  }
  return { seeks, finalDrift: ct - t, maxAbsDrift };
}

test("regression: with a 140 ms seek latency (WKWebView) the element converges instead of seek-thrashing", () => {
  const r = simulate({ seekLatency: 0.14, seconds: 6, startLag: 0.97 });
  assert.ok(r.seeks <= 2, `expected at most 2 seeks, got ${r.seeks}`);
  assert.ok(Math.abs(r.finalDrift) < 0.08, `final drift ${r.finalDrift}`);
  assert.ok(r.maxAbsDrift < 0.15, `drift after 3 s stayed ${r.maxAbsDrift}`);
});

test("regression: a fast-seeking element (Windows) still converges with few seeks", () => {
  const r = simulate({ seekLatency: 0.02, seconds: 6, startLag: 0.97 });
  assert.ok(r.seeks <= 2, `got ${r.seeks}`);
  assert.ok(Math.abs(r.finalDrift) < 0.08);
});

test("regression: an MP4-with-video audio element that needs ~800 ms to resume converges", () => {
  const r = simulate({ seekLatency: 0.8, seconds: 12, startLag: 0.97 });
  assert.ok(r.seeks <= 4, `got ${r.seeks}`);
  assert.ok(Math.abs(r.finalDrift) < 0.15, `final drift ${r.finalDrift}`);
});

test("regression: a slow 400 ms seek latency still does not thrash", () => {
  const r = simulate({ seekLatency: 0.4, seconds: 8, startLag: 0.97 });
  assert.ok(r.seeks <= 3, `got ${r.seeks}`);
});

test("buffered audio: leaves a source that is in sync alone", () => {
  assert.equal(shouldRestartBuffered({ drift: 0.01, rateChanged: false, sinceStartMs: 5000 }), false);
  assert.equal(shouldRestartBuffered({ drift: -(BUFFER_DRIFT - 0.01), rateChanged: false, sinceStartMs: 5000 }), false);
});

test("buffered audio: restarts when out of tolerance in either direction (restarts are gapless)", () => {
  assert.equal(shouldRestartBuffered({ drift: BUFFER_DRIFT + 0.01, rateChanged: false, sinceStartMs: 5000 }), true);
  assert.equal(shouldRestartBuffered({ drift: -(BUFFER_DRIFT + 0.01), rateChanged: false, sinceStartMs: 5000 }), true);
});

test("buffered audio: restarts when the playback rate changed", () => {
  assert.equal(shouldRestartBuffered({ drift: 0, rateChanged: true, sinceStartMs: 5000 }), true);
});

test("buffered audio: never restarts a source that was only just started (clock jitter)", () => {
  assert.equal(shouldRestartBuffered({ drift: 0.5, rateChanged: false, sinceStartMs: BUFFER_SETTLE_MS - 10 }), false);
  assert.equal(shouldRestartBuffered({ drift: 0, rateChanged: true, sinceStartMs: BUFFER_SETTLE_MS - 10 }), false);
});

test("buffered audio: a clock that runs 0.1% fast needs about one restart a minute, not a stutter", () => {
  let startedAt = 0, restarts = 0;
  for (let ms = 0; ms <= 120000; ms += 16) {
    const drift = ((ms - startedAt) / 1000) * 0.001; // source position runs ahead by 0.1%
    if (shouldRestartBuffered({ drift, rateChanged: false, sinceStartMs: ms - startedAt })) { restarts++; startedAt = ms; }
  }
  assert.ok(restarts >= 1 && restarts <= 3, `restarts ${restarts}`);
});

