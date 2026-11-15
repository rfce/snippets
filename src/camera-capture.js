// Aim for a ~5 MP 4:3 batch image rather than the largest sensor output.
// Single capture keeps the camera's full-resolution default.
export const BATCH_CAPTURE_TARGET_EDGE = 2560;
const MIN_BATCH_CAPTURE_EDGE = 1920;

export function selectBatchCaptureSize(sizes) {
  if (!Array.isArray(sizes)) return undefined;
  const candidates = sizes.flatMap((size) => {
    if (typeof size !== 'string') return [];
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return [];
    const width = Number(match[1]), height = Number(match[2]);
    const longEdge = Math.max(width, height), shortEdge = Math.min(width, height);
    if (!Number.isSafeInteger(longEdge) || shortEdge <= 0 || longEdge < MIN_BATCH_CAPTURE_EDGE ||
      Math.abs(longEdge / shortEdge - 4 / 3) > 0.02) return [];
    return [{ size, longEdge }];
  }).sort((a, b) => a.longEdge - b.longEdge);
  const withinTarget = candidates.filter(({ longEdge }) => longEdge <= BATCH_CAPTURE_TARGET_EDGE);
  // When no medium size is offered, use the smallest larger 4:3 option.
  // Unknown presets and low-resolution-only lists retain the native default.
  return (withinTarget.at(-1) ?? candidates[0])?.size;
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
    if (getCamera() === size.camera) onSize(size.value);
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
        const selected = selectBatchCaptureSize(sizes);
        if (selected) {
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
