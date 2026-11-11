export const CROP_MAGNIFIER_SIZE = 140;
export const CROP_MAGNIFIER_ZOOM = 2.25;

const MARGIN = 8;
const BORDER_INSET = 4;
// Includes the enlarged handle target's grab offset as well as the fingertip.
const FINGER_GAP = 48;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function getCropMagnifierLayout(frame, viewport, position, preferredSide = null) {
  if (!frame || !viewport || !position ||
    ![frame.width, frame.height, viewport.width, viewport.height, viewport.left, viewport.top,
      position.x, position.y].every(Number.isFinite) ||
    frame.width <= 0 || frame.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;

  const maximumSize = Math.min(CROP_MAGNIFIER_SIZE, frame.width - MARGIN * 2, frame.height - MARGIN * 2);
  if (maximumSize <= BORDER_INSET * 2) return null;
  const sample = { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) };
  const target = {
    x: viewport.left + sample.x * viewport.width,
    y: viewport.top + sample.y * viewport.height,
  };
  const sizes = [...new Set([maximumSize, Math.min(maximumSize, 112), Math.min(maximumSize, 96)])];
  const candidates = sizes.flatMap((size) => {
    const radius = size / 2;
    return [
      { side: 'above', left: target.x - radius, top: target.y - size - FINGER_GAP },
      { side: 'below', left: target.x - radius, top: target.y + FINGER_GAP },
      { side: 'left', left: target.x - size - FINGER_GAP, top: target.y - radius },
      { side: 'right', left: target.x + FINGER_GAP, top: target.y - radius },
    ].map((candidate, index) => {
      const left = clamp(candidate.left, MARGIN, frame.width - size - MARGIN);
      const top = clamp(candidate.top, MARGIN, frame.height - size - MARGIN);
      const clearance = Math.hypot(left + radius - target.x, top + radius - target.y) - radius;
      const shift = Math.hypot(left - candidate.left, top - candidate.top);
      const score = Math.max(0, FINGER_GAP - clearance) * 100
        + shift * 0.1 + index * 6 + (maximumSize - size) * 0.2
        - (candidate.side === preferredSide ? 12 : 0);
      return { side: candidate.side, left, top, size, clearance, score };
    });
  });
  // Use the largest circle that can stay clear of the finger. A smaller
  // circle keeps the magnifier useful on short canvases and small phones.
  const clearCandidates = candidates.filter((candidate) => candidate.clearance >= FINGER_GAP - 0.0001);
  const largestClearSize = clearCandidates.length
    ? Math.max(...clearCandidates.map((candidate) => candidate.size)) : null;
  const choices = largestClearSize === null ? candidates
    : clearCandidates.filter((candidate) => candidate.size === largestClearSize);
  const placement = choices.reduce((best, candidate) => candidate.score < best.score ? candidate : best);
  const size = placement.size;
  const innerSize = size - BORDER_INSET * 2;
  const width = viewport.width * CROP_MAGNIFIER_ZOOM;
  const height = viewport.height * CROP_MAGNIFIER_ZOOM;

  return {
    left: placement.left,
    top: placement.top,
    size,
    innerSize,
    side: placement.side,
    sample,
    source: {
      left: innerSize / 2 - sample.x * width,
      top: innerSize / 2 - sample.y * height,
      width,
      height,
    },
  };
}

export function projectCropPointIntoMagnifier(point, layout) {
  return {
    x: layout.source.left + point.x * layout.source.width,
    y: layout.source.top + point.y * layout.source.height,
  };
}

