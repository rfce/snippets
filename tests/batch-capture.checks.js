import {
  appendBatchCaptureFlight, createBatchCapturePlayer, getBatchCaptureFallbackRects,
  getBatchCaptureGeometry, getBatchCaptureMotion, isBatchCaptureRect, resolveBatchCaptureCardGeometry,
  resolveBatchCaptureViewport, snapshotBatchCaptureGeometry,
} from '../src/batch-capture-geometry.js';

export async function runBatchCaptureChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const near = (a, b, message) => assert(Math.abs(a - b) < 1e-8, message);
  const check = (name, run) => { run(); passed.push(name); };
  const viewport = { width: 360, height: 800 };
  const preview = { x: 20, y: 140, width: 300, height: 400 };
  const tray = { x: 36, y: 680, width: 72, height: 72 };
  const origin = { x: 0, y: 0, ...viewport };

  check('portrait photo starts at 80% size with its original aspect ratio', () => {
    const { from } = getBatchCaptureGeometry({ width: 3000, height: 4000 }, preview, tray, origin);
    near(from.width, 240, '80% width');
    near(from.height, 320, '80% height');
    near(from.x + from.width / 2, 170, 'center X');
    near(from.y + from.height / 2, 340, 'center Y');
  });
  check('landscape photo keeps its original aspect ratio', () => {
    const { from } = getBatchCaptureGeometry({ width: 4000, height: 2000 }, preview, tray, origin);
    near(from.width / from.height, 2, 'landscape ratio');
    assert(from.width <= 240 && from.height <= 320, 'fit in 80% camera bounds');
  });
  check('missing native measurement callbacks cannot discard the animation', () => {
    const geometry = snapshotBatchCaptureGeometry({ width: 3000, height: 4000 }, viewport, { top: 24, bottom: 34 });
    assert(geometry && isBatchCaptureRect(geometry.from) && isBatchCaptureRect(geometry.to), 'always supply initial and target frames');
  });
  check('missing, string and invalid photo metadata still produces a visible card', () => {
    for (const photo of [{}, { width: '3000', height: '4000' }, { width: Infinity, height: NaN }]) {
      const geometry = snapshotBatchCaptureGeometry(photo, viewport, {});
      assert(isBatchCaptureRect(geometry.from), 'metadata must not hide a successfully captured photo');
    }
  });
  check('cached native bounds are snapshotted before the overlay opens', () => {
    const bounds = { preview: { ...preview }, tray: { ...tray } };
    const geometry = snapshotBatchCaptureGeometry({ width: 3000, height: 4000 }, viewport, {}, bounds);
    bounds.preview.x = 999;
    bounds.tray.y = 999;
    near(geometry.from.x, 50, 'snapshot source frame');
    near(geometry.to.y, 680, 'snapshot target frame');
  });
  check('native translation and uniform scale land in the thumbnail center', () => {
    const geometry = getBatchCaptureGeometry({ width: 3000, height: 4000 }, preview, tray, origin);
    const motion = getBatchCaptureMotion(geometry);
    near(geometry.from.x + geometry.from.width / 2 + motion.translateX, tray.x + 36, 'end center X');
    near(geometry.from.y + geometry.from.height / 2 + motion.translateY, tray.y + 36, 'end center Y');
    assert(geometry.from.width * motion.scale <= 72 && geometry.from.height * motion.scale <= 72, 'entire photo fits the square');
    near((geometry.from.width * motion.scale) / (geometry.from.height * motion.scale), 0.75, 'uniform aspect ratio throughout');
  });
  check('fallback frames remain valid on short and notched phones', () => {
    for (const size of [{ width: 320, height: 568 }, viewport, { width: 430, height: 932 }]) {
      const rects = getBatchCaptureFallbackRects(size, { top: 44, bottom: 34 });
      assert(isBatchCaptureRect(rects.preview) && isBatchCaptureRect(rects.tray), 'positive dimensions');
      assert(rects.tray.x >= 0 && rects.tray.x + 72 <= size.width && rects.tray.y + 72 <= size.height, 'visible thumbnail destination');
    }
  });
  check('rapid captures keep unique, bounded flight identifiers', () => {
    const original = [{ id: 1 }, { id: 2 }];
    let flights = appendBatchCaptureFlight(original, { id: 3 });
    flights = appendBatchCaptureFlight(flights, { id: 4 });
    flights = appendBatchCaptureFlight(flights, { id: 4 });
    assert(flights.map((item) => item.id).join() === '2,3,4' && original.length === 2, 'bounded immutable queue');
  });

  check('a one-pixel camera viewport uses the real window dimensions', () => {
    const photo = { width: 3000, height: 4000 };
    const expected = snapshotBatchCaptureGeometry(photo, viewport, {});
    const actual = snapshotBatchCaptureGeometry(photo, { width: 360, height: 1 }, {}, {}, 16, viewport);
    near(actual.from.width, expected.from.width, 'window fallback width');
    near(actual.from.height, expected.from.height, 'window fallback height');
    assert(actual.from.height > 100, 'card cannot collapse to a strip');
  });
  check('non-finite and partial viewport dimensions fall back as a pair', () => {
    for (const size of [{ width: Infinity, height: 800 }, { width: 360 }, { width: 1, height: 800 }]) {
      const actual = resolveBatchCaptureViewport(size, viewport);
      near(actual.width, 360, 'fallback viewport width');
      near(actual.height, 800, 'fallback viewport height');
    }
  });
  check('a collapsed cached camera preview cannot flatten the photo', () => {
    const photo = { width: 3000, height: 4000 };
    const expected = snapshotBatchCaptureGeometry(photo, viewport, {});
    for (const badPreview of [
      { ...preview, height: 1 }, { ...preview, width: 1 }, { ...preview, x: 999 },
    ]) {
      const actual = snapshotBatchCaptureGeometry(photo, viewport, {}, { preview: badPreview });
      near(actual.from.width, expected.from.width, 'fallback preview width');
      near(actual.from.height, expected.from.height, 'fallback preview height');
    }
  });
  check('incomplete or implausible photo dimensions use the preview ratio together', () => {
    for (const photo of [
      { width: 3000 }, { height: 4000 }, { width: 3000, height: 1 },
      { width: 1, height: 4000 }, { width: 3000, height: 0 },
      { width: 3000, height: NaN }, { width: 3000, height: Infinity },
    ]) {
      const actual = getBatchCaptureGeometry(photo, preview, tray, origin);
      near(actual.from.width, 240, 'fallback photo width');
      near(actual.from.height, 320, 'fallback photo height');
      near(actual.from.width / actual.from.height, 0.75, 'paired fallback aspect ratio');
    }
  });
  check('the visible card rechecks an already collapsed queued frame', () => {
    const geometry = {
      from: { x: 170, y: 140, width: 0.6, height: 0.8 },
      preview: { ...preview, height: 1 }, to: tray,
      viewport: { width: 360, height: 1 },
    };
    const actual = resolveBatchCaptureCardGeometry({ width: 3000, height: 4000 }, geometry, viewport);
    assert(actual.from.height > 100 && actual.from.width > 100, 'visible card has both dimensions');
    near(actual.from.width / actual.from.height, 0.75, 'visible card aspect ratio');
    near(actual.to.x, tray.x, 'retain valid thumbnail X');
    near(actual.to.y, tray.y, 'retain valid thumbnail Y');
  });
  check('card validation preserves valid camera and tray measurements', () => {
    const photo = { width: 4000, height: 3000 };
    const captured = snapshotBatchCaptureGeometry(photo, viewport, {}, { preview, tray });
    const visible = resolveBatchCaptureCardGeometry(photo, captured, viewport);
    for (const key of ['x', 'y', 'width', 'height']) {
      near(visible.from[key], captured.from[key], 'preserve source ' + key);
      near(visible.to[key], captured.to[key], 'preserve target ' + key);
    }
  });
  check('invalid thumbnail bounds use a visible square destination', () => {
    const geometry = snapshotBatchCaptureGeometry({ width: 3000, height: 4000 }, viewport, {}, {
      preview, tray: { ...tray, height: 1 },
    });
    near(geometry.to.width, 72, 'destination width');
    near(geometry.to.height, 72, 'destination height');
    assert(geometry.to.x >= 0 && geometry.to.y >= 0 &&
      geometry.to.x + 72 <= viewport.width && geometry.to.y + 72 <= viewport.height, 'destination stays on screen');
  });
  check('repaired geometry still scales uniformly into the thumbnail center', () => {
    const geometry = resolveBatchCaptureCardGeometry({ width: 3000, height: 1 }, null, viewport);
    const motion = getBatchCaptureMotion(geometry);
    assert(Number.isFinite(motion.scale) && motion.scale > 0 && motion.scale < 1, 'finite shrinking scale');
    near(geometry.from.x + geometry.from.width / 2 + motion.translateX,
      geometry.to.x + geometry.to.width / 2, 'repaired end center X');
    near(geometry.from.y + geometry.from.height / 2 + motion.translateY,
      geometry.to.y + geometry.to.height / 2, 'repaired end center Y');
    near((geometry.from.width * motion.scale) / (geometry.from.height * motion.scale), 0.75, 'repaired uniform aspect ratio');
  });

  const clock = () => {
    let now = 0, id = 0;
    const jobs = new Map();
    return {
      schedule(fn, delay) { const key = ++id; jobs.set(key, { fn, at: now + delay }); return key; },
      unschedule(key) { jobs.delete(key); },
      advance(ms) {
        const target = now + ms;
        while (true) {
          const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > target) break;
          now = next[1].at; jobs.delete(next[0]); next[1].fn();
        }
        now = target;
      },
    };
  };
  const harness = () => {
    const time = clock();
    const state = { starts: 0, completed: 0, stopped: 0, end: null };
    const player = createBatchCapturePlayer({
      schedule: time.schedule, unschedule: time.unschedule,
      startAnimation: (end) => { state.starts++; state.end = end; return () => state.stopped++; },
      onComplete: () => state.completed++,
    });
    return { time, state, player };
  };
  check('a rendered image cannot start motion before the native overlay is shown', () => {
    const { player, state } = harness();
    player.imageReady();
    assert(state.starts === 0, 'wait for a visible native overlay');
    player.show();
    assert(state.starts === 1, 'start once shown');
  });
  check('overlay show followed by image display starts the same flight once', () => {
    const { player, state } = harness();
    player.show(); player.imageReady(); player.imageReady(); player.show();
    assert(state.starts === 1, 'both event orders and duplicate callbacks are safe');
    state.end(); state.end();
    assert(state.completed === 1, 'single completion');
  });
  check('slow image rendering never starts an empty flight via a timer', () => {
    const { player, state, time } = harness();
    player.show();
    time.advance(350);
    assert(state.starts === 0 && state.completed === 0, 'the old fallback must not reveal a black card');
    time.advance(3000);
    assert(state.starts === 0 && state.completed === 0, 'continue waiting for rendered pixels');
    player.imageReady();
    assert(state.starts === 1 && state.completed === 0, 'start only after image display');
    state.end();
    assert(state.completed === 1, 'complete the rendered flight normally');
  });
  check('an image that never renders is cleaned up without an empty animation', () => {
    const { player, state, time } = harness();
    player.show();
    time.advance(7999);
    assert(state.starts === 0 && state.completed === 0, 'keep waiting invisibly');
    time.advance(1);
    assert(state.starts === 0 && state.completed === 1, 'bounded hidden cleanup');
    player.imageReady();
    assert(state.starts === 0, 'late display must not resurrect an expired flight');
  });
  check('image errors before rendering never reveal or start a flight', () => {
    const { player, state, time } = harness();
    player.show(); player.finish(); player.imageReady(); time.advance(10000);
    assert(state.starts === 0 && state.completed === 1, 'finish hidden and ignore late callbacks');
  });
  check('slow preparation gets a fresh animation budget after show', () => {
    const { player, state, time } = harness();
    time.advance(3000);
    player.imageReady(); player.show();
    time.advance(1000);
    assert(state.starts === 1 && state.completed === 0, 'no premature cleanup');
    state.end();
    assert(state.completed === 1, 'finish only after native animation');
  });
  check('leaving the camera cancels pending readiness and motion', () => {
    const { player, state, time } = harness();
    player.show(); player.dispose(); player.imageReady(); time.advance(10000);
    assert(state.starts === 0 && state.completed === 0, 'no delayed flight after unmount');
  });
  check('native animation cancellation does not update an unmounted screen', () => {
    const { player, state, time } = harness();
    player.show(); player.imageReady(); player.dispose(); state.end(); time.advance(10000);
    assert(state.stopped === 1 && state.completed === 0, 'dispose without stale completion');
  });
  return passed;
}
