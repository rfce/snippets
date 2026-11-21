import * as FileSystem from 'expo-file-system/legacy';

import { estimateBlackAndWhitePaperAsync } from './paper-analysis';
import { getSharedPaperAnalysisCache } from './paper-analysis-cache';
import { PREVIEW_OUTPUT_EDGE } from './preview-quality';

import { getInvertPalette } from '@/invert-settings';

// Enhancement exports keep their existing JPEG settings. Crop/rotation
// snapshots use high-quality JPEG: PNG encoding of a full-size image was the
// slowest step of a crop (often seconds on mid-range Android), and the next
// pass decodes JPEG much faster too. At 0.95 a document shows no visible loss,
// and an image is re-encoded at most once more (by the chosen finish).
const MAX_OUTPUT_EDGE = 4096;
// Used only when the device limits cannot be read. Matches the edge the
// pipeline has always rendered at, so a failed probe never lowers quality.
const FALLBACK_GL_TEXTURE_EDGE = 4096;
// Lowered to the device's texture/renderbuffer/viewport limits once known.
let outputEdgeLimit = MAX_OUTPUT_EDGE;
let glLimitsPromise = null;
const NORMALIZED_SOURCE_COMPRESS = 0.95;
// On-screen results (Preview, Edit image, Review) render at this long edge:
// sharp on a phone screen at a quarter of the pixels of a full-size render.
// Saving always renders at full size from the original capture.
export { PREVIEW_OUTPUT_EDGE };

// --- Keeping the UI responsive during document analysis -------------------
// Black & White and Invert analyse the page in JavaScript. That work is cut
// into slices of about SLICE_BUDGET_MS, yielding to the event loop in between,
// so taps, animations and React commits are never held up behind it.
const SLICE_BUDGET_MS = 8;

const getNow = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Date.now());

function createTimeSlicer(shouldCancel) {
  let sliceStart = getNow();
  return async () => {
    if (getNow() - sliceStart < SLICE_BUDGET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Checked only when yielding, so a cancel costs nothing per pixel.
    if (shouldCancel?.()) {
      const error = new Error('Document analysis was cancelled.');
      error.paperAnalysisCancelled = true;
      throw error;
    }
    sliceStart = getNow();
  };
}

/**
 * Resolves after the next frame, so a pending React commit (a "working" state,
 * a pressed button) paints before heavy work starts. A timer also resolves it,
 * so work keeps moving when frames are paused (app in the background).
 */
export function yieldToUi() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(done, 0));
    setTimeout(done, 80);
  });
}

// The page analysis depends only on the source image, so it is computed once
// per image and reused by every Black & White and Invert render of it
// (previews, switching between the two, and the full-size save).
const paperAnalysisCache = getSharedPaperAnalysisCache();

function getPaperAnalysisKey(uri, width, height) {
  return `${uri}|${width}x${height}`;
}

export function hasPaperAnalysis(photo) {
  return Boolean(photo?.uri) &&
    paperAnalysisCache.has(getPaperAnalysisKey(photo.uri, photo.width, photo.height));
}
const BLACK_AND_WHITE_ANALYSIS_EDGE = 256;
const SNAPSHOT_OPTIONS = {
  format: 'jpeg',
  compress: 0.92,
  flip: false,
};
const CROP_SNAPSHOT_OPTIONS = {
  format: 'jpeg',
  compress: 0.95,
  flip: false,
};

// Every exported renderer first resolves a GL-safe source: a local file whose
// pixels fit in one texture on this device. Most camera captures pass through
// untouched; oversized or non-file sources are normalized once per render.
export function renderPerspectiveCropAsync(options) {
  return renderWithGlSourceAsync(options, renderPerspectiveCropOnce);
}

export function renderAdaptiveThresholdAsync(options) {
  return renderWithGlSourceAsync(options, renderAdaptiveThresholdOnce);
}

export function renderInvertAsync(options) {
  return renderWithGlSourceAsync(options, renderInvertOnce);
}

export function renderMagicColorAsync(options) {
  return renderWithGlSourceAsync(options, renderMagicColorOnce);
}

function throwIfRenderCancelled(shouldCancel) {
  if (!shouldCancel?.()) return;
  const error = new Error('Image rendering was cancelled.');
  error.renderCancelled = true;
  throw error;
}

async function renderWithGlSourceAsync(options, render) {
  throwIfRenderCancelled(options.shouldCancel);
  const limits = await getGlLimitsAsync();
  throwIfRenderCancelled(options.shouldCancel);
  // Source preparation uses the image manipulator, not GL, so it runs before
  // taking a turn on the shared context.
  const prepared = await prepareGlSourceAsync(options, limits);
  try {
    throwIfRenderCancelled(options.shouldCancel);
    // Normalization can create a new temporary URI on every render. Keep the
    // analysis tied to the source before that copy, so saves reuse previews.
    const analysisKey = options.analysisKey ??
      getPaperAnalysisKey(options.uri, options.sourceWidth, options.sourceHeight);
    const input = prepared ? {
      ...options,
      analysisKey,
      uri: prepared.uri,
      sourceWidth: prepared.width,
      sourceHeight: prepared.height,
    } : { ...options, analysisKey };
    return await runOnGlSession((session) => {
      // A queued warm-up may no longer be wanted when editing takes priority.
      // Check before decoding/uploading the original capture into a texture.
      throwIfRenderCancelled(options.shouldCancel);
      return render(input, session);
    }, options.priority);
  } finally {
    if (prepared?.temporary) await cleanupProcessedImagesAsync([prepared]);
  }
}

// --- One persistent GL context ------------------------------------------
// Creating a context and compiling the document shaders used to happen on
// every render. A single context now lives for the app session, with each
// program compiled once. Renders take turns on it (GL state must not
// interleave across the awaits in a render); on-screen renders ('high') go
// before background saves and speculative work ('low').

let glSession = null;
let glSessionPromise = null;
let glBusy = false;
const glWaiting = { high: [], low: [] };

function runOnGlSession(task, priority = 'high') {
  return new Promise((resolve, reject) => {
    glWaiting[priority === 'low' ? 'low' : 'high'].push({ task, resolve, reject });
    pumpGlQueue();
  });
}

function pumpGlQueue() {
  if (glBusy) return;
  const next = glWaiting.high.shift() ?? glWaiting.low.shift();
  if (!next) return;
  glBusy = true;
  (async () => {
    try {
      const session = await getGlSessionAsync();
      next.resolve(await next.task(session));
    } catch (error) {
      // Cancelled renders run their normal finally cleanup. Preserve the
      // context and compiled shaders; real failures still get a fresh context.
      if (!error?.renderCancelled && !error?.paperAnalysisCancelled) invalidateGlSession();
      next.reject(error);
    } finally {
      glBusy = false;
      pumpGlQueue();
    }
  })();
}

async function getGlSessionAsync() {
  if (glSession) return glSession;
  if (!glSessionPromise) {
    glSessionPromise = (async () => {
      const GLView = getGLView();
      const gl = await GLView.createContextAsync();
      const limits = readGlLimits(gl);
      if (limits.probed) outputEdgeLimit = Math.min(MAX_OUTPUT_EDGE, limits.maxTextureEdge);
      glSession = { gl, limits, programs: new Map() };
      return glSession;
    })().finally(() => { glSessionPromise = null; });
  }
  return glSessionPromise;
}

function invalidateGlSession() {
  const session = glSession;
  glSession = null;
  if (!session) return;
  try {
    session.programs.forEach((program) => session.gl.deleteProgram(program));
  } catch {
    // The context is being discarded anyway.
  }
  try {
    void getGLView().destroyContextAsync(session.gl).catch(() => {});
  } catch {
    // expo-gl unavailable; nothing to destroy.
  }
}

