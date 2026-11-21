import { getDefaultCorners, hasCustomCrop } from './crop-geometry';
import {
  PREVIEW_OUTPUT_EDGE,
  renderAdaptiveThresholdAsync,
  renderInvertAsync,
  renderMagicColorAsync,
  renderPerspectiveCropAsync,
  yieldToUi,
} from './perspective-crop';

const FINISH_RENDERERS = {
  blackAndWhite: renderAdaptiveThresholdAsync,
  magicColor: renderMagicColorAsync,
  invert: renderInvertAsync,
};

export function isKnownFinish(mode) {
  return mode === 'original' || Boolean(FINISH_RENDERERS[mode]);
}

/** Normalized crop/rotation, or null when the image is used as captured. */
export function getGeometryEdits(edits) {
  const value = Number(edits?.rotation);
  const rotation = Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0;
  const corners = edits?.corners && hasCustomCrop(edits.corners) ? edits.corners : null;
  if (!corners && rotation === 0) return null;
  return { corners: corners ?? getDefaultCorners(), rotation };
}

/**
 * Renders a capture with its crop/rotation edits and a finish in one GPU pass.
 * Crops are metadata until this point: nothing is baked in between.
 *
 * - `source` is always the original capture; it sets the save size and the
 *   reference size for resolution-dependent filters.
 * - `size: 'preview'` caps the output at PREVIEW_OUTPUT_EDGE and reads from
 *   `previewSource` (a downscaled copy) when one is available.
 * - Full-size renders (saves) and `priority: 'low'` work wait behind
 *   on-screen renders on the shared GL context.
 * - On-screen renders first give the UI one frame, so the state that asked
 *   for the render (a pressed finish, an "Applying..." label) paints before
 *   any heavy work starts.
 *
 * Returns the rendered image (`temporary: true`, owned by the caller), or a
 * plain reference to an existing file (no `temporary`, never delete it) when
 * nothing needs rendering (Original with no edits).
 */
export async function renderFinishAsync({
  source, previewSource = null, edits, mode = 'original', invertSettings, size = 'full', priority, shouldCancel, shouldCancelAnalysis, previewMaxEdge = PREVIEW_OUTPUT_EDGE,
}) {
  if (!source?.uri) throw new Error('A captured image is required to render a finish.');
  if (!isKnownFinish(mode)) throw new Error(`Unknown finish: ${mode}`);

  const preview = size === 'preview';
  const edge = Number.isFinite(previewMaxEdge)
    ? Math.max(1, Math.min(PREVIEW_OUTPUT_EDGE, Math.round(previewMaxEdge))) : PREVIEW_OUTPUT_EDGE;
  const input = preview && previewSource?.uri ? previewSource : source;
  const geometry = getGeometryEdits(edits);

  if (mode === 'original' && !geometry) {
    return { uri: input.uri, width: input.width, height: input.height };
  }

  const renderPriority = priority ?? (preview ? 'high' : 'low');
  if (renderPriority === 'high') await yieldToUi();

  const options = {
    uri: input.uri,
    sourceWidth: input.width,
    sourceHeight: input.height,
    ...(geometry ?? {}),
    ...(preview ? { maxOutputEdge: edge } : {}),
    preview,
    referenceWidth: source.width,
    referenceHeight: source.height,
    priority: renderPriority,
    shouldCancel,
    shouldCancelAnalysis,
  };

  const rendered = mode === 'original' ? await renderPerspectiveCropAsync(options)
    : await FINISH_RENDERERS[mode]({
      ...options,
      ...(mode === 'invert' ? { settings: invertSettings } : {}),
    });
  return preview ? { ...rendered, previewMaxEdge: edge } : rendered;
}
