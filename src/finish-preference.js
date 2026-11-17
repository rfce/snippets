import * as FileSystem from 'expo-file-system/legacy';

import { normalizeInvertSettings } from './invert-settings';

// The finish used for the last saved batch predicts the next one, so that
// finish can be prepared while the person is still capturing.
const FILE_NAME = 'snippets-finish-preference.json';
const KNOWN_MODES = new Set(['original', 'blackAndWhite', 'magicColor', 'invert']);

function getPreferenceUri() {
  return FileSystem.documentDirectory ? FileSystem.documentDirectory + FILE_NAME : null;
}

/** The remembered finish, or null when none is stored or it cannot be read. */
export async function loadFinishPreferenceAsync() {
  const uri = getPreferenceUri();
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const value = JSON.parse(await FileSystem.readAsStringAsync(uri));
    if (!KNOWN_MODES.has(value?.mode)) return null;
    return { mode: value.mode, invertSettings: normalizeInvertSettings(value.invertSettings) };
  } catch {
    return null;
  }
}

export async function saveFinishPreferenceAsync({ mode, invertSettings }) {
  const uri = getPreferenceUri();
  if (!uri || !KNOWN_MODES.has(mode)) return;
  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify({
      mode,
      invertSettings: normalizeInvertSettings(invertSettings),
    }));
  } catch {
    // A missing prediction only means no speculative work; never an error.
  }
}