// Every program uses the shared vertex shader, so the fragment shader
// identifies it.
function getCachedProgram(session, vertexSource, fragmentSource) {
  let program = session.programs.get(fragmentSource);
  if (!program) {
    program = createProgram(session.gl, vertexSource, fragmentSource);
    session.programs.set(fragmentSource, program);
  }
  return program;
}

// Leaves no bindings behind for the next render on the shared context.
function resetGlState(gl) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.useProgram(null);
  for (let index = 0; index < 4; index += 1) gl.disableVertexAttribArray(index);
}

/**
 * Creates the shared context and compiles every document shader ahead of the
 * first render, so the first crop or finish does not pay for it. Safe to call
 * repeatedly; runs at low priority so it never delays a visible render.
 */
export function warmUpGlAsync() {
  return runOnGlSession((session) => {
    for (const fragment of [
      FRAGMENT_SHADER,
      BLACK_AND_WHITE_ANALYSIS_FRAGMENT_SHADER,
      ADAPTIVE_THRESHOLD_FRAGMENT_SHADER,
      INVERT_FRAGMENT_SHADER,
      MAGIC_COLOR_FRAGMENT_SHADER,
    ]) getCachedProgram(session, VERTEX_SHADER, fragment);
    return session.limits;
  }, 'low').catch((error) => {
    console.warn('[perspective-crop] GL warm-up failed; renders will retry', error);
    return null;
  });
}

/**
 * Reads the GL limits once per app session, from the shared context. A failed
 * read is not cached, so the next render tries again instead of keeping the
 * fallback forever.
 */
export function getGlLimitsAsync() {
  if (glSession?.limits?.probed) return Promise.resolve(glSession.limits);
  if (!glLimitsPromise) {
    glLimitsPromise = runOnGlSession((session) => session.limits)
      .then((limits) => {
        if (!limits.probed) glLimitsPromise = null;
        return limits;
      }, (error) => {
        console.warn('[perspective-crop] Could not read GL limits; using safe defaults', error);
        glLimitsPromise = null;
        return { maxTextureEdge: FALLBACK_GL_TEXTURE_EDGE, probed: false };
      });
  }
  return glLimitsPromise;
}

function readGlLimits(gl) {
  try {
    const readEdge = (name) => {
      const value = gl.getParameter(gl[name]);
      const edge = Array.isArray(value) || ArrayBuffer.isView(value)
        ? Math.min(...Array.from(value))
        : Number(value);
      return Number.isFinite(edge) && edge > 0 ? edge : null;
    };
    const edges = [
      readEdge('MAX_TEXTURE_SIZE'),
      readEdge('MAX_RENDERBUFFER_SIZE'),
      readEdge('MAX_VIEWPORT_DIMS'),
    ].filter(Boolean);
    if (!edges.length) return { maxTextureEdge: FALLBACK_GL_TEXTURE_EDGE, probed: false };
    return { maxTextureEdge: Math.min(...edges), probed: true };
  } catch {
    return { maxTextureEdge: FALLBACK_GL_TEXTURE_EDGE, probed: false };
  }
}

function isLocalFileUri(uri) {
  return typeof uri === 'string' && uri.startsWith('file://');
}

// Returns null when the source can be uploaded as-is, otherwise a temporary
// local copy that fits in a single texture.
async function prepareGlSourceAsync({ uri, sourceWidth, sourceHeight }, limits) {
  if (!uri) return null;
  const knownSize = Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) &&
    sourceWidth > 0 && sourceHeight > 0;
  const oversized = knownSize && Math.max(sourceWidth, sourceHeight) > limits.maxTextureEdge;
  if (isLocalFileUri(uri) && !oversized) return null;

  return normalizeImageForGlAsync(uri, {
    maxEdge: limits.maxTextureEdge,
    width: knownSize ? sourceWidth : null,
    height: knownSize ? sourceHeight : null,
  });
}

/**
 * Prepares a gallery image for editing. Re-encoding through the image loader
 * bakes EXIF orientation into the pixels, yields a local file:// URI for
 * content:// or asset-library sources, and reports the true decoded size, so
 * crops, filters, and the on-screen preview all agree on orientation.
 * Falls back to the original asset when it is already a local file and the
 * copy cannot be made (for example, expo-image-manipulator is not installed).
 */
export async function prepareImportedImageAsync(image) {
  if (!image?.uri) throw new Error('The selected gallery image has no URI.');
  const limits = await getGlLimitsAsync();
  try {
    const normalized = await normalizeImageForGlAsync(image.uri, {
      maxEdge: limits.maxTextureEdge,
      width: image.width,
      height: image.height,
    });
    return { ...image, ...normalized, fileName: image.fileName ?? null, sourceUri: image.uri };
  } catch (error) {
    // A local file is still usable: the renderers re-check its size on every
    // pass. Only non-file sources (content://, ph://) truly need the copy.
    if (isLocalFileUri(image.uri)) {
      console.warn('[perspective-crop] Importing without normalization', error);
      return image;
    }
    throw error;
  }
}

/**
 * A downscaled copy of a capture for preview renders, so each preview pass
 * decodes and uploads a few megapixels instead of the full capture. Returns
 * null when the capture is already about preview size or the copy cannot be
 * made; previews then render from the capture itself (slower, still correct).
 */
export async function createPreviewSourceAsync(photo, maxEdge = PREVIEW_OUTPUT_EDGE) {
  if (!photo?.uri || !(photo.width > 0 && photo.height > 0)) return null;
  if (Math.max(photo.width, photo.height) <= maxEdge * 1.15) return null;
  if (!getImageManipulatorModule()) return null;
  try {
    return await normalizeImageForGlAsync(photo.uri, { maxEdge, width: photo.width, height: photo.height });
  } catch (error) {
    console.warn('[perspective-crop] Preview source unavailable; using the capture', error);
    return null;
  }
}

function getImageManipulatorModule() {
  try {
    const module = require('expo-image-manipulator');
    return module?.ImageManipulator?.manipulate ? module : null;
  } catch {
    return null;
  }
}

function getFittedSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

async function normalizeImageForGlAsync(uri, { maxEdge, width, height }) {
  const module = getImageManipulatorModule();
  if (!module) {
    throw new Error(
      'This image needs to be resized or copied before editing, which requires expo-image-manipulator. ' +
      'Install it with "npx expo install expo-image-manipulator" and rebuild the development client.'
    );
  }

  const { ImageManipulator, SaveFormat } = module;
  const refs = [];
  const track = (ref) => {
    if (ref) refs.push(ref);
    return ref;
  };

  try {
    // Downscale while decoding when the reported size is already too large so
    // a very high-resolution photo is never fully decoded at its native size.
    const firstContext = track(ImageManipulator.manipulate(uri));
    if (width && height && Math.max(width, height) > maxEdge) {
      firstContext.resize(width >= height ? { width: maxEdge, height: null } : { width: null, height: maxEdge });
    }
    let image = track(await firstContext.renderAsync());

    // Reported metadata can describe the stored (pre-EXIF) orientation, so
    // verify the decoded size and correct it with an exact second pass.
    if (Math.max(image.width, image.height) > maxEdge) {
      const fitted = getFittedSize(image.width, image.height, maxEdge);
      const fitContext = track(ImageManipulator.manipulate(image));
      fitContext.resize(fitted);
      image = track(await fitContext.renderAsync());
    }

    const saved = await image.saveAsync({
      format: SaveFormat?.JPEG ?? 'jpeg',
      compress: NORMALIZED_SOURCE_COMPRESS,
    });
    if (!isLocalFileUri(saved?.uri)) {
      throw new Error('Preparing the image did not produce a local file.');
    }
    return {
      uri: saved.uri,
      width: saved.width ?? image.width,
      height: saved.height ?? image.height,
      temporary: true,
    };
  } finally {
    refs.forEach((ref) => {
      try {
        ref.release?.();
      } catch {
        // Releasing native references is best effort.
      }
    });
  }
}

