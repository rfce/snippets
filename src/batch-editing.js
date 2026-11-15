import { copyCorners, getDefaultCorners, hasCustomCrop } from './crop-geometry';

function snapshotEdits(edits) {
  const value = Number(edits?.rotation);
  const rotation = Number.isFinite(value) ? value : 0;
  return {
    rotation: ((rotation % 360) + 360) % 360,
    corners: copyCorners(edits?.corners ?? getDefaultCorners()),
  };
}

export function getBatchEditKey(edits) {
  return JSON.stringify(snapshotEdits(edits));
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
