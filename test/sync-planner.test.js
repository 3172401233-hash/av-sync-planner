import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncPlanner, Action, Reason, Phase } from '../src/index.js';

const SR = 48000;

function makeFrames(startPts, count, durationOf) {
  const frames = [];
  let pts = startPts;
  for (let i = 0; i < count; i += 1) {
    const duration = typeof durationOf === 'function' ? durationOf(i) : durationOf;
    frames.push({ pts, duration });
    pts += duration;
  }
  return frames;
}

function displayedPts(decisions) {
  return decisions.filter((d) => d.action === Action.DISPLAY).map((d) => d.pts);
}

function countBy(decisions, action) {
  return decisions.filter((d) => d.action === action).length;
}

function assertStrictlyIncreasing(pts) {
  for (let i = 1; i < pts.length; i += 1) {
    assert.ok(pts[i] > pts[i - 1], `pts not increasing at ${i}: ${pts[i - 1]} -> ${pts[i]}`);
  }
}

function maxConsecutive(decisions, action) {
  let max = 0;
  let run = 0;
  for (const d of decisions) {
    run = d.action === action ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

test('VFR sequence: order preserved, every decision has reason and drift', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  const pattern = [1 / 30, 1 / 30, 1 / 60, 1 / 24, 1 / 30, 1 / 60, 1 / 60, 1 / 24];
  const frames = makeFrames(0, 240, (i) => pattern[i % pattern.length]);

  const all = [];
  let samples = 0;
  const chunk = 4;
  for (let i = 0; i < frames.length; i += chunk) {
    const batch = frames.slice(i, i + chunk);
    samples += Math.round(batch.reduce((s, f) => s + f.duration, 0) * SR);
    const { decisions } = planner.plan({ audioSamplesPlayed: samples, frames: batch });
    all.push(...decisions);
  }

  assertStrictlyIncreasing(displayedPts(all));
  for (const d of all) {
    assert.ok(typeof d.reason === 'string' && d.reason.length > 0);
    if (d.action !== Action.DROP || d.reason === Reason.LATE_DROP) {
      assert.ok(typeof d.driftMs === 'number');
    }
  }
  // Gentle VFR around the audio rate: few corrections, no drop storms.
  assert.ok(countBy(all, Action.DROP) <= 3);
  assert.ok(maxConsecutive(all, Action.DROP) <= 1);
});

test('sustained clock drift over 20 simulated minutes stays bounded', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  // Frames stamped at 1/30.03 spacing while the audio clock runs at true
  // 30 fps cadence: video falls behind ~2 ms per second, ~2.4 s over 20 min.
  const frameDuration = 1 / 30.03;
  const framesPerTick = 2;
  const audioStepSec = framesPerTick / 30;
  const seconds = 20 * 60;
  const all = [];
  let pts = 0;
  let samples = 0;
  const ticks = seconds * 30;
  for (let tick = 0; tick < ticks; tick += 1) {
    const batch = makeFrames(pts, framesPerTick, frameDuration);
    pts = batch[batch.length - 1].pts + frameDuration;
    samples += Math.round(audioStepSec * SR);
    const { decisions } = planner.plan({ audioSamplesPlayed: samples, frames: batch });
    all.push(...decisions);
  }

  assertStrictlyIncreasing(displayedPts(all));
  const drops = countBy(all, Action.DROP);
  // Expected drops ~= accumulated drift / frame duration = 2.4 s / 33 ms.
  assert.ok(drops >= 40 && drops <= 110, `drops=${drops} outside [40, 110]`);
  assert.ok(maxConsecutive(all, Action.DROP) <= 2);
  // Drift estimate must stay bounded: corrections prevent accumulation.
  const maxAbsDrift = Math.max(...all.map((d) => Math.abs(d.driftMs ?? 0)));
  assert.ok(maxAbsDrift < 500, `drift grew unbounded: ${maxAbsDrift} ms`);
});