async function renderPerspectiveCropOnce({
  uri,
  corners,
  sourceWidth,
  sourceHeight,
  rotation = 0,
  maxOutputEdge,
}, session) {
  if (!uri) {
    throw new Error('A source image is required for perspective cropping.');
  }

  validateCorners(corners);

  const width = sourceWidth;
  const height = sourceHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Valid image dimensions are required for perspective cropping.');
  }
  const { outputSize, destinationToSource } = getEnhancementGeometry(width, height, corners, rotation, getOutputEdge(maxOutputEdge));
  const GLView = getGLView();
  const { gl } = session;
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = getCachedProgram(session, VERTEX_SHADER, FRAGMENT_SHADER);
    sourceTexture = createSourceTexture(gl, uri);
    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    gl.useProgram(program);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    setHomographyUniforms(gl, program, destinationToSource);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering the perspective crop');
    const snapshot = await GLView.takeSnapshotAsync(gl, {
      ...CROP_SNAPSHOT_OPTIONS,
      framebuffer,
      rect: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
    });
    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;
    if (!snapshotUri || typeof snapshotUri !== 'string') {
      throw new Error('Perspective crop completed without producing an image file.');
    }

    return {
      uri: snapshotUri,
      width: outputSize.width,
      height: outputSize.height,
      temporary: true,
    };
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      resetGlState(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] GL cleanup failed after render', cleanupError);
    }
  }
}

async function renderAdaptiveThresholdOnce({
  uri,
  sourceWidth,
  sourceHeight,
  corners,
  rotation = 0,
  maxOutputEdge,
  analysisKey,
  shouldCancel,
  shouldCancelAnalysis = shouldCancel,
}, session) {
  if (!uri) {
    throw new Error('A source image is required for black-and-white enhancement.');
  }

  const width = sourceWidth;
  const height = sourceHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Valid image dimensions are required for black-and-white enhancement.');
  }
  const { outputSize, destinationToSource } = getEnhancementGeometry(width, height, corners, rotation, getOutputEdge(maxOutputEdge));
  const GLView = getGLView();
  const { gl } = session;
  let sourceTexture;
  let paperTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    sourceTexture = createSourceTexture(gl, uri);
    // Cached per source image: only the first Black & White or Invert render
    // of a photo analyses it. Later renders (the other finish, a retry, the
    // full-size save) go straight to the GPU pass below.
    const paper = await ensurePaperAnalysis(session, {
      uri, width, height, sourceTexture, analysisKey, shouldCancel: shouldCancelAnalysis,
    });
    // A different finish may need the same analysis. Finish that shared work,
    // then skip this obsolete coloring pass before allocating its output.
    throwIfRenderCancelled(shouldCancel);

    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    paperTexture = createOutputTexture(gl, paper.width, paper.height);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, paper.width, paper.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, paper.pixels
    );
    checkGlError(gl, 'preparing the document paper map');

    program = getCachedProgram(session, VERTEX_SHADER, ADAPTIVE_THRESHOLD_FRAGMENT_SHADER);
    gl.useProgram(program);
    setHomographyUniforms(gl, program, destinationToSource);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    const inkPositionLocation = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(inkPositionLocation);
    gl.vertexAttribPointer(inkPositionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, paperTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uPaperTexture'), 1);
    gl.uniform2f(gl.getUniformLocation(program, 'uPaperTexelSize'), 1 / paper.width, 1 / paper.height);
    gl.uniform2f(
      gl.getUniformLocation(program, 'uTexelSize'),
      1 / outputSize.width,
      1 / outputSize.height
    );
    gl.uniform1f(
      gl.getUniformLocation(program, 'uBackgroundIsDark'),
      paper.backgroundIsDark ? 1 : 0
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering the adaptive threshold');

    const snapshot = await GLView.takeSnapshotAsync(gl, {
      ...SNAPSHOT_OPTIONS,
      framebuffer,
      rect: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
    });
    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;

    if (!snapshotUri || typeof snapshotUri !== 'string') {
      throw new Error('Adaptive threshold completed without producing an image file.');
    }

    return {
      uri: snapshotUri,
      width: outputSize.width,
      height: outputSize.height,
      temporary: true,
    };
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (paperTexture) gl.deleteTexture(paperTexture);
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      resetGlState(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Adaptive threshold cleanup failed', cleanupError);
    }
  }
}


async function renderInvertOnce({
  uri,
  sourceWidth,
  sourceHeight,
  settings,
  corners,
  rotation = 0,
  maxOutputEdge,
  analysisKey,
  preview = false,
  shouldCancel,
  shouldCancelAnalysis = shouldCancel,
}, session) {
  if (!uri) {
    throw new Error('A source image is required for Invert enhancement.');
  }

  const palette = getInvertPalette(settings);
  const width = sourceWidth;
  const height = sourceHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Valid image dimensions are required for Invert enhancement.');
  }
  const { outputSize, destinationToSource } = getEnhancementGeometry(width, height, corners, rotation, getOutputEdge(maxOutputEdge));
  const GLView = getGLView();
  const { gl } = session;
  let sourceTexture;
  let paperTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    sourceTexture = createSourceTexture(gl, uri);
    // Cached per source image: only the first Black & White or Invert render
    // of a photo analyses it. Later renders (the other finish, a retry, the
    // full-size save) go straight to the GPU pass below.
    const paper = await ensurePaperAnalysis(session, {
      uri, width, height, sourceTexture, analysisKey, shouldCancel: shouldCancelAnalysis,
    });
    // A different finish may need the same analysis. Finish that shared work,
    // then skip this obsolete coloring pass before allocating its output.
    throwIfRenderCancelled(shouldCancel);

    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    paperTexture = createOutputTexture(gl, paper.width, paper.height);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, paper.width, paper.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, paper.pixels
    );
    checkGlError(gl, 'preparing the document paper map');

    program = getCachedProgram(session, VERTEX_SHADER, INVERT_FRAGMENT_SHADER);
    gl.useProgram(program);
    setHomographyUniforms(gl, program, destinationToSource);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    const inkPositionLocation = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(inkPositionLocation);
    gl.vertexAttribPointer(inkPositionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, paperTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uPaperTexture'), 1);
    gl.uniform2f(gl.getUniformLocation(program, 'uPaperTexelSize'), 1 / paper.width, 1 / paper.height);
    gl.uniform2f(
      gl.getUniformLocation(program, 'uTexelSize'),
      1 / outputSize.width,
      1 / outputSize.height
    );
    gl.uniform1f(
      gl.getUniformLocation(program, 'uBackgroundIsDark'),
      paper.backgroundIsDark ? 1 : 0
    );
    gl.uniform3f(gl.getUniformLocation(program, 'uBackgroundColor'), ...palette.background);
    gl.uniform3f(gl.getUniformLocation(program, 'uInkColor'), ...palette.ink);
    gl.uniform1f(gl.getUniformLocation(program, 'uInkGamma'), palette.gamma);
    gl.uniform1f(gl.getUniformLocation(program, 'uPreserveAccents'), palette.preserveAccents ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering Invert');

    const snapshot = await GLView.takeSnapshotAsync(gl, {
      format: preview ? 'jpeg' : 'png',
      compress: preview ? 0.95 : 1,
      flip: false,
      framebuffer,
      rect: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
    });
    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;

    if (!snapshotUri || typeof snapshotUri !== 'string') {
      throw new Error('Invert enhancement completed without producing an image file.');
    }

    return {
      uri: snapshotUri,
      width: outputSize.width,
      height: outputSize.height,
      temporary: true,
    };
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (paperTexture) gl.deleteTexture(paperTexture);
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      resetGlState(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Invert cleanup failed', cleanupError);
    }
  }
}

