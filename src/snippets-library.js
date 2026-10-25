export const SNIPPETS_ALBUM_NAME = 'Snippets';

export async function getSnippetsAlbum(mediaLibrary) {
  if (!mediaLibrary?.Album?.get) {
    throw new Error('The media-library album API is unavailable in this build.');
  }

  return mediaLibrary.Album.get(SNIPPETS_ALBUM_NAME);
}

export async function normalizeMediaLibraryImage(asset) {
  if (!asset) return null;

  let info = asset;

  // Asset.getInfo() already includes the URI, dimensions, and filename. The
  // previous callers resolved getUri() and getInfo() separately for every
  // thumbnail, which doubled native bridge work for each page of images.
  if (typeof asset.getInfo === 'function') {
    try {
      info = await asset.getInfo();
    } catch {
      info = asset;
    }
  } else if (typeof asset.getAssetInfoAsync === 'function') {
    try {
      info = await asset.getAssetInfoAsync();
    } catch {
      info = asset;
    }
  }

  let uri = info?.localUri ?? info?.uri ?? asset.uri ?? null;

  // Keep a compatibility fallback for older/custom media-library wrappers
  // whose info response does not contain a usable URI.
  if (!uri && typeof asset.getUri === 'function') {
    try {
      uri = await asset.getUri();
    } catch {
      uri = null;
    }
  }

  uri = uri ?? asset.id ?? null;

  if (!uri) return null;

  return {
    id: info?.id ?? asset.id ?? uri,
    uri,
    width: info?.width ?? asset.width ?? 1,
    height: info?.height ?? asset.height ?? 1,
    fileName: info?.filename ?? asset.filename ?? asset.fileName ?? null,
  };
}

export function getMediaLibraryImageKey(image) {
  return image?.id || image?.uri;
}

export function appendUniqueMediaLibraryImages(existingImages, incomingImages) {
  const nextImages = [...existingImages];
  const seen = new Set(existingImages.map(getMediaLibraryImageKey));

  incomingImages.forEach((image) => {
    const key = getMediaLibraryImageKey(image);
    if (!key || seen.has(key)) return;

    seen.add(key);
    nextImages.push(image);
  });

  return nextImages;
}

export async function saveToSnippetsAlbum(mediaLibrary, uri) {
  if (!uri) {
    throw new Error('A local image URI is required to save a Snippets image.');
  }

  if (!mediaLibrary?.Asset?.create || !mediaLibrary?.Album?.get || !mediaLibrary?.Album?.create) {
    throw new Error('The media-library album API is unavailable in this build.');
  }

  let album = await getSnippetsAlbum(mediaLibrary);

  if (!album) {
    const asset = await mediaLibrary.Asset.create(uri);

    try {
      album = await mediaLibrary.Album.create(SNIPPETS_ALBUM_NAME, [asset]);
    } catch (error) {
      // Another save can create the album between the lookup and creation.
      album = await getSnippetsAlbum(mediaLibrary);
      if (!album) throw error;

      await album.add(asset);
      return asset;
    }

    return asset;
  }

  return mediaLibrary.Asset.create(uri, album);
}
