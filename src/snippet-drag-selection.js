const DRAG_THRESHOLD = 6;
const HOLD_MOVE_SLOP = 8;
const EDGE_SIZE = 56;
const MAX_SCROLL_SPEED = 0.55;

export function getGalleryGesturePoint(event) {
  const nativeEvent = event?.nativeEvent ?? event;
  if (!nativeEvent) return null;
  const touch = nativeEvent.touches?.[0] ?? nativeEvent.changedTouches?.[0] ?? nativeEvent;
  const x = touch.pageX;
  const y = touch.pageY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, touchCount: nativeEvent.touches?.length ?? 1 };
}

// Layouts are content-relative, so scrolling never requires measuring every tile.
export function createGalleryDragSelection({
  getImages,
  getSelection,
  setSelection,
  onActiveChange = () => {},
  scrollTo,
  isEnabled = () => true,
  columns = 3,
  gap = 4,
  rtl = false,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
}) {
  const rows = new Map();
  let viewport = null;
  let contentHeight = 0;
  let scrollOffset = 0;
  let requestedOffset = null;
  let scrollDirection = 0;
  let cachedImages = null;
  let orderedIds = [];
  let indices = new Map();
  let pending = null;
  let active = false;
  let dragging = false;
  let pointer = null;
  let baseline = null;
  let expectedSelection = null;
  let lastEndpoint = null;
  let lastImages = null;
  let continuation = null;
  let frame = null;
  let lastFrameTime = null;
  let generation = 0;

  const refreshImages = () => {
    const images = getImages();
    if (images !== cachedImages) {
      cachedImages = images;
      orderedIds = images.map((image) => image.id || image.uri);
      indices = new Map(orderedIds.map((id, index) => [id, index]));
    }
  };

  const visibleHeight = () => Math.max(1, viewport.height - (viewport.bottomInset ?? 0));
  const hitTest = (point, clampEdges = false) => {
    if (!viewport || !point) return null;
    let x = point.x - viewport.x;
    let y = point.y - viewport.y;
    if (!clampEdges && (x < 0 || x > viewport.width || y < 0 || y > visibleHeight())) return null;
    if (clampEdges) {
      x = clamp(x, 0, viewport.width - 1);
      y = clamp(y, 0, visibleHeight() - 1);
    }
    y += scrollOffset;
    for (const row of rows.values()) {
      const tileSize = (row.width - gap * (columns - 1)) / columns;
      if (tileSize <= 0 || y < row.y || y > row.y + tileSize) continue;
      let localX = x - row.x;
      if (clampEdges) localX = clamp(localX, 0, row.width - 1);
      if (localX < 0 || localX > row.width) return null;
      const visualColumn = Math.floor(localX / (tileSize + gap));
      if (visualColumn >= columns || localX - visualColumn * (tileSize + gap) > tileSize) return null;
      const column = rtl ? columns - 1 - visualColumn : visualColumn;
      return row.ids[column] ?? null;
    }
    return null;
  };

  const stop = (notify = true, clearContinuation = true) => {
    generation += 1;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    lastFrameTime = null;
    requestedOffset = null;
    scrollDirection = 0;
    const wasActive = active;
    active = false;
    dragging = false;
    pending = null;
    pointer = null;
    baseline = null;
    expectedSelection = null;
    lastEndpoint = null;
    lastImages = null;
    if (clearContinuation) continuation = null;
    if (wasActive) {
      if (notify) onActiveChange(false);
    }
  };

  const applyRange = () => {
    if (!active || !dragging || !pending || !isEnabled()) return;
    if (getSelection() !== expectedSelection) {
      stop();
      return;
    }
    refreshImages();
    const anchorIndex = indices.get(pending.anchorId);
    if (anchorIndex === undefined) {
      stop();
      return;
    }
    const endpoint = hitTest(pointer, true);
    const endpointIndex = indices.get(endpoint);
    if (endpointIndex === undefined || (endpoint === lastEndpoint && lastImages === cachedImages)) return;
    const next = new Set(baseline);
    const first = Math.min(anchorIndex, endpointIndex);
    const last = Math.max(anchorIndex, endpointIndex);
    for (let index = first; index <= last; index += 1) next.add(orderedIds[index]);
    setSelection(next);
    expectedSelection = getSelection();
    lastEndpoint = endpoint;
    lastImages = cachedImages;
  };

  const edgeVelocity = () => {
    if (!viewport || !pointer || !dragging) return 0;
    const height = visibleHeight();
    const edge = Math.min(EDGE_SIZE, height / 4);
    const y = pointer.y - viewport.y;
    if (y < edge) return -MAX_SCROLL_SPEED * clamp((edge - y) / edge, 0, 1);
    if (y > height - edge) return MAX_SCROLL_SPEED * clamp((y - height + edge) / edge, 0, 1);
    return 0;
  };

  const schedule = () => {
    if (!active || !dragging || frame !== null) return;
    const version = generation;
    frame = requestFrame((time) => {
      if (version !== generation) return;
      frame = null;
      if (!active || !dragging) return;
      if (!isEnabled() || getSelection() !== expectedSelection) {
        stop();
        return;
      }
      const delta = lastFrameTime === null ? 16 : clamp(time - lastFrameTime, 0, 32);
      lastFrameTime = time;
      const velocity = edgeVelocity();
      const maximum = viewport ? Math.max(0, contentHeight - viewport.height) : 0;
      const nextOffset = clamp(scrollOffset + velocity * delta, 0, maximum);
      const didScroll = nextOffset !== scrollOffset;
      if (didScroll) {
        scrollDirection = Math.sign(nextOffset - scrollOffset);
        scrollOffset = nextOffset;
        requestedOffset = nextOffset;
        scrollTo(nextOffset);
      }
      applyRange();
      if (didScroll && active) schedule();
      else lastFrameTime = null;
    });
  };

  const updatePointer = (point) => {
    if (!point || !active) return;
    pointer = point;
    if (!dragging && Math.hypot(point.x - pending.origin.x, point.y - pending.origin.y) >= DRAG_THRESHOLD) {
      dragging = true;
    }
  };

  return {
    isActive: () => active,
    prepare(point) {
      if (active) stop();
      pending = null;
      if (!point || point.touchCount !== 1 || !isEnabled()) return false;
      refreshImages();
      const id = hitTest(point);
      pending = { anchorId: id, tapId: id, origin: point, point, armed: false };
      if (id && continuation?.selection === getSelection()) {
        const anchor = indices.get(continuation.anchorId);
        const end = indices.get(continuation.endpoint);
        const touched = indices.get(id);
        if (anchor !== undefined && end !== undefined &&
            touched >= Math.min(anchor, end) && touched <= Math.max(anchor, end)) {
          pending.anchorId = continuation.anchorId;
          pending.resume = continuation;
        }
      }
      // A touch alone never claims the list, even when images are selected.
      return false;
    },
    armFromLongPress(imageId) {
      if (active) return false;
      if (!pending || !isEnabled() ||
          Math.hypot(pending.point.x - pending.origin.x, pending.point.y - pending.origin.y) > HOLD_MOVE_SLOP) {
        return false;
      }
      refreshImages();
      if (!indices.has(imageId)) return false;
      // The actual tile is authoritative if scroll metrics lag behind a touch.
      if (pending.tapId !== imageId || pending.resume?.selection !== getSelection()) {
        pending.resume = null;
      }
      if (!pending.resume) pending.anchorId = imageId;
      pending.tapId = imageId;
      // Measure drag movement from the confirmed hold, not pre-hold finger jitter.
      pending.origin = pending.point;
      pending.armed = true;
      return true;
    },
    canClaimMove(point) {
      if (!point || point.touchCount !== 1) {
        stop();
        return false;
      }
      if (!pending || !isEnabled()) return false;
      pending.point = point;
      const distance = Math.hypot(point.x - pending.origin.x, point.y - pending.origin.y);
      if (!pending.armed) {
        if (distance > HOLD_MOVE_SLOP) pending = null;
        return false;
      }
      return getSelection().size > 0 && distance >= DRAG_THRESHOLD;
    },
    begin(point) {
      if (!pending?.armed || !isEnabled() || getSelection().size === 0 ||
          (point && point.touchCount !== 1)) return false;
      refreshImages();
      if (!indices.has(pending.anchorId)) return false;
      baseline = new Set(pending.resume?.baseline ?? getSelection());
      expectedSelection = getSelection();
      lastEndpoint = pending.resume?.endpoint ?? null;
      lastImages = pending.resume ? cachedImages : null;
      active = true;
      dragging = false;
      generation += 1;
      onActiveChange(true);
      updatePointer(point ?? pending.point);
      schedule();
      return true;
    },
    move(point) {
      if (!active) return;
      if (!point || point.touchCount !== 1) {
        stop();
        return;
      }
      updatePointer(point);
      schedule();
    },
    finish(point) {
      if (!active) {
        pending = null;
        return;
      }
      if (point && point.touchCount > 1) {
        stop();
        return;
      }
      if (point) updatePointer(point);
      if (dragging) applyRange();
      const resume = dragging && active && lastEndpoint ? {
        anchorId: pending.anchorId,
        endpoint: lastEndpoint,
        baseline,
        selection: expectedSelection,
      } : null;
      stop(true, false);
      continuation = resume;
    },
    endTouch() {
      if (!active) pending = null;
    },
    cancel({ preserveRange = false } = {}) {
      stop(true, !preserveRange);
    },
    dispose() {
      stop(false);
      rows.clear();
    },
    setViewport(layout) {
      if (!layout || ![layout.x, layout.y, layout.width, layout.height].every(Number.isFinite) ||
          layout.width <= 0 || layout.height <= 0) return;
      // The pinned header changes height/Y on first selection; keep coordinates fresh.
      // Width changes invalidate the grid and require a fresh hold.
      if (active && viewport && layout.width !== viewport.width) stop();
      viewport = layout;
      schedule();
    },
    setContentHeight(height) {
      if (Number.isFinite(height)) contentHeight = Math.max(0, height);
      schedule();
    },
    setScrollOffset(offset) {
      if (!Number.isFinite(offset)) return;
      // Native scroll events can arrive a frame behind our non-animated request.
      // Keep the gesture's geometry from jumping backwards while that request settles.
      if (active && requestedOffset !== null) {
        if (Math.abs(offset - requestedOffset) <= 1) {
          requestedOffset = null;
        } else if ((scrollDirection > 0 && offset < requestedOffset) ||
                   (scrollDirection < 0 && offset > requestedOffset)) {
          return;
        } else {
          requestedOffset = null;
        }
      }
      if (offset === scrollOffset) return;
      scrollOffset = offset;
      schedule();
    },
    setRowLayout(key, layout, ids) {
      if (!layout || ![layout.x, layout.y, layout.width].every(Number.isFinite) || layout.width <= 0) return;
      rows.set(key, { ...layout, ids });
      schedule();
    },
    removeRow(key) {
      rows.delete(key);
    },
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