/**
 * The page analysis for one source image: a small GPU pass read back to JS,
 * then the paper-map estimate. Cached by source (see paperAnalysisCache).
 * `sourceTexture` is reused when the caller already uploaded the source, so a
 * first render does not decode it twice. `shouldCancel` is polled while the
 * estimate yields; a cancelled analysis throws an error flagged
 * `paperAnalysisCancelled` and caches nothing.
 */
async function ensurePaperAnalysis(session, { uri, width, height, sourceTexture = null, analysisKey, shouldCancel }) {
  const key = analysisKey ?? getPaperAnalysisKey(uri, width, height);
  const cached = await paperAnalysisCache.get(key);
  if (cached) return cached;

  const { gl } = session;
  const analysisScale = Math.min(1, BLACK_AND_WHITE_ANALYSIS_EDGE / Math.max(width, height));
  const analysisWidth = Math.max(1, Math.round(width * analysisScale));
  const analysisHeight = Math.max(1, Math.round(height * analysisScale));
  const analysisPixels = new Uint8Array(analysisWidth * analysisHeight * 4);
  let ownTexture;
  let outputTexture;
  let framebuffer;
  let positionBuffer;

  try {
    const texture = sourceTexture ?? (ownTexture = createSourceTexture(gl, uri));
    outputTexture = createOutputTexture(gl, analysisWidth, analysisHeight);
    framebuffer = createFramebuffer(gl, outputTexture);
    const analysisProgram = getCachedProgram(session, VERTEX_SHADER, BLACK_AND_WHITE_ANALYSIS_FRAGMENT_SHADER);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, analysisWidth, analysisHeight);
    gl.useProgram(analysisProgram);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(analysisProgram, 'aPosition');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(analysisProgram, 'uTexture'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read only a small analysis image. Paper estimation and interpolation
    // happen once per image, rather than independently inside every ink pixel.
    gl.readPixels(0, 0, analysisWidth, analysisHeight, gl.RGBA, gl.UNSIGNED_BYTE, analysisPixels);
    checkGlError(gl, 'analysing the document background');
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (ownTexture) gl.deleteTexture(ownTexture);
      resetGlState(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Analysis cleanup failed', cleanupError);
    }
  }

  // All GL objects are released; the rest is JavaScript, cut into slices.
  const paper = await estimateBlackAndWhitePaperAsync(
    analysisPixels, analysisWidth, analysisHeight, createTimeSlicer(shouldCancel)
  );
  await paperAnalysisCache.set(key, paper);
  return paper;
}

/**
 * Prepares the page analysis for a capture ahead of time, at low priority, so
 * the first Black & White or Invert render of it needs only the GPU pass.
 * Resolves 'done', 'cancelled' (by `shouldCancel`, polled between slices of
 * work) or 'skipped' (a source the renderers would copy first, which would
 * not share this cache entry).
 */
export async function prefetchDocumentAnalysisAsync(photo, { shouldCancel } = {}) {
  if (!photo?.uri || !(photo.width > 0 && photo.height > 0)) return 'skipped';
  if (hasPaperAnalysis(photo)) return 'done';
  if (shouldCancel?.()) return 'cancelled';
  if (await paperAnalysisCache.get(getPaperAnalysisKey(photo.uri, photo.width, photo.height))) return 'done';
  const limits = await getGlLimitsAsync();
  if (!isLocalFileUri(photo.uri) || Math.max(photo.width, photo.height) > limits.maxTextureEdge) {
    return 'skipped';
  }
  return runOnGlSession(async (session) => {
    // The task may have waited behind other renders; do nothing if the photo
    // is no longer wanted by the time its turn comes.
    if (shouldCancel?.()) return 'cancelled';
    try {
      await ensurePaperAnalysis(session, {
        uri: photo.uri, width: photo.width, height: photo.height, shouldCancel,
      });
      return 'done';
    } catch (error) {
      // Resolved, not thrown: a failed task makes the shared GL context start over.
      if (error?.paperAnalysisCancelled) return 'cancelled';
      throw error;
    }
  }, 'low');
}

async function renderMagicColorOnce({
  uri,
  sourceWidth,
  sourceHeight,
  corners,
  rotation = 0,
  maxOutputEdge,
  referenceWidth,
  referenceHeight,
}, session) {
  if (!uri) {
    throw new Error('A source image is required for magic-color enhancement.');
  }

  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const { outputSize, destinationToSource } = getEnhancementGeometry(width, height, corners, rotation, getOutputEdge(maxOutputEdge));
  const GLView = getGLView();
  const { gl } = session;
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = getCachedProgram(session, VERTEX_SHADER, MAGIC_COLOR_FRAGMENT_SHADER);
    sourceTexture = createSourceTexture(gl, uri);
    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    gl.useProgram(program);
    setHomographyUniforms(gl, program, destinationToSource);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

    const texelSizeLocation = gl.getUniformLocation(program, 'uTexelSize');
    const sampleStepLocation = gl.getUniformLocation(program, 'uSampleStep');
    const thresholdBiasLocation = gl.getUniformLocation(program, 'uThresholdBias');

    if (
      texelSizeLocation === null ||
      sampleStepLocation === null ||
      thresholdBiasLocation === null
    ) {
      throw new Error('The magic-color shader uniforms are unavailable.');
    }

    // Illumination and paper estimates sample up to 48 texels away. Sizing
    // texels from the full capture keeps that reach the same fraction of the
    // page when a preview renders from a smaller copy, so a preview matches
    // the saved image instead of looking flatter.
    gl.uniform2f(texelSizeLocation, 1 / (referenceWidth || width), 1 / (referenceHeight || height));
    gl.uniform1f(sampleStepLocation, 12);
    gl.uniform1f(thresholdBiasLocation, 0.09);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering magic color');

    const snapshot = await GLView.takeSnapshotAsync(gl, {
      ...SNAPSHOT_OPTIONS,
      framebuffer,
      rect: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
    });
    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;

    if (!snapshotUri || typeof snapshotUri !== 'string') {
      throw new Error('Magic-color enhancement completed without producing an image file.');
    }

    return {
      uri: snapshotUri,
      width: outputSize.width,
      height: outputSize.height,
      temporary: true,
    };
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      resetGlState(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Magic color cleanup failed', cleanupError);
    }
  }
}

function getGLView() {
  try {
    const module = require('expo-gl');
    if (!module?.GLView) throw new Error('The Expo GL module is unavailable.');
    return module.GLView;
  } catch (error) {
    console.error('[perspective-crop] expo-gl is unavailable', error);
    throw new Error(
      'Image processing requires expo-gl in the native build. Rebuild the preview or development client with expo-gl included.'
    );
  }
}

export async function cleanupProcessedImagesAsync(images) {
  const cleanupTasks = (Array.isArray(images) ? images : [images]).map(async (image) => {
    if (!image?.temporary || !image.uri) return;

    try {
      await FileSystem.deleteAsync(image.uri, { idempotent: true });
    } catch (error) {
      console.warn('[perspective-crop] Temporary image cleanup failed', error);
    }
  });

  await Promise.all(cleanupTasks);
}

function getEnhancementGeometry(width, height, corners, rotation = 0, maxEdge = outputEdgeLimit) {
  const normalizedRotation = normalizeRotation(rotation);
  if (!corners && normalizedRotation === 0) {
    return {
      outputSize: getScaledOutputSize(width, height, maxEdge),
      destinationToSource: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    };
  }

  const cropCorners = corners ?? {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  };
  validateCorners(cropCorners);
  const displayedWidth = normalizedRotation % 180 === 0 ? width : height;
  const displayedHeight = normalizedRotation % 180 === 0 ? height : width;
  const displayedCorners = getPixelAlignedCorners(cropCorners, displayedWidth, displayedHeight);
  const sourceCorners = mapCornersToSource(displayedCorners, normalizedRotation);
  const outputSize = getOutputSize(displayedCorners, displayedWidth, displayedHeight, maxEdge);
  const axisAlignedCrop = normalizedRotation === 0 ? getAxisAlignedCrop(sourceCorners) : null;
  const destinationToSource = axisAlignedCrop
    ? getAxisAlignedTransform(axisAlignedCrop)
    : solveHomography(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        [
          sourceCorners.topLeft,
          sourceCorners.topRight,
          sourceCorners.bottomRight,
          sourceCorners.bottomLeft,
        ]
      );

  return { outputSize, destinationToSource };
}

