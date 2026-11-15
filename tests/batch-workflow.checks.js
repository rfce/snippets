import { getBatchPhotoId, releaseTemporaryImagesAsync, savePendingBatchAsync } from '../src/batch-workflow.js';
import { copyCorners, getDefaultCorners, hasCustomCrop, rotateCornersClockwise } from '../src/crop-geometry.js';

export async function runBatchWorkflowChecks() {
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
  const check = async (name, run) => { await run(); results.push(name); };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  await check('partial batch retry saves only unfinished captures', async () => {
    const photos = ['a', 'b', 'c', 'd'].map((uri) => ({ uri }));
    const savedAssets = new Map();
    const attempts = [];
    let fail = true;
    const progress = [];
    const savePhoto = async (photo) => {
      attempts.push(photo.uri);
      if (photo.uri === 'c' && fail) throw new Error('disk full');
      return { id: 'asset-' + photo.uri };
    };
    let rejected = false;
    try { await savePendingBatchAsync(photos, { savedAssets, savePhoto }); } catch { rejected = true; }
    assert(rejected && savedAssets.size === 2, 'retain exactly the successful saves');
    fail = false;
    await savePendingBatchAsync(photos, { savedAssets, savePhoto, onProgress: (value) => progress.push(value.completed) });
    equal(attempts, ['a', 'b', 'c', 'c', 'd'], 'successful images must never be saved twice');
    equal(progress, [2, 3, 4], 'retry reports cumulative progress');
    await savePendingBatchAsync(photos, { savedAssets, savePhoto });
    assert(attempts.length === 5, 'completed retry performs no native saves');
  });

  await check('save identity follows original capture through crop and enhancement', async () => {
    const original = { uri: 'file://capture.jpg' };
    const cropped = { uri: 'file://crop.png', sourcePhoto: original };
    const enhanced = { ...cropped, uri: 'file://enhanced.jpg' };
    equal(getBatchPhotoId(cropped), getBatchPhotoId(enhanced), 'rendered paths must not change save identity');
    const savedAssets = new Map([[getBatchPhotoId(cropped), { id: 'already-saved' }]]);
    let calls = 0;
    await savePendingBatchAsync([enhanced], { savedAssets, savePhoto: async () => { calls++; } });
    assert(calls === 0, 'derived URI changes must not duplicate saved captures');
  });

  await check('failure on first image leaves the whole batch retryable', async () => {
    const savedAssets = new Map();
    try { await savePendingBatchAsync([{ uri: 'a' }], { savedAssets, savePhoto: async () => { throw new Error('denied'); } }); } catch {}
    assert(savedAssets.size === 0, 'failed native save must not be marked successful');
    await savePendingBatchAsync([{ uri: 'a' }], { savedAssets, savePhoto: async () => ({ id: 'ok' }) });
    assert(savedAssets.size === 1, 'permission/failure recovery can save the image later');
  });

  await check('temporary preview survives unmount until native save resolves', async () => {
    const nativeSave = deferred();
    const image = { uri: 'preview.png', temporary: true };
    let removed = false;
    const cleanup = releaseTemporaryImagesAsync([image], [nativeSave.promise], async (images) => {
      equal(images, [image], 'clean exactly the owned preview');
      removed = true;
    });
    await Promise.resolve();
    assert(!removed, 'native code still owns the file');
    nativeSave.resolve();
    await cleanup;
    assert(removed, 'release file after successful native save');
  });

  await check('temporary files are released after rejected native saves', async () => {
    const nativeSave = deferred();
    let removed = false;
    const cleanup = releaseTemporaryImagesAsync([], [nativeSave.promise], async () => { removed = true; });
    nativeSave.reject(new Error('native save failed'));
    await cleanup;
    assert(removed, 'save rejection must not leak its temporary file');
  });

  await check('cleanup waits for every file consumer', async () => {
    const first = deferred(), second = deferred();
    let removed = false;
    const cleanup = releaseTemporaryImagesAsync([], [first.promise, null, second.promise], async () => { removed = true; });
    first.resolve();
    await Promise.resolve();
    assert(!removed, 'second native operation still owns the files');
    second.resolve();
    await cleanup;
    assert(removed, 'all readers have released ownership');
  });

  await check('four rotations preserve an asymmetric perspective crop', async () => {
    const crop = { topLeft: { x: 0.1, y: 0.15 }, topRight: { x: 0.9, y: 0.2 },
      bottomRight: { x: 0.85, y: 0.8 }, bottomLeft: { x: 0.2, y: 0.9 } };
    let rotated = copyCorners(crop);
    for (let turn = 0; turn < 4; turn++) rotated = rotateCornersClockwise(rotated);
    for (const name of Object.keys(crop)) for (const axis of ['x', 'y']) {
      assert(Math.abs(rotated[name][axis] - crop[name][axis]) < 1e-10, 'rotation must preserve the selected region');
    }
  });

  await check('per-image crop snapshots never mutate neighboring images', async () => {
    const first = copyCorners(getDefaultCorners());
    const second = copyCorners(first);
    first.topLeft.x = 0.2;
    assert(hasCustomCrop(first) && !hasCustomCrop(second), 'crop edits belong only to their image');
  });
  return results;
}
