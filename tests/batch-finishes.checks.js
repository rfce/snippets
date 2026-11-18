import {
  createFinishedPhoto,
  getFinishCacheKey,
  getFinishProcessingOrder,
  getFinishRenderKey,
  getPhotoAnalysisKey,
  getStaleFinishKeys,
  pickNextAnalysisJob,
  pickNextFinishJob,
  summarizeFinishes,
} from '../src/batch-finishes.js';
import { getBatchPhotoId } from '../src/batch-workflow.js';

export async function runBatchFinishesChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
  const check = async (name, run) => { await run(); passed.push(name); };
  const capture = (name) => ({ uri: `file:///${name}.jpg`, width: 1200, height: 1600 });
  const review = (photo, uri = photo.uri) => ({ ...photo, uri, sourcePhoto: photo });

  await check('invert settings are part of the render key; other finishes ignore them', async () => {
    const soft = getFinishRenderKey('invert', { inkClarity: 'soft' });
    const crisp = getFinishRenderKey('invert', { inkClarity: 'crisp' });
    assert(soft !== crisp, 'different invert settings need different results');
    assert(getFinishRenderKey('magicColor', { inkClarity: 'soft' }) === 'magicColor', 'no settings for magic color');
  });

  await check('processing starts at the viewed image, then continues forward, then wraps', async () => {
    equal(getFinishProcessingOrder(5, 2), [2, 3, 4, 0, 1], 'viewed image first');
    equal(getFinishProcessingOrder(3, 9), [2, 0, 1], 'out-of-range priority is clamped');
    equal(getFinishProcessingOrder(0, 0), [], 'empty batch');
  });

  await check('the next job skips settled results and follows priority', async () => {
    const photos = ['a', 'b', 'c'].map((name) => review(capture(name)));
    const settled = new Set([getFinishCacheKey(photos[1], 'magicColor')]);
    const job = pickNextFinishJob({
      photos, renderKey: 'magicColor', priorityIndex: 1, isSettled: (key) => settled.has(key),
    });
    assert(job.index === 2, 'skip the finished viewed image and continue with the next');
    settled.add(job.key);
    settled.add(getFinishCacheKey(photos[0], 'magicColor'));
    assert(pickNextFinishJob({ photos, renderKey: 'magicColor', priorityIndex: 1, isSettled: (key) => settled.has(key) }) === null,
      'nothing left once every image is settled');
  });

  await check('re-edited and deleted images are stale; unchanged images are kept', async () => {
    const a = capture('a');
    const b = capture('b');
    const before = [review(a), review(b)];
    const keys = [getFinishCacheKey(before[0], 'blackAndWhite'), getFinishCacheKey(before[1], 'blackAndWhite')];
    // Image a was cropped (new pixels, same capture); image b was deleted.
    const after = [review(a, 'file:///a-cropped.png')];
    equal(getStaleFinishKeys(keys, after), keys, 'both results are stale');
    equal(getStaleFinishKeys(keys, before), [], 'nothing is stale when the batch is unchanged');
  });

  await check('finished photos keep the original capture identity for saving', async () => {
    const photo = review(capture('a'));
    const finished = createFinishedPhoto(photo, { uri: 'file:///a-bw.jpg', width: 900, height: 1200, temporary: true });
    assert(finished.uri === 'file:///a-bw.jpg' && finished.temporary, 'use processed pixels');
    assert(getBatchPhotoId(finished) === getBatchPhotoId(photo), 'retry deduplication still matches the capture');
  });

  await check('summary fills in per image and only offers a complete batch for saving', async () => {
    const photos = ['a', 'b', 'c'].map((name) => review(capture(name)));
    const cache = new Map([[getFinishCacheKey(photos[0], 'magicColor'), { ...photos[0], uri: 'file:///a-mc.jpg' }]]);
    const failures = new Map([[getFinishCacheKey(photos[2], 'magicColor'), new Error('gl')]]);
    const partial = summarizeFinishes({
      photos, mode: 'magicColor', renderKey: 'magicColor', cache, failures,
      activeKey: getFinishCacheKey(photos[1], 'magicColor'),
    });
    equal(partial.statuses, ['done', 'processing', 'error'], 'per-image states');
    assert(partial.displayed[0].uri === 'file:///a-mc.jpg' && partial.displayed[1] === photos[1], 'show results as they land');
    assert(partial.completed === 1 && partial.failed === 1 && partial.selectedPhotos === null, 'incomplete batch cannot be saved');

    photos.slice(1).forEach((photo) => cache.set(getFinishCacheKey(photo, 'magicColor'), { ...photo }));
    const complete = summarizeFinishes({
      photos, mode: 'magicColor', renderKey: 'magicColor', cache, failures: new Map(), activeKey: null,
    });
    assert(complete.selectedPhotos?.length === 3, 'complete batch is ready to save');

    const original = summarizeFinishes({ photos, mode: 'original', renderKey: 'original', cache, failures, activeKey: null });
    assert(original.selectedPhotos === photos && original.statuses.every((status) => status === null), 'original needs no processing');
  });

  await check('page analysis is prepared from the viewed image, once per original capture', async () => {
    const captures = ['a', 'b', 'c', 'd'].map(capture);
    // Edited photos carry their original capture; analysis belongs to that capture.
    const photos = captures.map((photo, index) => (index === 1 ? review(photo, 'file:///b-edited.jpg') : review(photo)));
    const done = new Set([getPhotoAnalysisKey(captures[2])]);
    const skipped = new Set([getPhotoAnalysisKey(captures[3])]);
    const pick = (priorityIndex) => pickNextAnalysisJob({
      photos, priorityIndex, skipped, hasAnalysis: (source) => done.has(getPhotoAnalysisKey(source)),
    });

    assert(pick(2).index === 0 && pick(2).source === captures[0], 'skips done and unpreparable photos, wraps around');
    assert(pick(1).index === 1 && pick(1).source.uri === captures[1].uri,
      'an edited photo is analysed from its original capture, not its edited copy');
    done.add(getPhotoAnalysisKey(captures[0]));
    done.add(getPhotoAnalysisKey(captures[1]));
    assert(pick(0) === null, 'nothing left to prepare');
    assert(pickNextAnalysisJob({ photos: [], priorityIndex: 0, skipped, hasAnalysis: () => false }) === null,
      'empty batch');
  });

  return passed;
}