function validateCorners(corners) {
  if (!corners) {
    throw new Error('No crop handles were supplied.');
  }

  const names = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  names.forEach((name) => {
    const point = corners[name];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`Crop handle ${name} is invalid.`);
    }
  });
}

function normalizeRotation(rotation) {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized - (normalized % 90);
}

function mapCornersToSource(corners, rotation) {
  return Object.fromEntries(
    Object.entries(corners).map(([corner, point]) => [corner, mapPointToSource(point, rotation)])
  );
}

function mapPointToSource(point, rotation) {
  switch (rotation) {
    case 90:
      return { x: point.y, y: 1 - point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: 1 - point.y, y: point.x };
    default:
      return point;
  }
}

function getAxisAlignedCrop(corners) {
  const epsilon = 0.0001;
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;

  const isRectangle =
    Math.abs(topLeft.y - topRight.y) <= epsilon &&
    Math.abs(bottomLeft.y - bottomRight.y) <= epsilon &&
    Math.abs(topLeft.x - bottomLeft.x) <= epsilon &&
    Math.abs(topRight.x - bottomRight.x) <= epsilon;

  if (!isRectangle) return null;

  const left = topLeft.x;
  const right = topRight.x;
  const top = topLeft.y;
  const bottom = bottomLeft.y;

  if (right - left <= epsilon || bottom - top <= epsilon) {
    throw new Error('The selected crop rectangle is too small.');
  }

  return { left, right, top, bottom };
}

function getPixelAlignedCorners(corners, width, height) {
  const rectangle = getAxisAlignedCrop(corners);
  if (!rectangle) return corners;

  // A rectangular crop does not need sub-pixel resampling. Round outwards to
  // retain the selection and align pixel centers, including after quarter turns.
  const epsilon = 1e-7;
  const left = Math.max(0, Math.floor(rectangle.left * width + epsilon)) / width;
  const right = Math.min(width, Math.ceil(rectangle.right * width - epsilon)) / width;
  const top = Math.max(0, Math.floor(rectangle.top * height + epsilon)) / height;
  const bottom = Math.min(height, Math.ceil(rectangle.bottom * height - epsilon)) / height;

  return {
    topLeft: { x: left, y: top },
    topRight: { x: right, y: top },
    bottomRight: { x: right, y: bottom },
    bottomLeft: { x: left, y: bottom },
  };
}

// The device limit always applies; a preview render can ask for less.
function getOutputEdge(maxOutputEdge) {
  return Number.isFinite(maxOutputEdge) && maxOutputEdge > 0
    ? Math.min(outputEdgeLimit, maxOutputEdge)
    : outputEdgeLimit;
}

function getAxisAlignedTransform(crop) {
  return [
    [crop.right - crop.left, 0, crop.left],
    [0, crop.bottom - crop.top, crop.top],
    [0, 0, 1],
  ];
}

function getScaledOutputSize(width, height, maxEdge = outputEdgeLimit) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function getOutputSize(corners, sourceWidth, sourceHeight, maxEdge = outputEdgeLimit) {
  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const top = distanceInPixels(corners.topLeft, corners.topRight, width, height);
  const bottom = distanceInPixels(corners.bottomLeft, corners.bottomRight, width, height);
  const left = distanceInPixels(corners.topLeft, corners.bottomLeft, width, height);
  const right = distanceInPixels(corners.topRight, corners.bottomRight, width, height);
  const rawWidth = Math.max(1, Math.round((top + bottom) / 2));
  const rawHeight = Math.max(1, Math.round((left + right) / 2));
  const scale = Math.min(1, maxEdge / Math.max(rawWidth, rawHeight));

  return {
    width: Math.max(1, Math.round(rawWidth * scale)),
    height: Math.max(1, Math.round(rawHeight * scale)),
  };
}

function distanceInPixels(first, second, width, height) {
  const deltaX = (second.x - first.x) * width;
  const deltaY = (second.y - first.y) * height;
  return Math.sqrt(deltaX ** 2 + deltaY ** 2);
}

function solveHomography(fromPoints, toPoints) {
  const matrix = [];
  const values = [];

  fromPoints.forEach((from, index) => {
    const to = toPoints[index];
    matrix.push([
      from.x,
      from.y,
      1,
      0,
      0,
      0,
      -to.x * from.x,
      -to.x * from.y,
    ]);
    values.push(to.x);
    matrix.push([
      0,
      0,
      0,
      from.x,
      from.y,
      1,
      -to.y * from.x,
      -to.y * from.y,
    ]);
    values.push(to.y);
  });

  const solution = solveLinearSystem(matrix, values);

  return [
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1],
  ];
}

function solveLinearSystem(matrix, values) {
  const augmented = matrix.map((row, index) => [...row, values[index]]);

  for (let column = 0; column < augmented.length; column += 1) {
    let pivotRow = column;

    for (let row = column + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }

    if (Math.abs(augmented[pivotRow][column]) < 1e-10) {
      throw new Error('The selected crop points do not form a valid quadrilateral.');
    }

    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];

    const pivot = augmented[column][column];
    for (let value = column; value <= augmented.length; value += 1) {
      augmented[column][value] /= pivot;
    }

    for (let row = 0; row < augmented.length; row += 1) {
      if (row === column) continue;

      const factor = augmented[row][column];
      for (let value = column; value <= augmented.length; value += 1) {
        augmented[row][value] -= factor * augmented[column][value];
      }
    }
  }

  return augmented.map((row) => row[augmented.length]);
}

function setHomographyUniforms(gl, program, matrix) {
  const names = [
    ['uH00', matrix[0][0]],
    ['uH01', matrix[0][1]],
    ['uH02', matrix[0][2]],
    ['uH10', matrix[1][0]],
    ['uH11', matrix[1][1]],
    ['uH12', matrix[1][2]],
    ['uH20', matrix[2][0]],
    ['uH21', matrix[2][1]],
    ['uH22', matrix[2][2]],
  ];

  names.forEach(([name, value]) => {
    const location = gl.getUniformLocation(program, name);
    if (location === null) {
      throw new Error(`The perspective shader uniform ${name} is unavailable.`);
    }
    gl.uniform1f(location, value);
  });

  checkGlError(gl, 'setting the perspective homography');
}

function createSourceTexture(gl, uri) {
  if (!uri.startsWith('file://')) {
    throw new Error(`Perspective crop requires a local file URI. Received: ${uri}`);
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    { localUri: uri }
  );

  checkGlError(gl, 'loading the source image texture');

  return texture;
}

function createOutputTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  checkGlError(gl, 'creating the output texture');
  return texture;
}

function createFramebuffer(gl, texture) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('The perspective crop framebuffer could not be created.');
  }

  checkGlError(gl, 'creating the framebuffer');

  return framebuffer;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown shader link error.';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  checkGlError(gl, 'linking the shader program');

  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compile error.';
    gl.deleteShader(shader);
    throw new Error(message);
  }

  checkGlError(gl, 'compiling a shader');

  return shader;
}