test('seek discards queued state and re-anchors on the new position', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  planner.plan({ audioSamplesPlayed: 0, frames: makeFrames(0, 5, 1 / 30) });
  planner.plan({ audioSamplesPlayed: SR / 6, frames: makeFrames(5 / 30, 5, 1 / 30) });

  planner.notifySeek();
  assert.equal(planner.phase, Phase.RESYNC);

  const { decisions, phase } = planner.plan({
    audioSamplesPlayed: 0,
    frames: makeFrames(100, 4, 1 / 30),
  });
  assert.equal(phase, Phase.LOCKED);
  assert.equal(decisions[0].action, Action.DISPLAY);
  assert.equal(decisions[0].reason, Reason.RESYNC_ANCHOR);
  assert.deepEqual(displayedPts(decisions), [100, 100 + 1 / 30, 100 + 2 / 30, 100 + 3 / 30]);

  // No stale frames from before the seek leak into later plans.
  const next = planner.plan({ audioSamplesPlayed: SR / 6, frames: makeFrames(104 / 30, 3, 1 / 30) });
  assert.ok(displayedPts(next.decisions).every((p) => p >= 100));
});

test('timestamp jump without explicit seek triggers automatic resync', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  planner.plan({ audioSamplesPlayed: 0, frames: makeFrames(0, 3, 1 / 30) });
  planner.plan({ audioSamplesPlayed: SR / 10, frames: makeFrames(3 / 30, 3, 1 / 30) });

  // pts jumps 4 s forward: long-gap discontinuity.
  const { decisions } = planner.plan({
    audioSamplesPlayed: SR / 5,
    frames: makeFrames(6 / 30 + 4, 3, 1 / 30),
  });
  assert.equal(decisions[0].reason, Reason.LONG_GAP_RESYNC);
  assert.equal(decisions[0].action, Action.DISPLAY);
  assertStrictlyIncreasing(displayedPts(decisions));
});

test('empty audio buffer: video lead is capped, excess frames deferred', () => {
  const maxVideoLeadMs = 250;
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60, maxVideoLeadMs });
  planner.plan({ audioSamplesPlayed: 0, frames: makeFrames(0, 1, 1 / 30) });

  const frames = makeFrames(1 / 30, 30, 1 / 30);
  const { decisions } = planner.plan({
    audioSamplesPlayed: 0, // audio clock frozen
    audioBufferEmpty: true,
    frames,
  });

  const shown = displayedPts(decisions);
  const defers = countBy(decisions, Action.DEFER);
  // Lead cap 250 ms at ~33 ms/frame: at most 8 frames beyond the anchor.
  assert.ok(shown.length <= 9, `displayed ${shown.length} frames with empty audio`);
  assert.ok(defers >= 20, `expected most frames deferred, got ${defers}`);
  assert.ok(shown[shown.length - 1] <= maxVideoLeadMs / 1000 + 1 / 30 + 1e-9);
  assert.equal(countBy(decisions, Action.DROP), 0);
  assert.ok(decisions.every((d) => d.action !== Action.DEFER || d.reason === Reason.AUDIO_EMPTY_DEFER));
  // Repeats are bounded per frame.
  assert.ok(maxConsecutive(decisions, Action.REPEAT) <= 3);
});

test('refresh rate change resyncs cleanly without a drop burst', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  const framesPerTick = 2;
  const audioStep = Math.round((framesPerTick / 30) * SR);
  const runTicks = (startPts, ticks, startSamples) => {
    const out = [];
    let pts = startPts;
    let samples = startSamples;
    for (let i = 0; i < ticks; i += 1) {
      const batch = makeFrames(pts, framesPerTick, 1 / 30);
      pts = batch[batch.length - 1].pts + 1 / 30;
      samples += audioStep;
      out.push(...planner.plan({ audioSamplesPlayed: samples, frames: batch }).decisions);
    }
    return { decisions: out, pts, samples };
  };

  let all = [];
  const before = runTicks(0, 60, 0); // 2 s at 60 Hz
  all = all.concat(before.decisions);

  planner.setRefreshRate(144);
  assert.equal(planner.phase, Phase.RESYNC);

  const after = runTicks(before.pts, 60, before.samples); // 2 s at 144 Hz
  all = all.concat(after.decisions);

  assert.equal(after.decisions[0].reason, Reason.RESYNC_ANCHOR);
  assertStrictlyIncreasing(displayedPts(all));
  assert.ok(maxConsecutive(after.decisions, Action.DROP) <= 1, 'drop burst after refresh change');
  assert.ok(countBy(after.decisions, Action.DROP) <= 1);
});

