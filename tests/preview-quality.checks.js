import { getBatchPreviewEdge, isBatchPreviewReady } from '../src/preview-quality.js';
import { getFinishCacheKey, pickNextFinishJob } from '../src/batch-finishes.js';

export async function runPreviewQualityChecks() {
  const passed = [];
  const check = (name, value) => { if (!value) throw new Error(name); passed.push(name); };
  const selected = { index: 1, priorityIndex: 1, speculative: false };
  const background = { index: 0, priorityIndex: 1, speculative: false };
  check('selected page renders at 2048', getBatchPreviewEdge(selected) === 2048);
  check('background pages render at 1280', getBatchPreviewEdge(background) === 1280);
  check('speculative work always uses 1280', getBatchPreviewEdge({ ...selected, speculative: true }) === 1280);
  check('a smaller preview remains usable in the background',
    isBatchPreviewReady({ previewMaxEdge: 1280 }, background));
  check('selecting a smaller preview requests an upgrade',
    !isBatchPreviewReady({ previewMaxEdge: 1280 }, selected));
  check('a finished high-quality preview never needs downgrading',
    isBatchPreviewReady({ previewMaxEdge: 2048 }, background) &&
    isBatchPreviewReady({ previewMaxEdge: 2048 }, selected));
  check('legacy full previews are still reusable', isBatchPreviewReady({ uri: 'old.jpg' }, selected));

  const photos = [0, 1, 2].map((index) => ({ uri: 'file:///' + index + '.jpg' }));
  const cache = new Map(photos.map((photo) =>
    [getFinishCacheKey(photo, 'invert'), { ...photo, previewMaxEdge: 1280 }]));
  const pick = (priorityIndex, speculative = false) => pickNextFinishJob({
    photos, renderKey: 'invert', priorityIndex, speculative,
    isSettled: (key, job) => isBatchPreviewReady(cache.get(key), job),
  });
  check('only the selected cached page upgrades', pick(1)?.index === 1);
  cache.set(getFinishCacheKey(photos[1], 'invert'), { previewMaxEdge: 2048 });
  check('the worker settles after the selected upgrade', pick(1) === null);
  check('swiping requests the incoming page upgrade', pick(2)?.index === 2);
  check('speculation cannot start high-resolution upgrades', pick(2, true) === null);
  check('out-of-range priorities are clamped for readiness', pick(99)?.index === 2);
  return passed;
}
