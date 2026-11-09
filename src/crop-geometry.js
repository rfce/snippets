export const CROP_EDGES = {
  top: ['topLeft', 'topRight'],
  right: ['topRight', 'bottomRight'],
  bottom: ['bottomRight', 'bottomLeft'],
  left: ['bottomLeft', 'topLeft'],
};

const CORNER_NAMES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

export function getDefaultCorners() {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  };
}

export function copyCorners(corners = getDefaultCorners()) {
  return Object.fromEntries(CORNER_NAMES.map((name) => [name, { ...corners[name] }]));
}

export function hasCustomCrop(corners) {
  if (!corners) return false;
  const defaults = getDefaultCorners();
  return CORNER_NAMES.some((name) =>
    !corners[name] ||
    Math.abs(corners[name].x - defaults[name].x) > 0.0001 ||
    Math.abs(corners[name].y - defaults[name].y) > 0.0001
  );
}

export function rotateCornersClockwise(corners) {
  const rotate = ({ x, y }) => ({ x: 1 - y, y: x });
  // Relabel the vertices as well as rotating them: the renderer expects
  // top-left, top-right, bottom-right, bottom-left in the displayed image.
  return {
    topLeft: rotate(corners.bottomLeft),
    topRight: rotate(corners.topLeft),
    bottomRight: rotate(corners.topRight),
    bottomLeft: rotate(corners.bottomRight),
  };
}

export function getImageViewport(frame, aspectRatio, padding = 28) {
  const availableWidth = Math.max(0, frame.width - padding * 2);
  const availableHeight = Math.max(0, frame.height - padding * 2);
  if (!availableWidth || !availableHeight || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: 0, height: 0, left: padding, top: padding };
  }
  const width = Math.min(availableWidth, availableHeight * aspectRatio);
  const height = width / aspectRatio;
  return {
    width,
    height,
    left: (frame.width - width) / 2,
    top: (frame.height - height) / 2,
  };
}

export function getEdgeMidpoint(corners, edge) {
  const [first, second] = CROP_EDGES[edge].map((name) => corners[name]);
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function getClosestCropHandle(corners, touch, viewport) {
  const handles = [
    ...Object.entries(corners).map(([handle, position]) => ({ handle, position })),
    ...Object.keys(CROP_EDGES).map((handle) => ({
      handle, position: getEdgeMidpoint(corners, handle),
    })),
  ];
  return handles.reduce((closest, candidate) => {
    const distance = (point) => Math.hypot(
      (point.position.x - touch.x) * viewport.width,
      (point.position.y - touch.y) * viewport.height
    );
    return distance(candidate) < distance(closest) ? candidate : closest;
  });
}

export function isValidCrop(corners) {
  const points = CORNER_NAMES.map((name) => corners[name]);
  if (points.some((point) => !point || !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    return false;
  }
  // Normalized limits remain valid after rotating or resizing the viewport.
  const minimumEdge = 0.025;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % points.length];
    const third = points[(index + 2) % points.length];
    const cross = (second.x - first.x) * (third.y - second.y) -
      (second.y - first.y) * (third.x - second.x);
    if (cross <= 0.000001 ||
      Math.hypot(second.x - first.x, second.y - first.y) < minimumEdge) {
      return false;
    }
    twiceArea += first.x * second.y - second.x * first.y;
  }
  return twiceArea / 2 >= minimumEdge * minimumEdge;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function moveCropHandle(startCorners, handle, position, viewport) {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return startCorners;
  const candidate = copyCorners(startCorners);
  if (CROP_EDGES[handle]) {
    const names = CROP_EDGES[handle];
    const points = names.map((name) => startCorners[name]);
    const midpoint = getEdgeMidpoint(startCorners, handle);
    const dx = clamp(position.x - midpoint.x,
      -Math.min(...points.map((point) => point.x)),
      1 - Math.max(...points.map((point) => point.x)));
    const dy = clamp(position.y - midpoint.y,
      -Math.min(...points.map((point) => point.y)),
      1 - Math.max(...points.map((point) => point.y)));
    names.forEach((name) => {
      candidate[name] = { x: startCorners[name].x + dx, y: startCorners[name].y + dy };
    });
  } else {
    candidate[handle] = { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) };
  }
  if (isValidCrop(candidate, viewport)) return candidate;

  // Stop at the nearest valid position instead of letting a handle cross an
  // opposite edge. Interpolation keeps the handle moving smoothly at its limit.
  let lower = 0;
  let upper = 1;
  let result = startCorners;
  for (let step = 0; step < 18; step += 1) {
    const fraction = (lower + upper) / 2;
    const next = Object.fromEntries(CORNER_NAMES.map((name) => [name, {
      x: startCorners[name].x + (candidate[name].x - startCorners[name].x) * fraction,
      y: startCorners[name].y + (candidate[name].y - startCorners[name].y) * fraction,
    }]));
    if (isValidCrop(next, viewport)) {
      result = next;
      lower = fraction;
    } else {
      upper = fraction;
    }
  }
  return result;
}

export function getCropLineStyle(first, second, viewport) {
  const startX = first.x * viewport.width;
  const startY = first.y * viewport.height;
  const endX = second.x * viewport.width;
  const endY = second.y * viewport.height;
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.hypot(dx, dy);
  return {
    left: (startX + endX - length) / 2,
    top: (startY + endY) / 2 - 1,
    width: length,
    transform: [{ rotate: `${Math.atan2(dy, dx) * 180 / Math.PI}deg` }],
  };
}

export function getOutsideShadeStyle(first, second, viewport) {
  const dx = (second.x - first.x) * viewport.width;
  const dy = (second.y - first.y) * viewport.height;
  const length = Math.hypot(dx, dy);
  const span = Math.hypot(viewport.width, viewport.height) * 2;
  // This rectangle's bottom edge lies on the crop edge. Its interior covers
  // the outside half-plane; clipping the group leaves the selected polygon clear.
  return {
    width: span,
    height: span,
    left: (first.x + second.x) * viewport.width / 2 + dy / length * span / 2 - span / 2,
    top: (first.y + second.y) * viewport.height / 2 - dx / length * span / 2 - span / 2,
    transform: [{ rotate: `${Math.atan2(dy, dx) * 180 / Math.PI}deg` }],
  };
}