function checkGlError(gl, operation) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    console.error('[perspective-crop] WebGL error', { operation, error });
    throw new Error(`WebGL failed while ${operation} (error ${error}).`);
  }
}

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vOutputUv;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vOutputUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uTexture;
  uniform float uH00;
  uniform float uH01;
  uniform float uH02;
  uniform float uH10;
  uniform float uH11;
  uniform float uH12;
  uniform float uH20;
  uniform float uH21;
  uniform float uH22;
  varying vec2 vOutputUv;

  void main() {
    float sourceW = uH20 * vOutputUv.x + uH21 * vOutputUv.y + uH22;
    float sourceX = (uH00 * vOutputUv.x + uH01 * vOutputUv.y + uH02) / sourceW;
    float sourceY = (uH10 * vOutputUv.x + uH11 * vOutputUv.y + uH12) / sourceW;
    vec2 sourceUv = vec2(sourceX, sourceY);
    // Expo's localUri texture upload already uses the image's top-to-bottom
    // coordinate order. Do not invert Y here; doing so swaps top and bottom
    // crop selections when only a horizontal edge is moved.
    gl_FragColor = texture2D(uTexture, sourceUv);
  }
`;

const BLACK_AND_WHITE_ANALYSIS_FRAGMENT_SHADER = `
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vOutputUv;

  void main() {
    gl_FragColor = texture2D(uTexture, vOutputUv);
  }
`;

const ENHANCEMENT_TRANSFORM_SHADER = `
  uniform float uH00;
  uniform float uH01;
  uniform float uH02;
  uniform float uH10;
  uniform float uH11;
  uniform float uH12;
  uniform float uH20;
  uniform float uH21;
  uniform float uH22;

  vec2 mapEnhancementUv(vec2 outputUv) {
    float sourceW = uH20 * outputUv.x + uH21 * outputUv.y + uH22;
    return vec2(
      (uH00 * outputUv.x + uH01 * outputUv.y + uH02) / sourceW,
      (uH10 * outputUv.x + uH11 * outputUv.y + uH12) / sourceW
    );
  }
`;

// Shared detection keeps the B&W and Invert foreground masks identical.
const DOCUMENT_INK_SHADER_HELPERS = `
  precision highp float;
  ${ENHANCEMENT_TRANSFORM_SHADER}

  uniform sampler2D uTexture;
  uniform sampler2D uPaperTexture;
  uniform vec2 uPaperTexelSize;
  uniform vec2 uTexelSize;
  uniform float uBackgroundIsDark;
  varying vec2 vOutputUv;

  float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
  }

  vec3 paperReference(vec2 uv, float intensity) {
    vec2 position = uv / uPaperTexelSize - 0.5;
    vec2 base = floor(position);
    vec2 fraction = fract(position);
    vec2 halfTexel = uPaperTexelSize * 0.5;
    vec3 a = texture2D(uPaperTexture, clamp((base + vec2(0.5, 0.5)) * uPaperTexelSize, halfTexel, vec2(1.0) - halfTexel)).rgb;
    vec3 b = texture2D(uPaperTexture, clamp((base + vec2(1.5, 0.5)) * uPaperTexelSize, halfTexel, vec2(1.0) - halfTexel)).rgb;
    vec3 c = texture2D(uPaperTexture, clamp((base + vec2(0.5, 1.5)) * uPaperTexelSize, halfTexel, vec2(1.0) - halfTexel)).rgb;
    vec3 d = texture2D(uPaperTexture, clamp((base + vec2(1.5, 1.5)) * uPaperTexelSize, halfTexel, vec2(1.0) - halfTexel)).rgb;
    float lowest = min(min(a.r, b.r), min(c.r, d.r));
    float highest = max(max(a.r, b.r), max(c.r, d.r));
    // Keep smooth penumbrae linear: choosing the darker neighboring reference
    // there would reduce the contrast of faint writing. Reserve range-guided
    // sampling for a genuine discontinuity in the analysis map.
    if (highest - lowest <= 0.04) return texture2D(uPaperTexture, uv).rgb;

    // Jointly upsample the analysis map at the actual source pixel. Otherwise
    // bilinear filtering can put a bright reference on the dark side of a
    // sharp shadow edge and turn that paper into a band of false gray ink.
    vec4 difference = abs(vec4(a.r, b.r, c.r, d.r) - intensity) /
      max(vec4(0.018), vec4(a.g, b.g, c.g, d.g) * 0.5);
    vec4 squared = difference * difference;
    vec4 spatial = vec4(
      (1.0 - fraction.x) * (1.0 - fraction.y),
      fraction.x * (1.0 - fraction.y),
      (1.0 - fraction.x) * fraction.y,
      fraction.x * fraction.y
    );
    vec4 weights = spatial / (vec4(1.0) + squared * squared);
    float weightSum = dot(weights, vec4(1.0));
    return (a * weights.x + b * weights.y + c * weights.z + d * weights.w) /
      max(weightSum, 0.000000001);
  }

  float inkEvidence(vec2 uv, float paper, float neutralPaper) {
    vec3 color = texture2D(uTexture, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
    float intensity = mix(luminance(color), 1.0 - luminance(color), uBackgroundIsDark);
    // The reference is interpolated paper, never the mean of surrounding ink.
    // A uniform black interior consequently retains the same evidence as its edge.
    float relativeDarkness = max(0.0, (paper - intensity) / max(paper, 0.08));
    float value = max(color.r, max(color.g, color.b));
    float chroma = value - min(color.r, min(color.g, color.b));
    float saturation = chroma / max(value, 0.001);
    // Keep bright colored pen strokes, but avoid promoting tinted backgrounds.
    float coloredInk = smoothstep(0.06, 0.30, chroma) *
      smoothstep(0.12, 0.55, saturation) * smoothstep(0.18, 0.92, value) *
      neutralPaper * (1.0 - uBackgroundIsDark) * 0.45;
    return clamp(max(relativeDarkness, coloredInk), 0.0, 1.0);
  }

  float neighboringInkEvidence(vec2 uv, vec3 centerBackground) {
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    vec3 background = texture2D(uPaperTexture, uv).rgb;
    // The dark side of a shadow is not a foreground neighbor. Resolve its
    // own paper reference at discontinuities before using it to support an
    // edge; otherwise nearby show-through could be rescued as front-side ink.
    if (abs(background.r - centerBackground.r) > max(0.01, centerBackground.r * 0.04)) {
      float observed = luminance(texture2D(uTexture, uv).rgb);
      observed = mix(observed, 1.0 - observed, uBackgroundIsDark);
      background = paperReference(uv, observed);
    }
    return inkEvidence(uv, max(background.r, 0.08), background.b);
  }

`;

const DOCUMENT_INK_SHADER_MAIN = `  void main() {
    vec2 sourceUv = mapEnhancementUv(vOutputUv);
    float observed = luminance(texture2D(uTexture, sourceUv).rgb);
    observed = mix(observed, 1.0 - observed, uBackgroundIsDark);
    vec3 background = paperReference(sourceUv, observed);
    float paper = max(background.r, 0.08);
    float relativeNoise = background.g * 0.125 / paper;

    // Faint show-through must not become foreground merely because it forms
    // connected letters. Require a clearly darker stroke relative to the
    // corrected paper; keep a lower threshold only for its anti-aliased edge.
    float edgeThreshold = clamp(0.065 + 1.5 * relativeNoise, 0.080, 0.24);
    float foregroundThreshold = clamp(0.16 + 3.0 * relativeNoise, 0.180, 0.42);
    float center = inkEvidence(sourceUv, paper, background.b);
    vec2 stepSize = uTexelSize;

    float north = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(0.0, -stepSize.y)), background);
    float south = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(0.0, stepSize.y)), background);
    float west = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(-stepSize.x, 0.0)), background);
    float east = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(stepSize.x, 0.0)), background);
    float northWest = neighboringInkEvidence(mapEnhancementUv(vOutputUv - stepSize), background);
    float southEast = neighboringInkEvidence(mapEnhancementUv(vOutputUv + stepSize), background);
    float northEast = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(stepSize.x, -stepSize.y)), background);
    float southWest = neighboringInkEvidence(mapEnhancementUv(vOutputUv + vec2(-stepSize.x, stepSize.y)), background);

    float foregroundInk = step(foregroundThreshold, center);
    float strongestNeighbor = max(
      max(max(north, south), max(west, east)),
      max(max(northWest, southEast), max(northEast, southWest))
    );
    // Support is one pixel wide and always requires a confident foreground
    // neighbor. A whole pale word cannot seed itself or spread into paper.
    float foregroundEdge = step(foregroundThreshold, strongestNeighbor);
    float coverage = smoothstep(
      edgeThreshold,
      max(edgeThreshold + 0.025, foregroundThreshold * 0.90),
      center
    );
    // No dilation or hole filling: counters, punctuation, and barcode gaps
    // remain faithful to the source. Dark isolated marks still qualify.
    float inkMask = coverage * max(foregroundInk, foregroundEdge);
