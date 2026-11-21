export const PREVIEW_OUTPUT_EDGE = 2048;
export const BACKGROUND_PREVIEW_EDGE = 1280;

export function getBatchPreviewEdge({ index, priorityIndex, speculative = false }) {
  return !speculative && index === priorityIndex ? PREVIEW_OUTPUT_EDGE : BACKGROUND_PREVIEW_EDGE;
}

export function isBatchPreviewReady(photo, job) {
  return Boolean(photo) && (photo.previewMaxEdge ?? PREVIEW_OUTPUT_EDGE) >= getBatchPreviewEdge(job);
}
