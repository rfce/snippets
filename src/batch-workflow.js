// Save identity belongs to the capture, even when its rendered URI changes.
export function getBatchPhotoId(photo) {
  const source = photo.sourcePhoto ?? photo;
  return source.id || source.uri;
}

export async function savePendingBatchAsync(photos, { savedAssets, savePhoto, onProgress = () => {} }) {
  const progress = () => onProgress({
    completed: photos.filter((photo) => savedAssets.has(getBatchPhotoId(photo))).length,
    total: photos.length,
  });

  progress();
  for (const photo of photos) {
    const id = getBatchPhotoId(photo);
    if (savedAssets.has(id)) continue;
    // Record each native success immediately. A later failure must not roll this back.
    const asset = await savePhoto(photo);
    savedAssets.set(id, asset);
    progress();
  }
}

export async function releaseTemporaryImagesAsync(images, pendingJobs, cleanup) {
  // Navigation/unmount may happen while native code is still reading these files.
  // Rejection ends ownership too, so cleanup must run for either outcome.
  await Promise.allSettled(pendingJobs.filter(Boolean));
  await cleanup(images);
}

