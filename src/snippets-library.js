export const SNIPPETS_ALBUM_NAME = 'Snippets';

export async function getSnippetsAlbum(mediaLibrary) {
  if (!mediaLibrary?.Album?.get) {
    throw new Error('The media-library album API is unavailable in this build.');
  }

  return mediaLibrary.Album.get(SNIPPETS_ALBUM_NAME);
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
