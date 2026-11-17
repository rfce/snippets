import { normalizeMediaTimestamp } from './snippet-date-sections';

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

  let createdAt = normalizeMediaTimestamp(info?.creationTime)
    ?? normalizeMediaTimestamp(asset.creationTime);
  let modifiedAt = normalizeMediaTimestamp(info?.modificationTime)
    ?? normalizeMediaTimestamp(asset.modificationTime);

  if (createdAt === null && typeof asset.getCreationTime === 'function') {
    try {
      createdAt = normalizeMediaTimestamp(await asset.getCreationTime());
    } catch {
      // Missing date metadata must not prevent a saved image from appearing.
    }
  }
  if (createdAt === null && modifiedAt === null && typeof asset.getModificationTime === 'function') {
    try {
      modifiedAt = normalizeMediaTimestamp(await asset.getModificationTime());
    } catch {
      // Undated images appear in their own section instead of under Today.
    }
  }

  return {
    id: info?.id ?? asset.id ?? uri,
    uri,
    width: info?.width ?? asset.width ?? 1,
    height: info?.height ?? asset.height ?? 1,
    fileName: info?.filename ?? asset.filename ?? asset.fileName ?? null,
    createdAt,
    modifiedAt,
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

/**
 * Saves several images with one album lookup. The album is found (or created
 * by the first save) once and reused for every later save. A failed save
 * forgets the cached album, so a retry looks it up again in case it was
 * deleted outside the app.
 */
export function createSnippetsAlbumSaver(mediaLibrary) {
  let albumPromise = null;

  return async function saveImage(uri) {
    if (!uri) throw new Error('A local image URI is required to save a Snippets image.');
    if (!mediaLibrary?.Asset?.create || !mediaLibrary?.Album?.get || !mediaLibrary?.Album?.create) {
      throw new Error('The media-library album API is unavailable in this build.');
    }

    try {
      if (!albumPromise) albumPromise = getSnippetsAlbum(mediaLibrary);
      let album = await albumPromise;
      if (album) return await mediaLibrary.Asset.create(uri, album);

      // First save ever: create the album with this image in it.
      const asset = await mediaLibrary.Asset.create(uri);
      try {
        album = await mediaLibrary.Album.create(SNIPPETS_ALBUM_NAME, [asset]);
      } catch (error) {
        // Another save can create the album between the lookup and creation.
        album = await getSnippetsAlbum(mediaLibrary);
        if (!album) throw error;
        await album.add(asset);
      }
      albumPromise = Promise.resolve(album);
      return asset;
    } catch (error) {
      albumPromise = null;
      throw error;
    }
  };
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

