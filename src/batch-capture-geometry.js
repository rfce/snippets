export const BATCH_CAPTURE_SCALE = 0.8;
export const MAX_CAPTURE_FLIGHTS = 3;

export function isBatchCaptureRect(rect) {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0);
}

export function resolveBatchCaptureViewport(viewport, fallbackViewport) {
  // Layout can briefly report a one-pixel frame while the native camera settles.
  const usable = (size) => Number.isFinite(Number(size?.width)) &&
    Number.isFinite(Number(size?.height)) && Number(size.width) >= 160 && Number(size.height) >= 320;
  const size = usable(viewport) ? viewport : usable(fallbackViewport) ? fallbackViewport : { width: 360, height: 800 };
  return { x: 0, y: 0, width: Number(size.width), height: Number(size.height) };
}

function isVisibleCaptureRect(rect, viewport, minimum) {
  return isBatchCaptureRect(rect) && rect.width >= minimum && rect.height >= minimum &&
    rect.x >= -1 && rect.y >= -1 &&
    rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1;
}

function isCapturePreview(rect, viewport) {
  return isVisibleCaptureRect(rect, viewport, 64) && rect.width / rect.height >= 0.25 &&
    rect.width / rect.height <= 4;
}

function isCaptureTray(rect, viewport) {
  return isVisibleCaptureRect(rect, viewport, 24) && rect.width <= 128 && rect.height <= 128 &&
    rect.width / rect.height >= 0.5 && rect.width / rect.height <= 2;
}

export function getBatchCaptureFallbackRects(viewport, insets = {}, controlPadding = 16, fallbackViewport) {
  const screen = resolveBatchCaptureViewport(viewport, fallbackViewport);
  const { width, height } = screen;
  const safeInset = (value) => Number.isFinite(Number(value)) ? Math.min(height / 5, Math.max(0, Number(value))) : 0;
  const top = safeInset(insets.top);
  const bottom = safeInset(insets.bottom);
  const stageWidth = Math.max(96, width - 32);
  const stageHeight = Math.max(96, height - top - bottom - 262);
  const previewWidth = Math.min(stageWidth, stageHeight * 3 / 4);
  const previewHeight = previewWidth * 4 / 3;
  return {
    preview: {
      x: 16 + (stageWidth - previewWidth) / 2,
      y: top + 88 + (stageHeight - previewHeight) / 2,
      width: previewWidth, height: previewHeight,
    },
    tray: {
      x: controlPadding + 20,
      y: height - bottom - controlPadding - (93 + 72) / 2,
      width: 72, height: 72,
    },
    viewport: screen,
  };
}

export function getBatchCaptureGeometry(photo, preview, tray, overlay) {
  if (![preview, tray, overlay].every(isBatchCaptureRect)) return null;
  // Validate metadata as a pair. Combining one pixel dimension with a layout
  // dimension creates an almost-flat card when native metadata is incomplete.
  const sourceWidth = Number(photo?.width), sourceHeight = Number(photo?.height);
  const ratio = sourceWidth / sourceHeight;
  const validPhoto = Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) &&
    sourceWidth >= 32 && sourceHeight >= 32 && ratio >= 0.125 && ratio <= 8;
  const aspectRatio = validPhoto ? ratio : preview.width / preview.height;
  // Compute BOTH explicit dimensions from the same aspect ratio.
  const width = Math.min(preview.width, preview.height * aspectRatio) * BATCH_CAPTURE_SCALE;
  const height = width / aspectRatio;
  return {
    from: {
      x: preview.x - overlay.x + (preview.width - width) / 2,
      y: preview.y - overlay.y + (preview.height - height) / 2,
      width, height,
    },
    to: { x: tray.x - overlay.x, y: tray.y - overlay.y, width: tray.width, height: tray.height },
    preview: { x: preview.x - overlay.x, y: preview.y - overlay.y, width: preview.width, height: preview.height },
    viewport: { x: 0, y: 0, width: overlay.width, height: overlay.height },
  };
}

export function snapshotBatchCaptureGeometry(
  photo, viewport, insets, bounds = {}, controlPadding = 16, fallbackViewport
) {
  const fallback = getBatchCaptureFallbackRects(viewport, insets, controlPadding, fallbackViewport);
  return getBatchCaptureGeometry(
    photo,
    isCapturePreview(bounds.preview, fallback.viewport) ? bounds.preview : fallback.preview,
    isCaptureTray(bounds.tray, fallback.viewport) ? bounds.tray : fallback.tray,
    fallback.viewport
  );
}

export function resolveBatchCaptureCardGeometry(photo, geometry, viewport) {
  // Recheck against the visible modal/window instead of trusting a stale or
  // collapsed capture-time frame. No asynchronous measurement is required.
  const fallback = getBatchCaptureFallbackRects(resolveBatchCaptureViewport(viewport, geometry?.viewport));
  return getBatchCaptureGeometry(
    photo,
    isCapturePreview(geometry?.preview, fallback.viewport) ? geometry.preview : fallback.preview,
    isCaptureTray(geometry?.to, fallback.viewport) ? geometry.to : fallback.tray,
    fallback.viewport
  );
}

export function getBatchCaptureMotion(geometry) {
  const { from, to } = geometry;
  return {
    translateX: to.x + to.width / 2 - (from.x + from.width / 2),
    translateY: to.y + to.height / 2 - (from.y + from.height / 2),
    scale: Math.min(to.width / from.width, to.height / from.height),
  };
}

export function appendBatchCaptureFlight(flights, capture) {
  return [...flights.filter((item) => item.id !== capture.id).slice(-(MAX_CAPTURE_FLIGHTS - 1)), capture];
}

export function createBatchCapturePlayer({
  startAnimation, onComplete, schedule = setTimeout, unschedule = clearTimeout,
  prepareTimeout = 8000, animationTimeout = 4000,
}) {
  let active = true, started = false, shown = false, imageReady = false;
  let stopAnimation, timeout;
  const finish = () => {
    if (!active) return;
    active = false;
    unschedule(timeout);
    stopAnimation?.();
    onComplete();
  };
  const begin = () => {
    if (!active || started || !shown || !imageReady) return;
    started = true;
    unschedule(timeout);
    timeout = schedule(finish, animationTimeout);
    stopAnimation = startAnimation(finish);
    if (!active) stopAnimation?.();
  };
  timeout = schedule(finish, prepareTimeout);
  return {
    show() {
      if (!active || shown) return;
      shown = true;
      begin();
    },
    // Only a rendered-image signal may enable the flight, never a timer.
    imageReady() { imageReady = true; begin(); },
    finish,
    dispose() {
      if (!active) return;
      active = false;
      unschedule(timeout);
      stopAnimation?.();
    },
    isActive: () => active,
  };
}
