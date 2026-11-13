import * as LegacyFileSystem from 'expo-file-system/legacy';

let cachedFileSystem;
function getPdfFileSystem() {
  if (!cachedFileSystem) cachedFileSystem = require('expo-file-system');
  if (!cachedFileSystem.File || !cachedFileSystem.Paths?.cache) {
    throw new Error('The PDF file API is unavailable in this app build.');
  }
  return cachedFileSystem;
}

const A4_SHORT = 595.276;
const A4_LONG = 841.89;
const PAGE_MARGIN = 18;
const WRITE_CHUNK_SIZE = 1024 * 1024;
const MAX_TEXTURE_EDGE = 4096;

function checkCancelled(isCancelled) {
  if (isCancelled()) {
    const error = new Error('PDF export cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

function exifOrientation(bytes, start, end) {
  if (start + 14 > end || String.fromCharCode(...bytes.subarray(start, start + 6)) !== 'Exif\0\0') return null;
  const tiff = start + 6;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const directory = tiff + view.getUint32(tiff + 4, little);
  if (directory < tiff || directory + 2 > end) return 1;
  const count = view.getUint16(directory, little);
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112 &&
        view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

export function readJpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions = null;
  let orientation = 1;
  let adobe = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    const start = offset + 2;
    const end = offset + length;
    if (marker === 0xe1) orientation = exifOrientation(bytes, start, end) ?? orientation;
    if (marker === 0xee && end - start >= 5) {
      adobe = String.fromCharCode(...bytes.subarray(start, start + 5)) === 'Adobe';
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker) && end - start >= 6) {
      const height = (bytes[start + 1] << 8) | bytes[start + 2];
      const width = (bytes[start + 3] << 8) | bytes[start + 4];
      const components = bytes[start + 5];
      if (bytes[start] !== 8 || width < 1 || height < 1 || ![1, 3, 4].includes(components)) return null;
      dimensions = { width, height, components };
    }
    offset = end;
  }
  return dimensions ? { ...dimensions, orientation, adobe } : null;
}

export function getPdfImagePlacement(image) {
  const quarterTurn = image.orientation >= 5;
  const width = quarterTurn ? image.height : image.width;
  const height = quarterTurn ? image.width : image.height;
  const pageWidth = width > height ? A4_LONG : A4_SHORT;
  const pageHeight = width > height ? A4_SHORT : A4_LONG;
  const scale = Math.min((pageWidth - 2 * PAGE_MARGIN) / width, (pageHeight - 2 * PAGE_MARGIN) / height);
  const w = width * scale;
  const h = height * scale;
  const x = (pageWidth - w) / 2;
  const y = (pageHeight - h) / 2;
  const matrices = {
    1: [w, 0, 0, h, x, y],
    2: [-w, 0, 0, h, x + w, y],
    3: [-w, 0, 0, -h, x + w, y + h],
    4: [w, 0, 0, -h, x, y + h],
    5: [0, -h, -w, 0, x + w, y + h],
    6: [0, -h, w, 0, x, y + h],
    7: [0, h, w, 0, x, y],
    8: [0, h, -w, 0, x + w, y],
  };
  return { pageWidth, pageHeight, matrix: matrices[image.orientation] ?? matrices[1] };
}

// Stream one compressed image at a time instead of decoding the whole selection.
export async function writeImagePdfAsync({
  images, loadImage, write, onProgress = () => {}, isCancelled = () => false,
  yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0)),
}) {
  if (!images?.length) throw new Error('Select at least one image to create a PDF.');
  let position = 0;
  const offsets = [0];
  const emit = async (value) => {
    checkCancelled(isCancelled);
    const bytes = typeof value === 'string' ? asciiBytes(value) : value;
    for (let start = 0; start < bytes.length; start += WRITE_CHUNK_SIZE) {
      checkCancelled(isCancelled);
      const chunk = bytes.subarray(start, start + WRITE_CHUNK_SIZE);
      await write(chunk);
      position += chunk.length;
    }
  };
  const object = async (number, body) => {
    offsets[number] = position;
    await emit(number + ' 0 obj\n' + body + '\nendobj\n');
  };
  await emit('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  await object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = images.map((_, index) => (4 + index * 3) + ' 0 R').join(' ');
  await object(2, '<< /Type /Pages /Count ' + images.length + ' /Kids [' + kids + '] >>');
  await object(3, '<< /Title (Snippets) /Producer (Snippets) >>');

  for (let index = 0; index < images.length; index += 1) {
    let image;
    try {
      checkCancelled(isCancelled);
      image = await loadImage(images[index]);
      checkCancelled(isCancelled);
      if (!image?.bytes?.length || image.width < 1 || image.height < 1) throw new Error('The image data is unavailable.');
      const { pageWidth, pageHeight, matrix } = getPdfImagePlacement(image);
      const page = 4 + index * 3;
      const content = page + 1;
      const jpeg = page + 2;
      await object(page, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight +
        '] /Resources << /XObject << /Photo ' + jpeg + ' 0 R >> >> /Contents ' + content + ' 0 R >>');
      const commands = 'q\n' + matrix.map((number) => Number(number.toFixed(4))).join(' ') + ' cm\n/Photo Do\nQ\n';
      await object(content, '<< /Length ' + commands.length + ' >>\nstream\n' + commands + 'endstream');
      offsets[jpeg] = position;
      const colorSpace = image.components === 1 ? 'DeviceGray' : image.components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      const decode = image.components === 4 && image.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
      await emit(jpeg + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + image.width +
        ' /Height ' + image.height + ' /ColorSpace /' + colorSpace + ' /BitsPerComponent 8' + decode +
        ' /Filter /DCTDecode /Length ' + image.bytes.length + ' >>\nstream\n');
      await emit(image.bytes);
      await emit('\nendstream\nendobj\n');
      onProgress({ completed: index + 1, total: images.length });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Could not add image ' + (index + 1) + ' to the PDF: ' + error.message);
    } finally {
      await image?.dispose?.();
    }
    await yieldToUI();
  }
  checkCancelled(isCancelled);
  const xrefPosition = position;
  if (position > 9999999999) throw new Error('This PDF is too large to save as a single file.');
  await emit('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n');
  for (let index = 1; index < offsets.length; index += 1) {
    await emit(String(offsets[index]).padStart(10, '0') + ' 00000 n \n');
  }
  await emit('trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' +
    xrefPosition + '\n%%EOF\n');
  return images.length;
}

async function removeTemporary(uri) {
  if (!uri) return;
  try { await LegacyFileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes[0] !== 137 || String.fromCharCode(...bytes.subarray(1, 4)) !== 'PNG') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function readableUri(image) {
  if (/^(file|content):\/\//.test(image.uri ?? '')) return image.uri;
  try {
    const media = require('expo-media-library');
    const info = await new media.Asset(image.id).getInfo();
    const uri = info?.localUri ?? info?.uri;
    if (/^(file|content):\/\//.test(uri ?? '')) return uri;
  } catch {}
  throw new Error('This image is not available locally. Download it to the device and try again.');
}

async function loadPdfImage(image) {
  const { File, Paths } = getPdfFileSystem();
  const uri = await readableUri(image);
  let bytes = await new File(uri).bytes();
  const jpeg = readJpegInfo(bytes);
  if (jpeg) return { bytes, ...jpeg };
  const dimensions = pngDimensions(bytes) ?? { width: image.width, height: image.height };
  bytes = null;
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) ||
      dimensions.width <= 1 || dimensions.height <= 1) throw new Error('The image dimensions are unavailable.');
  let localCopy;
  let converted;
  try {
    let sourceUri = uri;
    if (!uri.startsWith('file://')) {
      localCopy = new File(Paths.cache, 'snippets-pdf-input-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png').uri;
      await LegacyFileSystem.copyAsync({ from: uri, to: localCopy });
      sourceUri = localCopy;
    }
    converted = await renderPdfJpegAsync(sourceUri, dimensions.width, dimensions.height);
    const jpegBytes = await new File(converted).bytes();
    const info = readJpegInfo(jpegBytes);
    if (!info) throw new Error('Converting this image to PDF failed.');
    const ownedUri = converted;
    return { bytes: jpegBytes, ...info, dispose: () => removeTemporary(ownedUri) };
  } catch (error) {
    await removeTemporary(converted);
    throw error;
  } finally {
    await removeTemporary(localCopy);
  }
}

export async function createSnippetsPdfAsync(images, options = {}) {
  const { File, Paths } = getPdfFileSystem();
  if (!images?.length) throw new Error('Select at least one image to create a PDF.');
  const file = new File(Paths.cache, 'Snippets-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.pdf');
  let handle;
  try {
    checkCancelled(options.isCancelled ?? (() => false));
    await file.create({ overwrite: false, intermediates: true });
    handle = file.open();
    const write = async (bytes) => {
      if (typeof handle.writeBytes === 'function') await handle.writeBytes(bytes);
      else handle.writeBytesSync(bytes);
    };
    await writeImagePdfAsync({ ...options, images, loadImage: loadPdfImage, write });
    handle.close();
    handle = null;
    return { uri: file.uri, pageCount: images.length, remove: () => file.delete() };
  } catch (error) {
    try { handle?.close(); } catch {}
    handle = null;
    try { await file.delete(); } catch {}
    throw error;
  }
}

async function renderPdfJpegAsync(uri, sourceWidth, sourceHeight) {
  const { GLView } = require('expo-gl');
  const gl = await GLView.createContextAsync();
  const scale = Math.min(1, MAX_TEXTURE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  let program, source, output, framebuffer, buffer;
  const shaders = [];
  try {
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'PDF image shader failed.');
      return shader;
    };
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 aPosition; varying vec2 vUv; void main(){gl_Position=vec4(aPosition,0.0,1.0);vUv=vec2((aPosition.x+1.0)*0.5,(1.0-aPosition.y)*0.5);}'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, 'precision mediump float; uniform sampler2D uTexture; varying vec2 vUv; void main(){vec4 c=texture2D(uTexture,vUv);gl_FragColor=vec4(mix(vec3(1.0),c.rgb,c.a),1.0);}'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'PDF image shader could not link.');
    const texture = () => {
      const result = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, result);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return result;
    };
    source = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, { localUri: uri });
    output = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The PDF image buffer is unavailable.');
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    if (gl.getError() !== gl.NO_ERROR) throw new Error('The image could not be prepared for PDF export.');
    const snapshot = await GLView.takeSnapshotAsync(gl, {
      format: 'jpeg', compress: 0.98, flip: false, framebuffer, rect: { x: 0, y: 0, width, height },
    });
    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;
    if (!snapshotUri) throw new Error('PDF image preparation returned no file.');
    return snapshotUri;
  } finally {
    try {
      if (buffer) gl.deleteBuffer(buffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (output) gl.deleteTexture(output);
      if (source) gl.deleteTexture(source);
      shaders.forEach((shader) => gl.deleteShader(shader));
      if (program) gl.deleteProgram(program);
    } catch {}
    try { await GLView.destroyContextAsync(gl); } catch {}
  }
}
