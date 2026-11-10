// Media-library versions expose Unix seconds or milliseconds. Keep milliseconds
// internally so sorting and local-calendar grouping use the same instant.
export function normalizeMediaTimestamp(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    value = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;

  const milliseconds = value < 100000000000 ? value * 1000 : value;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

export function getSnippetTimestamp(image) {
  for (const value of [
    image?.createdAt,
    image?.creationTime,
    image?.modifiedAt,
    image?.modificationTime,
  ]) {
    const timestamp = normalizeMediaTimestamp(value);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

export function sortSnippetsNewestFirst(images) {
  return [...images].sort((left, right) => {
    const difference = (getSnippetTimestamp(right) ?? -1) - (getSnippetTimestamp(left) ?? -1);
    if (difference) return difference;
    const leftKey = String(left.id || left.uri || '');
    const rightKey = String(right.id || right.uri || '');
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

// SectionList virtualizes rows rather than individual tiles, keeping the grid
// at three columns even when a date has only one or two saved snippets.
export function createSnippetDateSections(images, { now = Date.now(), columns = 3, timeZone } = {}) {
  const columnCount = Number.isInteger(columns) && columns > 0 ? columns : 3;
  const zoneOptions = timeZone ? { timeZone } : {};
  const calendarFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...zoneOptions,
  });
  const dateFormatter = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...zoneOptions,
  });
  const calendarKey = (timestamp) => {
    const parts = calendarFormatter.formatToParts(new Date(timestamp));
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const today = calendarKey(now);
  const [year, month, day] = today.split('-').map(Number);
  // Subtract a calendar day, not 24 hours: daylight-saving days vary in length.
  const previousDay = new Date(Date.UTC(year, month - 1, day - 1));
  const yesterday = [
    previousDay.getUTCFullYear(),
    String(previousDay.getUTCMonth() + 1).padStart(2, '0'),
    String(previousDay.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const groups = new Map();

  for (const image of sortSnippetsNewestFirst(images)) {
    const timestamp = getSnippetTimestamp(image);
    const key = timestamp === null ? 'undated' : calendarKey(timestamp);
    if (!groups.has(key)) {
      const title = key === today ? 'Today'
        : key === yesterday ? 'Yesterday'
        : timestamp === null ? 'Date unavailable'
        : dateFormatter.format(new Date(timestamp));
      groups.set(key, { key, title, images: [] });
    }
    groups.get(key).images.push(image);
  }

  return [...groups.values()].map(({ key, title, images: groupImages }) => {
    const data = [];
    for (let index = 0; index < groupImages.length; index += columnCount) {
      const rowImages = groupImages.slice(index, index + columnCount);
      data.push({
        key: `${key}:${rowImages[0].id || rowImages[0].uri}`,
        images: rowImages,
      });
    }
    return { key, title, data };
  });
}

