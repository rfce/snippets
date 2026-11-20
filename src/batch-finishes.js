import { getBatchPhotoId } from './batch-workflow';
import { getInvertSettingsKey } from './invert-settings';

// Identifies one finish (and its settings) independently of any photo.
export function getFinishRenderKey(mode, invertSettings) {
  return mode === 'invert' ? `invert:${getInvertSettingsKey(invertSettings)}` : mode;
}

// One processed result per capture, per displayed pixels, per finish. The
// displayed URI changes whenever a crop or rotation is applied, so an edited
// image never reuses a result rendered from its earlier pixels.
export function getFinishCacheKey(photo, renderKey) {
  return JSON.stringify([getBatchPhotoId(photo), photo.uri, renderKey]);
}

function getPhotoSignature(photo) {
  return JSON.stringify([getBatchPhotoId(photo), photo.uri]);
}

function getSignatureFromCacheKey(key) {
  const [id, uri] = JSON.parse(key);
  return JSON.stringify([id, uri]);
}

// The image on screen first, then the ones after it, then the earlier ones,
// so the batch fills in from where the person is looking.
export function getFinishProcessingOrder(count, priorityIndex) {
  if (count <= 0) return [];
  const start = Math.max(0, Math.min(Number.isFinite(priorityIndex) ? priorityIndex : 0, count - 1));
  const order = [];
  for (let index = start; index < count; index += 1) order.push(index);
  for (let index = 0; index < start; index += 1) order.push(index);
  return order;
}

// Idle preparation is deliberately small. Warming a whole stack competes with
// editing and can cycle through the renderer's bounded paper-analysis cache.
export function getIdleBatchPhotos(photos, priorityIndex = 0) {
  const list = photos ?? [];
  return getFinishProcessingOrder(list.length, priorityIndex)
    .slice(0, 2)
    .map((index) => list[index]);
}

export function pickNextFinishJob({ photos, renderKey, priorityIndex, isSettled }) {
  if (!photos?.length) return null;
  for (const index of getFinishProcessingOrder(photos.length, priorityIndex)) {
    const photo = photos[index];
    if (!photo?.uri) continue;
    const key = getFinishCacheKey(photo, renderKey);
    if (!isSettled(key)) return { index, photo, key };
  }
  return null;
}

// Cache keys that no longer match any photo in the batch (deleted images, or
// images whose crop/rotation changed after they were processed).
export function getStaleFinishKeys(keys, photos) {
  const current = new Set((photos ?? []).map(getPhotoSignature));
  return [...keys].filter((key) => !current.has(getSignatureFromCacheKey(key)));
}

// Identifies the page analysis of one source image (matches the renderer's
// cache), so a photo is analysed once however many finishes use it.
export function getPhotoAnalysisKey(photo) {
  return `${photo.uri}|${photo.width}x${photo.height}`;
}

/**
 * The next photo whose page analysis is not ready, starting from the image
 * on screen. `skipped` holds keys that cannot be prepared ahead of time.
 */
export function pickNextAnalysisJob({ photos, priorityIndex, hasAnalysis, skipped }) {
  for (const index of getFinishProcessingOrder(photos?.length ?? 0, priorityIndex)) {
    // Renders read the original capture; edits are applied on the GPU.
    const source = photos[index]?.sourcePhoto ?? photos[index];
    if (!source?.uri || !(source.width > 0 && source.height > 0)) continue;
    const key = getPhotoAnalysisKey(source);
    if (skipped.has(key) || hasAnalysis(source)) continue;
    return { index, source, key };
  }
  return null;
}

// Keeps the save identity of the original capture on the processed file.
export function createFinishedPhoto(photo, rendered) {
  return {
    ...photo,
    ...rendered,
    sourcePhoto: photo.sourcePhoto ?? photo,
    edits: photo.edits,
  };
}

/**
 * Per-index view of the batch for one finish. Statuses: 'done', 'processing',
 * 'queued', 'error', or null for Original.
 */
export function summarizeFinishes({ photos, mode, renderKey, cache, failures, activeKey }) {
  const list = photos ?? [];
  if (mode === 'original') {
    return {
      displayed: list,
      statuses: list.map(() => null),
      completed: list.length,
      failed: 0,
      total: list.length,
      selectedPhotos: list.length ? list : null,
    };
  }

  const displayed = [];
  const statuses = [];
  const finished = [];
  let completed = 0;
  let failed = 0;
  list.forEach((photo) => {
    const key = getFinishCacheKey(photo, renderKey);
    const result = cache.get(key);
    if (result) {
      completed += 1;
      finished.push(result);
      displayed.push(result);
      statuses.push('done');
      return;
    }
    displayed.push(photo);
    if (failures.has(key)) {
      failed += 1;
      statuses.push('error');
    } else {
      statuses.push(key === activeKey ? 'processing' : 'queued');
    }
  });

  return {
    displayed,
    statuses,
    completed,
    failed,
    total: list.length,
    selectedPhotos: list.length && completed === list.length ? finished : null,
  };
}
