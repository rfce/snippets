export const CAMERA_FOCUS_COLOR = '#16C7B7';
export const CAMERA_FOCUS_SIZE = 72;
export const CAMERA_FOCUS_TIMEOUT = 5500;

export function getCameraPreviewSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const previewWidth = Math.min(width, height * 3 / 4);
  return { width: previewWidth, height: previewWidth * 4 / 3 };
}

export function getCameraFocusPoint(x, y, width, height) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.min(1, x / width)),
    y: Math.max(0, Math.min(1, y / height)),
  };
}

// Expo Camera 58 keeps its native view ref here. Keep this SDK-specific access
// isolated; the build plugin validates the wrapper before extending its view.
export function getNativeFocusCamera(camera) {
  return camera?._cameraRef?.current ?? null;
}

export function createCameraFocusController({
  getCamera,
  onChange,
  schedule = setTimeout,
  unschedule = clearTimeout,
}) {
  let enabled = false;
  let sequence = 0;
  let current = null;
  let hideTimer = null;

  const clearHideTimer = () => {
    if (hideTimer !== null) unschedule(hideTimer);
    hideTimer = null;
  };

  const cancelNative = (camera = getCamera(), commandId = sequence) => {
    try {
      Promise.resolve(camera?.snippetsCancelPointFocus?.(commandId)).catch(() => {});
    } catch {
      // An old development build may not contain the native extension.
    }
  };

  const invalidate = (notify = true, releaseNative = true) => {
    sequence += 1;
    clearHideTimer();
    if (current) {
      unschedule(current.timeout);
      current.resolve({ status: 'cancelled' });
      current = null;
    }
    if (releaseNative) cancelNative();
    if (notify) onChange(null);
  };

  const finish = (request, status) => {
    if (current !== request) return;
    unschedule(request.timeout);
    current = null;
    request.resolve({ status });
    if (!request.showResult) return;

    onChange({ id: request.id, point: request.point, status });
    hideTimer = schedule(() => {
      hideTimer = null;
      if (sequence === request.id) onChange(null);
    }, status === 'focused' ? 1800 : 1400);
  };

  return {
    setEnabled(value) {
      enabled = Boolean(value);
    },
    focusAt(point) {
      if (!enabled || !point || ![point.x, point.y].every(Number.isFinite)) {
        return Promise.resolve({ status: 'ignored' });
      }
      // The native focus command replaces the previous request atomically.
      // Do not dispatch a separate, unawaited cancel before it.
      invalidate(false, false);
      const camera = getCamera();
      const request = {
        id: sequence,
        point: { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) },
        showResult: true,
        timeout: null,
      };
      request.promise = new Promise((resolve) => { request.resolve = resolve; });
      current = request;
      onChange({ id: request.id, point: request.point, status: 'focusing' });
      request.timeout = schedule(() => {
        if (current !== request) return;
        // A reporting timeout must not restore foreground/default autofocus.
        finish(request, 'failed');
      }, CAMERA_FOCUS_TIMEOUT);

      try {
        if (typeof camera?.snippetsFocusAtPointAsync !== 'function') {
          finish(request, 'unavailable');
        } else {
          Promise.resolve(camera.snippetsFocusAtPointAsync(request.point.x, request.point.y, request.id)).then(
            (result) => finish(request, ['focused', 'unsupported', 'cancelled'].includes(result?.status)
              ? result.status : 'failed'),
            () => finish(request, 'failed')
          );
        }
      } catch {
        finish(request, 'failed');
      }
      return request.promise;
    },
    hide() {
      clearHideTimer();
      if (current) current.showResult = false;
      onChange(null);
    },
    prepareCaptureAsync() {
      enabled = false;
      clearHideTimer();
      if (current) current.showResult = false;
      onChange(null);
      return current?.promise ?? Promise.resolve({ status: 'idle' });
    },
    reset() {
      invalidate();
    },
    dispose() {
      enabled = false;
      invalidate(false);
    },
  };
}

