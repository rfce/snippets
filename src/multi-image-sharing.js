import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const nativeModule = requireOptionalNativeModule('SnippetsMultiSharing');
const CACHE_PREFIX = 'snippets-share-';
const CACHE_MAX_AGE = 48 * 60 * 60 * 1000;
const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};
let inFlight = false;

function checkCancelled(isCancelled) {
  if (!isCancelled()) return;
  const error = new Error('Sharing cancelled.');
  error.name = 'AbortError';
  throw error;
}

function getMultipleImageShare() {
  if (Platform.OS === 'android' && typeof nativeModule?.shareImagesAsync === 'function') {
    return (urls) => nativeModule.shareImagesAsync(urls, 'image/*');
  }
  // The existing iOS method opens the general share sheet and takes ONE argument.
  if (Platform.OS === 'ios' && typeof nativeModule?.shareImagesToWhatsApp === 'function') {
    return (urls) => nativeModule.shareImagesToWhatsApp(urls);
  }
  const error = new Error('The installed app needs updating before it can share multiple images.');
  error.code = 'ERR_SHARE_BUILD_REQUIRED';
  throw error;
}

async function removeTemporary(uri) {
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
}

async function removeOldShareFiles(cache) {
  try {
    const names = await FileSystem.readDirectoryAsync(cache);
    const cutoff = Date.now() - CACHE_MAX_AGE;
    for (const name of names) {
      const match = /^snippets-share-(\d+)-[a-z0-9]+$/.exec(name);
      if (match && Number(match[1]) < cutoff) await removeTemporary(cache + name + '/');
    }
  } catch {
    // Cache housekeeping must not prevent sharing.
  }
}

function imageExtension(name) {
  const match = String(name ?? '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  const extension = match?.[1]?.toLowerCase();
  return extension && IMAGE_TYPES[extension] ? extension : null;
}

async function resolveImage(image) {
  let uri = image.uri;
  let fileName = image.fileName ?? image.filename;
  if (!/^(file|content):\/\//i.test(uri ?? '') && image.id) {
    const { Asset } = require('expo-media-library');
    const asset = new Asset(image.id);
    uri = await asset.getUri();
    if (!fileName) fileName = await asset.getFilename();
  }
  if (!/^(file|content):\/\//i.test(uri ?? '')) {
    throw new Error('This image is not available locally.');
  }
  return { uri, fileName };
}

async function readImageExtension(uri) {
  const { File } = require('expo-file-system');
  let handle;
  try {
    handle = new File(uri).open();
    const bytes = await handle.readBytes(32);
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
    if (ascii(0, 3) === 'GIF') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (ascii(0, 2) === 'BM') return 'bmp';
    if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tif';
    if (ascii(4, 8) === 'ftyp') {
      const brands = [ascii(8, 12), ascii(16, 20), ascii(20, 24), ascii(24, 28), ascii(28, 32)];
      if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return 'avif';
      if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))) return 'heic';
    }
    throw new Error('The image format could not be identified.');
  } finally {
    try { handle?.close(); } catch {}
  }
}

async function copyImage(image, destination, isCancelled) {
  const source = await resolveImage(image);
  checkCancelled(isCancelled);
  let extension = imageExtension(source.fileName) ?? imageExtension(source.uri);
  let uri = destination + '.' + (extension ?? 'image');
  await FileSystem.copyAsync({ from: source.uri, to: uri });
  checkCancelled(isCancelled);
  if (!extension) {
    extension = await readImageExtension(uri);
    checkCancelled(isCancelled);
    const renamed = destination + '.' + extension;
    await FileSystem.moveAsync({ from: uri, to: renamed });
    uri = renamed;
  }
  return { uri, mimeType: IMAGE_TYPES[extension] };
}

// Copy to owned cache files so every receiving app gets stable, readable URLs.
export async function shareImagesAsync(images, { isCancelled = () => false, onHandoff = () => {} } = {}) {
  if (!Array.isArray(images) || !images.length) throw new Error('Select at least one image to share.');
  if (inFlight) throw new Error('Another share is already in progress.');
  if (!['android', 'ios'].includes(Platform.OS)) {
    throw new Error('Image sharing is available in the Android and iOS app.');
  }
  const selected = images.map((image) => ({ ...image }));
  const shareMultiple = selected.length > 1 ? getMultipleImageShare() : null;
  inFlight = true;
  let batch;
  let handedOff = false;

  try {
    checkCancelled(isCancelled);
    if (!shareMultiple && !await Sharing.isAvailableAsync()) {
      throw new Error('Sharing is not available on this device.');
    }
    const cache = FileSystem.cacheDirectory;
    if (!cache) throw new Error('Temporary storage is not available on this device.');
    await removeOldShareFiles(cache);
    checkCancelled(isCancelled);
    batch = cache + CACHE_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '/';
    await FileSystem.makeDirectoryAsync(batch, { intermediates: true });
    const prepared = [];

    for (let index = 0; index < selected.length; index += 1) {
      checkCancelled(isCancelled);
      try {
        prepared.push(await copyImage(
          selected[index], batch + 'image-' + String(index + 1).padStart(3, '0'), isCancelled
        ));
      } catch (cause) {
        if (cause.name === 'AbortError') throw cause;
        const error = new Error('Could not prepare image ' + (index + 1) + ' for sharing. Make sure it is available on this device.');
        error.cause = cause;
        throw error;
      }
    }

    checkCancelled(isCancelled);
    onHandoff();
    handedOff = true;
    try {
      if (shareMultiple) {
        await shareMultiple(prepared.map((image) => image.uri));
      } else {
        await Sharing.shareAsync(prepared[0].uri, {
          dialogTitle: 'Share image', mimeType: prepared[0].mimeType,
        });
      }
    } catch (cause) {
      const error = new Error('Could not open the share sheet. Please try again.');
      error.cause = cause;
      throw error;
    }
    // A receiving app can read after the chooser closes. Keep the files until
    // an aged-cache cleanup on a later share, rather than deleting them here.
  } finally {
    if (batch && !handedOff) await removeTemporary(batch);
    inFlight = false;
  }
}