`;

const ADAPTIVE_THRESHOLD_FRAGMENT_SHADER = DOCUMENT_INK_SHADER_HELPERS +
  DOCUMENT_INK_SHADER_MAIN + `    float inkColor = 0.3019608; // Preserve the existing #4d4d4d export style.
    gl_FragColor = vec4(vec3(mix(1.0, inkColor, inkMask)), 1.0);
  }
`;

const INVERT_FRAGMENT_SHADER = DOCUMENT_INK_SHADER_HELPERS + `
  uniform vec3 uBackgroundColor;
  uniform vec3 uInkColor;
  uniform float uInkGamma;
  uniform float uPreserveAccents;

  vec3 accentColor(vec3 color) {
    float maximum = max(color.r, max(color.g, color.b));
    float minimum = min(color.r, min(color.g, color.b));
    float chroma = max(maximum - minimum, 0.0001);
    float hue;
    if (maximum == color.r) hue = mod((color.g - color.b) / chroma, 6.0);
    else if (maximum == color.g) hue = (color.b - color.r) / chroma + 2.0;
    else hue = (color.r - color.g) / chroma + 4.0;
    hue = fract(hue / 6.0 + 1.0);
    if (hue < 0.06 || hue >= 0.94) return vec3(255.0, 170.0, 166.0) / 255.0;
    if (hue < 0.18) return vec3(255.0, 213.0, 138.0) / 255.0;
    if (hue < 0.50) return vec3(166.0, 237.0, 206.0) / 255.0;
    if (hue < 0.72) return vec3(141.0, 232.0, 245.0) / 255.0;
    return vec3(216.0, 184.0, 255.0) / 255.0;
  }

` + DOCUMENT_INK_SHADER_MAIN + `    // Change only foreground coverage and palette; ink detection above is shared
    // with Black & White. Zero-coverage paper remains exactly the chosen navy.
    float inkCoverage = pow(clamp(inkMask, 0.0, 1.0), uInkGamma);
    vec3 original = texture2D(uTexture, sourceUv).rgb;
    float maximum = max(original.r, max(original.g, original.b));
    float chroma = maximum - min(original.r, min(original.g, original.b));
    float saturation = chroma / max(maximum, 0.001);
    // Neutral paper plus confident foreground prevents tinted paper and shadows
    // from acquiring accent colors. Black writing keeps the selected ink color.
    float accentConfidence = smoothstep(0.10, 0.30, chroma) *
      smoothstep(0.22, 0.55, saturation) * smoothstep(0.45, 0.80, background.b);
    vec3 textColor = mix(uInkColor, accentColor(original), uPreserveAccents * accentConfidence);
    gl_FragColor = vec4(mix(uBackgroundColor, textColor, inkCoverage), 1.0);
  }
