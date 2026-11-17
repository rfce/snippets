// Aim for a ~5 MP 4:3 batch image rather than the largest sensor output.
export const BATCH_CAPTURE_TARGET_EDGE = 2560;
const MIN_BATCH_CAPTURE_EDGE = 1920;

// Single capture aims for ~12 MP. The GL pipeline never outputs more than a
// 4096 px long edge (MAX_OUTPUT_EDGE in perspective-crop.js), so larger sensor
// sizes (48-200 MP on many Android phones) only slow down the shutter,
// decoding and GPU upload without adding any detail to the result.
export const SINGLE_CAPTURE_TARGET_EDGE = 4096;
// Below this, a document loses fine print, so prefer a larger native size.
const PREFERRED_SINGLE_CAPTURE_EDGE = 3000;

export function selectBatchCaptureSize(sizes) {
  return selectCaptureSize(sizes, {
    targetEdge: BATCH_CAPTURE_TARGET_EDGE,
    minEdge: MIN_BATCH_CAPTURE_EDGE,
  });
}

export function selectSingleCaptureSize(sizes) {
  return selectCaptureSize(sizes, {
    targetEdge: SINGLE_CAPTURE_TARGET_EDGE,
    minEdge: MIN_BATCH_CAPTURE_EDGE,
    preferredMinEdge: PREFERRED_SINGLE_CAPTURE_EDGE,
  });
}

/**
 * Largest supported 4:3 size within `targetEdge`, provided it reaches
 * `preferredMinEdge`; otherwise the smallest 4:3 size above the target.
 * Unknown presets (iOS) and low-resolution-only lists return undefined, which
 * keeps the camera's native default.
 */
export function selectCaptureSize(sizes, { targetEdge, minEdge, preferredMinEdge = minEdge }) {
  if (!Array.isArray(sizes)) return undefined;
  const candidates = sizes.flatMap((size) => {
    if (typeof size !== 'string') return [];
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return [];
    const width = Number(match[1]), height = Number(match[2]);
    const longEdge = Math.max(width, height), shortEdge = Math.min(width, height);
    if (!Number.isSafeInteger(longEdge) || shortEdge <= 0 || longEdge < minEdge ||
      Math.abs(longEdge / shortEdge - 4 / 3) > 0.02) return [];
    return [{ size, longEdge }];
  }).sort((a, b) => a.longEdge - b.longEdge);
  const best = candidates.filter(({ longEdge }) => longEdge <= targetEdge).at(-1);
  if (best && best.longEdge >= preferredMinEdge) return best.size;
  // When no suitable size is offered within the target, use the smallest
  // larger 4:3 option, and only then a smaller one.
  return (candidates.find(({ longEdge }) => longEdge > targetEdge) ?? best)?.size;
}

export function createBatchCaptureSizeController({ getCamera, isBusy, onSize }) {
  let active = false;
  let sequence = 0;
  let queriedCamera = null;
  let pending = null;

  const flush = () => {
    if (!active || isBusy() || pending === null) return;
    const size = pending;
    pending = null;
    // The batch size stays the first argument for existing callers.
    if (getCamera() === size.camera) onSize(size.value.batch, size.value);
  };

  return {
    setActive(value) {
      active = Boolean(value);
      if (!active) {
        sequence += 1;
        queriedCamera = null;
        pending = null;
      }
    },
    async prepare() {
      const camera = getCamera();
      if (!active || !camera || camera === queriedCamera) return;
      queriedCamera = camera;
      const request = ++sequence;
      try {
        const sizes = await camera.getAvailablePictureSizesAsync?.();
        if (!active || request !== sequence || getCamera() !== camera) return;
        // One native query serves both modes, so switching Single/Batch never
        // waits for another lookup.
        const selected = { batch: selectBatchCaptureSize(sizes), single: selectSingleCaptureSize(sizes) };
        if (selected.batch || selected.single) {
          pending = { camera, value: selected };
          flush();
        }
      } catch {
        // Camera/Expo versions without size discovery keep their native default.
      }
    },
    flush,
  };
}
