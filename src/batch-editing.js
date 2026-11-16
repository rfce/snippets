import { copyCorners, getDefaultCorners, getImageViewport, hasCustomCrop } from './crop-geometry';

function snapshotEdits(edits) {
  const value = Number(edits?.rotation);
  const rotation = Number.isFinite(value) ? value : 0;
  return {
    rotation: ((rotation % 360) + 360) % 360,
    corners: copyCorners(edits?.corners ?? getDefaultCorners()),
  };
}

export function getBatchEditKey(edits) {
  const snapshot = snapshotEdits(edits);
  // Quarter turns can introduce tiny 1 - (1 - x) rounding differences.
  for (const point of Object.values(snapshot.corners)) {
    point.x = Math.round(point.x * 1e8) / 1e8;
    point.y = Math.round(point.y * 1e8) / 1e8;
  }
  return JSON.stringify(snapshot);
}

export async function renderBatchEditAsync(photo, edits, renderPhoto) {
  const snapshot = snapshotEdits(edits);
  const changed = snapshot.rotation !== 0 || hasCustomCrop(snapshot.corners);
  const rendered = changed ? await renderPhoto({
    uri: photo.uri,
    sourceWidth: photo.width,
    sourceHeight: photo.height,
    corners: snapshot.corners,
    rotation: snapshot.rotation,
  }) : photo;
  return { ...photo, ...rendered, sourcePhoto: photo, edits: snapshot };
}

 
// Rotate already-decoded pixels immediately; fitting both axes keeps portrait
// and landscape photos inside the canvas without another native image export.
export function getBatchRotationPreviewStyle(photo, rotation, frame) {
  const sideways = Math.abs(rotation % 180) === 90;
  const ratio = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 4 / 3;
  const viewport = getImageViewport(frame, sideways ? 1 / ratio : ratio, 0);
  return {
    position: 'absolute',
    width: sideways ? viewport.height : viewport.width,
    height: sideways ? viewport.width : viewport.height,
    left: viewport.left + (sideways ? (viewport.width - viewport.height) / 2 : 0),
    top: viewport.top + (sideways ? (viewport.height - viewport.width) / 2 : 0),
    transform: [{ rotate: `${rotation}deg` }],
  };
}

// Only the last tap in a burst is written. An export already in progress may
// finish, but its result cannot replace a newer orientation in the UI.
export function createRotationSaveQueue({
  save, delay = 450, schedule = setTimeout, unschedule = clearTimeout,
}) {
  let active = true;
  let version = 0;
  let savedVersion = 0;
  let pending = null;
  let timer = null;
  let inFlight = null;
  const clearTimer = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };
  const saveLatest = async () => {
    while (inFlight) await inFlight;
    if (!active) return false;
    if (!pending || savedVersion === version) return true;
    const token = version;
    const snapshot = pending;
    const job = Promise.resolve()
      .then(() => save(snapshot, { isCurrent: () => active && token === version }))
      .catch(() => false);
    inFlight = job;
    const saved = await job;
    if (inFlight === job) inFlight = null;
    if (saved && active && token === version) savedVersion = token;
    return saved;
  };
  return {
    stage(edits) {
      if (!active) return;
      pending = snapshotEdits(edits);
      version++;
      clearTimer();
      timer = schedule(() => { timer = null; void saveLatest(); }, delay);
    },
    async flush() {
      clearTimer();
      while (active && pending && savedVersion !== version) {
        const token = version;
        const saved = await saveLatest();
        if (!saved && token === version) return false;
      }
      return active;
    },
    async cancel() {
      clearTimer();
      pending = null;
      savedVersion = ++version;
      while (inFlight) await inFlight;
    },
    dispose() {
      clearTimer();
      active = false;
      version++;
      pending = null;
    },
  };
}