test('duplicate, out-of-order and zero-duration frames are rejected with reasons', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  // Feed one frame per call with the audio clock advancing per frame.
  const frames = [
    { pts: 0, duration: 1 / 30 },
    { pts: 0, duration: 1 / 30 }, // duplicate
    { pts: 1 / 30, duration: 0 }, // zero duration
    { pts: 1 / 30, duration: 1 / 30 },
    { pts: 0.01, duration: 1 / 30 }, // out of order
    { pts: 2 / 30, duration: 1 / 30 },
  ];
  const decisions = [];
  frames.forEach((frame, i) => {
    const { decisions: batch } = planner.plan({
      audioSamplesPlayed: Math.round(((i + 1) / 30) * SR),
      frames: [frame],
    });
    decisions.push(...batch);
  });
  assert.deepEqual(
    decisions.map((d) => [d.action, d.reason]),
    [
      [Action.DISPLAY, Reason.RESYNC_ANCHOR],
      [Action.DROP, Reason.DUPLICATE_TIMESTAMP],
      [Action.DROP, Reason.ZERO_DURATION],
      [Action.DISPLAY, Reason.IN_TOLERANCE],
      [Action.DROP, Reason.OUT_OF_ORDER_PTS],
      [Action.DISPLAY, Reason.IN_TOLERANCE],
    ],
  );
});

test('late first frame is anchored and flagged, not dropped', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  // Audio has already been playing for 2 s when the first frame (pts 0) shows up.
  const { decisions } = planner.plan({
    audioSamplesPlayed: 2 * SR,
    frames: makeFrames(0, 3, 1 / 30),
  });
  assert.equal(decisions[0].action, Action.DISPLAY);
  assert.equal(decisions[0].reason, Reason.LATE_FIRST_FRAME);
  assert.ok(decisions[0].driftMs < -1000);
  assertStrictlyIncreasing(displayedPts(decisions));
});

test('audio clock jump backwards forces resync', () => {
  const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
  planner.plan({ audioSamplesPlayed: 10 * SR, frames: makeFrames(10, 3, 1 / 30) });
  const { decisions } = planner.plan({
    audioSamplesPlayed: 2 * SR, // clock jumped backwards
    frames: makeFrames(2, 3, 1 / 30),
  });
  assert.equal(decisions[0].reason, Reason.RESYNC_ANCHOR);
  assert.equal(decisions[0].pts, 2);
});

test('deterministic: identical input sequences produce identical plans', () => {
  const runScript = () => {
    const planner = new SyncPlanner({ sampleRate: SR, refreshRate: 60 });
    const out = [];
    let pts = 0;
    for (let sec = 0; sec < 30; sec += 1) {
      const batch = makeFrames(pts, 30, 1 / 29.97);
      pts = batch[batch.length - 1].pts + 1 / 29.97;
      out.push(...planner.plan({ audioSamplesPlayed: (sec + 1) * SR, frames: batch }).decisions);
    }
    planner.notifySeek();
    out.push(...planner.plan({ audioSamplesPlayed: 0, frames: makeFrames(500, 30, 1 / 30) }).decisions);
    planner.setRefreshRate(144);
    out.push(...planner.plan({ audioSamplesPlayed: SR, frames: makeFrames(501, 30, 1 / 30) }).decisions);
    out.push(
      ...planner.plan({
        audioSamplesPlayed: SR,
        audioBufferEmpty: true,
        frames: makeFrames(502, 30, 1 / 30),
      }).decisions,
    );
    return out;
  };
  assert.deepEqual(runScript(), runScript());
});
