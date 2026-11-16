import { createRotationSaveQueue, getBatchEditKey, getBatchRotationPreviewStyle, renderBatchEditAsync } from '../src/batch-editing.js';
import { getDefaultCorners } from '../src/crop-geometry.js';
import { getBatchPhotoId } from '../src/batch-workflow.js';

export async function runBatchEditingChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, run) => { await run(); passed.push(name); };
  const photo = { uri: 'file:///original.jpg', width: 1920, height: 2560 };

  await check('default edits reuse the original without rendering', async () => {
    let calls = 0;
    const result = await renderBatchEditAsync(photo, {}, async () => { calls++; });
    assert(calls === 0 && result.uri === photo.uri, 'no needless processing');
    assert(result.sourcePhoto === photo && result.edits.rotation === 0, 'keep original identity');
  });
  await check('crop is rendered with original dimensions and returned as the preview', async () => {
    const corners = getDefaultCorners(); corners.topLeft.x = 0.15;
    let request;
    const result = await renderBatchEditAsync(photo, { corners, rotation: 0 }, async (options) => {
      request = options;
      return { uri: 'file:///cropped.png', width: 1200, height: 1800, temporary: true };
    });
    assert(request.uri === photo.uri && request.sourceWidth === 1920 && request.sourceHeight === 2560, 'render from original pixels');
    assert(result.uri === 'file:///cropped.png' && result.width === 1200 && result.temporary, 'expose rendered crop');
    assert(getBatchPhotoId(result) === getBatchPhotoId(photo), 'save identity remains the original capture');
  });
  await check('rotation also produces a ready-to-display image', async () => {
    let rotation;
    const result = await renderBatchEditAsync(photo, { rotation: 90 }, async (options) => {
      rotation = options.rotation;
      return { uri: 'file:///rotated.png', width: 2560, height: 1920, temporary: true };
    });
    assert(rotation === 90 && result.uri === 'file:///rotated.png' && result.height === 1920, 'render and use rotated dimensions');
  });
  await check('edit snapshots do not change while native rendering runs', async () => {
    const corners = getDefaultCorners(); corners.topRight.x = 0.85;
    let finish;
    const job = renderBatchEditAsync(photo, { corners, rotation: 90 }, () => new Promise((resolve) => { finish = resolve; }));
    corners.topRight.x = 0.5;
    finish({ uri: 'file:///snapshot.png', temporary: true });
    const result = await job;
    assert(result.edits.corners.topRight.x === 0.85, 'freeze geometry before async work');
  });
  await check('equivalent edit keys support cached apply and rotation reset', () => {
    assert(getBatchEditKey() === getBatchEditKey({ rotation: 360, corners: getDefaultCorners() }), 'full rotations equal the default');
    assert(getBatchEditKey({ rotation: -90 }) === getBatchEditKey({ rotation: 270 }), 'normalize equivalent rotations');
    assert(getBatchEditKey({ rotation: 90 }) !== getBatchEditKey(), 'changed rotation is a new render');
  });
  await check('native errors cannot masquerade as a saved edit', async () => {
    let rejected = false;
    try { await renderBatchEditAsync(photo, { rotation: 90 }, async () => { throw new Error('Render failed'); }); }
    catch { rejected = true; }
    assert(rejected && photo.uri === 'file:///original.jpg', 'preserve original after a failed write');
  });

  const drain = async () => { for (let step = 0; step < 12; step++) await Promise.resolve(); };
  const makeClock = () => {
    let nextId = 0;
    const timers = new Map();
    return {
      schedule(run, delay) { const id = ++nextId; timers.set(id, { run, delay }); return id; },
      unschedule(id) { timers.delete(id); },
      fire() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(({ run }) => run()); },
      get size() { return timers.size; },
      get delay() { return [...timers.values()][0]?.delay; },
    };
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };

  await check('rotation preview fits both axes for portrait, landscape, and cropped pixels', () => {
    for (const size of [{ width: 1200, height: 1800 }, { width: 1800, height: 1200 }]) {
      for (const rotation of [0, 90, 180, 270, -90, -270]) {
        const frame = { width: 360, height: 520 };
        const style = getBatchRotationPreviewStyle(size, rotation, frame);
        const sideways = Math.abs(rotation % 180) === 90;
        const width = sideways ? style.height : style.width;
        const height = sideways ? style.width : style.height;
        assert(width <= frame.width + 0.001 && height <= frame.height + 0.001, 'keep rotated pixels inside the canvas');
        assert(Math.abs(style.left + style.width / 2 - 180) < 0.001, 'center horizontally');
        assert(Math.abs(style.top + style.height / 2 - 260) < 0.001, 'center vertically');
        assert(Math.abs(style.width / style.height - size.width / size.height) < 0.001, 'preserve original aspect ratio');
      }
    }
  });
  await check('quarter-turn rounding still hits the cached crop', () => {
    const corners = getDefaultCorners(); corners.topLeft.x = 0.15;
    const rounded = getDefaultCorners(); rounded.topLeft.x = 1 - (1 - 0.15);
    assert(getBatchEditKey({ corners }) === getBatchEditKey({ corners: rounded }), 'ignore subpixel floating-point noise');
  });
  await check('rapid rotation taps produce one trailing save after 450ms', async () => {
    const clock = makeClock();
    const saved = [];
    const queue = createRotationSaveQueue({ ...clock, save: async (value) => { saved.push(value.rotation); return true; } });
    queue.stage({ rotation: 90 }); queue.stage({ rotation: 180 }); queue.stage({ rotation: 270 });
    assert(saved.length === 0 && clock.size === 1 && clock.delay === 450, 'defer writing until taps stop');
    clock.fire(); await drain();
    assert(saved.join() === '270' && await queue.flush(), 'save only the final rotation');
  });
  await check('staged rotation snapshots cannot be mutated by later crop changes', async () => {
    const clock = makeClock();
    const corners = getDefaultCorners(); corners.topLeft.x = 0.2;
    let saved;
    const queue = createRotationSaveQueue({ ...clock, save: async (value) => { saved = value; return true; } });
    queue.stage({ corners, rotation: 90 });
    corners.topLeft.x = 0.4;
    await queue.flush();
    assert(saved.corners.topLeft.x === 0.2 && clock.size === 0, 'own the queued crop snapshot');
  });
  await check('Done flushes immediately and concurrent flushes share the save', async () => {
    const clock = makeClock();
    const job = deferred();
    let calls = 0;
    const queue = createRotationSaveQueue({ ...clock, save: () => { calls++; return job.promise; } });
    queue.stage({ rotation: 90 });
    const first = queue.flush(); const second = queue.flush();
    await drain();
    assert(calls === 1 && clock.size === 0, 'one immediate export');
    job.resolve(true);
    assert(await first && await second, 'both callers wait for the saved result');
  });
  await check('new taps invalidate an older export and serialize the latest save', async () => {
    const clock = makeClock();
    const requests = [];
    const queue = createRotationSaveQueue({ ...clock, save: (edits, options) => {
      const job = deferred(); requests.push({ edits, options, job }); return job.promise;
    } });
    queue.stage({ rotation: 90 }); clock.fire(); await drain();
    queue.stage({ rotation: 180 }); clock.fire(); await drain();
    assert(requests.length === 1 && !requests[0].options.isCurrent(), 'do not publish the old orientation');
    requests[0].job.resolve(false); await drain();
    assert(requests.length === 2 && requests[1].edits.rotation === 180 && requests[1].options.isCurrent(), 'write newest orientation after old work finishes');
    requests[1].job.resolve(true); await drain();
    assert(await queue.flush(), 'latest orientation is saved');
  });
  await check('an explicit flush retries a failed background save', async () => {
    const clock = makeClock();
    let calls = 0;
    const queue = createRotationSaveQueue({ ...clock, save: async () => {
      if (++calls === 1) throw new Error('Disk busy');
      return true;
    } });
    queue.stage({ rotation: 90 }); clock.fire(); await drain();
    assert(calls === 1 && await queue.flush() && calls === 2, 'retry without losing the draft');
  });
  await check('failed flushes keep the draft available for another attempt', async () => {
    const clock = makeClock();
    let succeeds = false;
    const queue = createRotationSaveQueue({ ...clock, save: async () => succeeds });
    queue.stage({ rotation: 90 });
    assert(!await queue.flush(), 'failure blocks navigation');
    succeeds = true;
    assert(await queue.flush(), 'later retry saves the same draft');
  });
  await check('deleting cancels pending work and waits for an obsolete export', async () => {
    const clock = makeClock();
    const job = deferred(); let request; let cancelled = false;
    const queue = createRotationSaveQueue({ ...clock, save: (_, options) => { request = options; return job.promise; } });
    queue.stage({ rotation: 90 }); clock.fire(); await drain();
    queue.stage({ rotation: 180 });
    const cancellation = queue.cancel().then(() => { cancelled = true; });
    await drain();
    assert(!request.isCurrent() && !cancelled && clock.size === 0, 'invalidate old work before deleting');
    job.resolve(false); await cancellation;
    assert(cancelled && await queue.flush(), 'discard the unsaved orientation');
  });
  await check('unmount clears the timer and rejects late saves', async () => {
    const clock = makeClock(); let calls = 0; let request;
    const job = deferred();
    const queue = createRotationSaveQueue({ ...clock, save: (_, options) => { calls++; request = options; return job.promise; } });
    queue.stage({ rotation: 90 }); clock.fire(); await drain();
    queue.stage({ rotation: 180 }); queue.dispose();
    assert(clock.size === 0 && !request.isCurrent(), 'no timer or late UI update after unmount');
    job.resolve(false); await drain(); clock.fire();
    assert(calls === 1 && !await queue.flush(), 'never export the disposed draft');
  });
  return passed;
}
