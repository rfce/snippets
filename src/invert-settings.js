export const PREVIEW_FILTER_OPTIONS = [
  { label: 'Original', value: 'original' },
  { label: 'Black & White', value: 'blackAndWhite' },
  { label: 'Magic Color', value: 'magicColor' },
  { label: 'Invert', value: 'invert' },
];

export const INVERT_CLARITY_OPTIONS = [
  { label: 'Soft', value: 'soft', gamma: 1.2 },
  { label: 'Balanced', value: 'balanced', gamma: 1 },
  { label: 'Crisp', value: 'crisp', gamma: 0.75 },
];

export const DEFAULT_INVERT_SETTINGS = Object.freeze({
  inkClarity: 'balanced',
  warmInk: false,
  preserveAccents: false,
});

export function normalizeInvertSettings(settings) {
  const input = settings ?? {};
  return {
    inkClarity: INVERT_CLARITY_OPTIONS.some((option) => option.value === input.inkClarity)
      ? input.inkClarity : DEFAULT_INVERT_SETTINGS.inkClarity,
    warmInk: input.warmInk === true,
    preserveAccents: input.preserveAccents === true,
  };
}

export function getInvertSettingsKey(settings) {
  const value = normalizeInvertSettings(settings);
  return [value.inkClarity, value.warmInk ? 1 : 0, value.preserveAccents ? 1 : 0].join(':');
}

export function getInvertPalette(settings) {
  const value = normalizeInvertSettings(settings);
  return {
    background: [40 / 255, 46 / 255, 66 / 255],
    ink: value.warmInk ? [245 / 255, 239 / 255, 226 / 255] : [245 / 255, 245 / 255, 245 / 255],
    gamma: INVERT_CLARITY_OPTIONS.find((option) => option.value === value.inkClarity).gamma,
    preserveAccents: value.preserveAccents,
  };
}