`;

const MAGIC_COLOR_FRAGMENT_SHADER = `
  precision highp float;
  ${ENHANCEMENT_TRANSFORM_SHADER}

  uniform sampler2D uTexture;
  uniform vec2 uTexelSize;
  uniform float uSampleStep;
  uniform float uThresholdBias;
  varying vec2 vOutputUv;

  float redInkDominance(vec3 color) {
    return max(0.0, color.r - max(color.g, color.b));
  }

  float inkIntensity(vec3 color) {
    // Use the darkest channel so saturated red, blue, and green ink remain
    // detectable even though their luminance can be close to paper white.
    float darkestChannel = min(color.r, min(color.g, color.b));
    return max(0.0, darkestChannel - redInkDominance(color) * 0.75);
  }

  float paperBrightness(vec3 color) {
    return min(color.r, min(color.g, color.b));
  }

  float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
  }

  vec3 sampleCorrectedColor(
    vec2 uv,
    float illumination,
    float illuminationCorrectionEnabled
  ) {
    vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
    vec3 color = texture2D(uTexture, clampedUv).rgb;
    float scale = min(1.45, 1.0 / max(illumination, 0.5));
    scale = mix(1.0, scale, illuminationCorrectionEnabled);
    return min(color * scale, vec3(1.0));
  }

  float samplePaperBrightness(vec2 uv) {
    vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
    return paperBrightness(texture2D(uTexture, clampedUv).rgb);
  }

  float estimateGlobalBackgroundBrightness() {
    float sum = 0.0;

    for (int x = 0; x < 3; x += 1) {
      for (int y = 0; y < 3; y += 1) {
        vec2 sampleUv = vec2(
          (float(x) + 0.5) / 3.0,
          (float(y) + 0.5) / 3.0
        );
        sum += samplePaperBrightness(sampleUv);
      }
    }

    return sum / 9.0;
  }

  float estimateLocalIllumination(vec2 centerUv) {
    vec2 illuminationStep = uTexelSize * 48.0;
    float sum = 0.0;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        vec2 sampleUv = clamp(
          centerUv + vec2(float(x), float(y)) * illuminationStep,
          vec2(0.0),
          vec2(1.0)
        );
        sum += samplePaperBrightness(sampleUv);
      }
    }

    return max(sum / 9.0, 0.5);
  }

  float sampleInkIntensity(
    vec2 uv,
    float illumination,
    float illuminationCorrectionEnabled
  ) {
    return inkIntensity(sampleCorrectedColor(
      uv,
      illumination,
      illuminationCorrectionEnabled
    ));
  }

  float inkStrength(
    float value,
    float localMean,
    float backgroundIsDark
  ) {
    float threshold = mix(
      localMean - uThresholdBias,
      localMean + uThresholdBias,
      backgroundIsDark
    );
    float separation = mix(
      threshold - value,
      value - threshold,
      backgroundIsDark
    );
    return smoothstep(-0.04, 0.08, separation);
  }

  vec3 increaseSaturation(vec3 color, float amount) {
    float gray = luminance(color);
    return clamp(
      vec3(gray) + (color - vec3(gray)) * amount,
      vec3(0.0),
      vec3(0.995)
    );
  }

  float srgbToLinear(float value) {
    return value <= 0.04045
      ? value / 12.92
      : pow((value + 0.055) / 1.055, 2.4);
  }

  float linearToSrgb(float value) {
    return value <= 0.0031308
      ? value * 12.92
      : 1.055 * pow(max(value, 0.0), 1.0 / 2.4) - 0.055;
  }

  float labPivot(float value) {
    return value > 0.008856
      ? pow(value, 1.0 / 3.0)
      : 7.787 * value + 16.0 / 116.0;
  }

  float labInversePivot(float value) {
    float cube = value * value * value;
    return cube > 0.008856
      ? cube
      : (value - 16.0 / 116.0) / 7.787;
  }

  // Lab is kept in a shader-friendly range: L is 0..1 and a/b are roughly
  // -1..1. This lets lightness and colour be adjusted independently.
  vec3 rgbToLab(vec3 color) {
    vec3 linear = vec3(
      srgbToLinear(color.r),
      srgbToLinear(color.g),
      srgbToLinear(color.b)
    );
    float x = labPivot(dot(linear, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047);
    float y = labPivot(dot(linear, vec3(0.2126729, 0.7151522, 0.0721750)));
    float z = labPivot(dot(linear, vec3(0.0193339, 0.1191920, 0.9503041)) / 1.08883);
    return vec3(
      clamp((116.0 * y - 16.0) / 100.0, 0.0, 1.0),
      (500.0 * (x - y)) / 128.0,
      (200.0 * (y - z)) / 128.0
    );
  }

  vec3 labToRgb(vec3 lab) {
    float lightness = lab.x * 100.0;
    float fy = (lightness + 16.0) / 116.0;
    float fx = fy + (lab.y * 128.0) / 500.0;
    float fz = fy - (lab.z * 128.0) / 200.0;
    vec3 xyz = vec3(
      0.95047 * labInversePivot(fx),
      labInversePivot(fy),
      1.08883 * labInversePivot(fz)
    );
    vec3 linear = vec3(
      dot(xyz, vec3( 3.2404542, -1.5371385, -0.4985314)),
      dot(xyz, vec3(-0.9692660,  1.8760108,  0.0415560)),
      dot(xyz, vec3( 0.0556434, -0.2040259,  1.0572252))
    );
    return clamp(vec3(
      linearToSrgb(linear.r),
      linearToSrgb(linear.g),
      linearToSrgb(linear.b)
    ), vec3(0.0), vec3(1.0));
  }

  float labChroma(vec3 lab) {
    return length(lab.yz);
  }

  float paperCandidateScore(vec3 lab) {
    // Paper is generally the brightest, least chromatic member of a local
    // neighborhood. Penalising chroma prevents coloured handwriting from
    // becoming the local illumination reference.
    return lab.x - labChroma(lab) * 0.42;
  }

  vec3 sampleLab(vec2 uv) {
    return rgbToLab(texture2D(uTexture, clamp(uv, vec2(0.0), vec2(1.0))).rgb);
  }

  vec3 estimatePaperLabAtScale(vec2 centerUv, float pixelStep) {
    vec2 stepSize = uTexelSize * pixelStep;
    vec3 best = sampleLab(centerUv);
    float bestScore = paperCandidateScore(best);

    for (int i = 0; i < 4; i += 1) {
      vec2 direction = i == 0
        ? vec2(-stepSize.x, 0.0)
        : i == 1
          ? vec2(stepSize.x, 0.0)
          : i == 2
            ? vec2(0.0, -stepSize.y)
            : vec2(0.0, stepSize.y);
      vec3 candidate = sampleLab(centerUv + direction);
      float candidateScore = paperCandidateScore(candidate);
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }

    return best;
  }

  vec3 estimatePaperLab(vec2 centerUv) {
    vec3 fine = estimatePaperLabAtScale(centerUv, 16.0);
    vec3 medium = estimatePaperLabAtScale(centerUv, 64.0);
    vec3 broad = estimatePaperLabAtScale(centerUv, 192.0);
    return fine * 0.25 + medium * 0.35 + broad * 0.40;
  }

  vec3 estimateLocalPaperLab(vec2 centerUv) {
    // Keep the local reference close enough to follow a handwriting stroke;
    // the broad estimate above is used only for exposure and paper whitening.
    vec3 fine = estimatePaperLabAtScale(centerUv, 8.0);
    vec3 medium = estimatePaperLabAtScale(centerUv, 24.0);
    return fine * 0.55 + medium * 0.45;
  }

  float lightnessInkSignal(vec3 lab, vec3 paperLab) {
    float drop = paperLab.x - lab.x;
    float lowerBound = max(0.018, uThresholdBias * 0.20);
    return smoothstep(lowerBound, lowerBound + 0.16, drop);
  }

  float colourInkSignal(vec3 lab, vec3 paperLab) {
    float chromaDifference = length(lab.yz - paperLab.yz);
    return smoothstep(0.035, 0.18, chromaDifference);
  }

  // Retain a distinct red/warm-ink path. It catches red annotations even
  // when their lightness is close to the paper and gives that colour enough
  // weight to survive the whitening pass.
  float particularInkColourSignal(vec3 lab, vec3 paperLab) {
    vec2 delta = lab.yz - paperLab.yz;
    float redAxis = delta.x - abs(delta.y) * 0.25;
    return smoothstep(0.055, 0.20, redAxis);
  }

  float inkEvidence(vec3 lab, vec3 paperLab) {
    float darkInk = lightnessInkSignal(lab, paperLab);
    float colourInk = colourInkSignal(lab, paperLab);
    float particularColour = particularInkColourSignal(lab, paperLab);
    return max(darkInk, max(colourInk * 0.92, particularColour));
  }

  void main() {
    vec2 sourceUv = mapEnhancementUv(vOutputUv);
    vec3 centerColor = texture2D(uTexture, sourceUv).rgb;
    vec3 centerLab = rgbToLab(centerColor);
    vec3 exposurePaperLab = estimatePaperLab(sourceUv);
    vec3 paperLab = estimateLocalPaperLab(sourceUv);
    float centerEvidence = inkEvidence(centerLab, paperLab);

    // Use the estimated paper L value as the local exposure reference. A
    // shadowed sheet therefore maps to the same near-white paper level as a
    // well-lit sheet, while ink keeps its distance from that local reference.
    float paperLightness = max(exposurePaperLab.x, 0.45);
    float relativeLightness = centerLab.x / paperLightness;
    float correctedLightness = clamp(
      pow(max(relativeLightness, 0.0), 1.08) * 0.975,
      0.025,
      0.985
    );

    // Estimate connected support from actual Lab evidence. Strong colour
    // signals are allowed to survive with less support so small coloured
    // handwriting and punctuation are not mistaken for paper texture.
    float support = 0.0;
    vec2 supportOffset = uTexelSize * max(1.0, uSampleStep / 12.0);
    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        if (x != 0 || y != 0) {
          vec3 neighborLab = sampleLab(
            sourceUv + vec2(float(x), float(y)) * supportOffset
          );
          support += inkEvidence(neighborLab, paperLab);
        }
      }
    }

    float connected = smoothstep(0.45, 1.55, support);
    float colourSignal = colourInkSignal(centerLab, paperLab);
    float particularColour = particularInkColourSignal(centerLab, paperLab);
    float strongMark = max(
      smoothstep(0.12, 0.28, paperLab.x - centerLab.x),
      max(smoothstep(0.10, 0.27, colourSignal), particularColour)
    );
    float inkMask = max(strongMark, centerEvidence * connected);

    // Remove paper tint while retaining the Lab direction of handwriting.
    // Chroma is boosted only for detected ink; paper itself is brought close
    // to neutral white without a harsh RGB channel clamp.
    vec2 inkChroma = centerLab.yz - paperLab.yz;
    float chromaGain = 1.08 + 0.22 * particularColour;
    vec3 inkLab = vec3(
      correctedLightness,
      inkChroma.x * chromaGain,
      inkChroma.y * chromaGain
    );
    vec3 paperWhiteLab = vec3(
      0.975,
      0.0,
      0.0
    );
    vec3 outputColor = mix(
      labToRgb(paperWhiteLab),
      labToRgb(inkLab),
      clamp(inkMask, 0.0, 1.0)
    );

    // Preserve a little natural paper warmth and avoid over-saturating weak
    // coloured strokes, while still improving text contrast in Lab lightness.
    outputColor = mix(outputColor, increaseSaturation(outputColor, 1.04), colourSignal * 0.20);
    gl_FragColor = vec4(clamp(outputColor, vec3(0.0), vec3(0.995)), 1.0);
  }
`;

