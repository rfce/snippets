import { Alert } from 'react-native';

import { createBackgroundSaveQueue } from './background-save-queue';
import { cleanupProcessedImagesAsync } from './perspective-crop';
import { createSnippetsAlbumSaver } from './snippets-library';

function getMediaLibraryModule() {
  try {
    return require('expo-media-library');
  } catch {
    return null;
  }
}

// One album saver for the whole session: the Snippets album is looked up once
// (and created by the first save), not once per image.
let albumSaver = null;
const saveImage = (uri) => {
  if (!albumSaver) albumSaver = createSnippetsAlbumSaver(getMediaLibraryModule());
  return albumSaver(uri);
};

/** App-wide background save queue; it keeps saving after a screen closes. */
export const backgroundSaves = createBackgroundSaveQueue({
  saveImage,
  cleanup: cleanupProcessedImagesAsync,
  onError: (job, error) => {
    const remaining = job.total - job.completed;
    const isBatch = job.label === 'batch';
    const message = error?.message || 'The image could not be written to the photo library.';
    Alert.alert(
      isBatch ? 'Could not finish saving the batch' : 'Could not save the image',
      isBatch && job.completed > 0
        ? `${message}\n\n${job.completed} of ${job.total} images are saved. Try again saves only the remaining ${remaining}.`
        : message,
      [
        {
          text: isBatch ? `Discard ${remaining} unsaved` : 'Discard',
          style: 'destructive',
          onPress: () => backgroundSaves.dismiss(job.id),
        },
        { text: 'Try again', onPress: () => backgroundSaves.retry(job.id) },
      ],
      { cancelable: false }
    );
  },
});
