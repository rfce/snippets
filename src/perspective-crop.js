import * as FileSystem from 'expo-file-system/legacy';

// Keep the processed document close to the camera's native resolution while
// using JPEG snapshots to avoid the large files and decode cost of PNG.
const MAX_OUTPUT_EDGE = 4096;
const SNAPSHOT_OPTIONS = {
  format: 'jpeg',
  compress: 0.92,
  flip: false,
};

export async function renderPerspectiveCropAsync({
  uri,
  corners,
  sourceWidth,
  sourceHeight,
  rotation = 0,
}) {
  if (!uri) {
    throw new Error('A source image is required for perspective cropping.');
  }

  validateCorners(corners);

  const normalizedRotation = normalizeRotation(rotation);
  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const displayedWidth = normalizedRotation % 180 === 0 ? width : height;
  const displayedHeight = normalizedRotation % 180 === 0 ? height : width;
  const sourceCorners = mapCornersToSource(corners, normalizedRotation);
  const outputSize = getOutputSize(corners, displayedWidth, displayedHeight);
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
  const GLView = getGLView();
  const gl = await GLView.createContextAsync();
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
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
      ...SNAPSHOT_OPTIONS,
      framebuffer,
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
      if (program) gl.deleteProgram(program);
      await GLView.destroyContextAsync(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] GL cleanup failed after render', cleanupError);
    }
  }
}

export async function renderAdaptiveThresholdAsync({
  uri,
  sourceWidth,
  sourceHeight,
}) {
  if (!uri) {
    throw new Error('A source image is required for black-and-white enhancement.');
  }

  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const outputSize = getScaledOutputSize(width, height);
  const GLView = getGLView();
  const gl = await GLView.createContextAsync();
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = createProgram(gl, VERTEX_SHADER, ADAPTIVE_THRESHOLD_FRAGMENT_SHADER);
    sourceTexture = createSourceTexture(gl, uri);
    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    gl.useProgram(program);
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
    const biasLocation = gl.getUniformLocation(program, 'uThresholdBias');

    if (texelSizeLocation === null || sampleStepLocation === null || biasLocation === null) {
      throw new Error('The adaptive-threshold shader uniforms are unavailable.');
    }

    gl.uniform2f(texelSizeLocation, 1 / width, 1 / height);
    // Use a wider local background estimate and require a clearer contrast
    // before classifying a pixel as ink. This suppresses tiny paper speckles
    // without changing the adaptive-threshold flow.
    gl.uniform1f(sampleStepLocation, 12);
    gl.uniform1f(biasLocation, 0.12);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering the adaptive threshold');

    const snapshot = await GLView.takeSnapshotAsync(gl, {
      ...SNAPSHOT_OPTIONS,
      framebuffer,
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
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      if (program) gl.deleteProgram(program);
      await GLView.destroyContextAsync(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Adaptive threshold cleanup failed', cleanupError);
    }
  }
}

export async function renderMagicColorAsync({
  uri,
  sourceWidth,
  sourceHeight,
}) {
  if (!uri) {
    throw new Error('A source image is required for magic-color enhancement.');
  }

  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const outputSize = getScaledOutputSize(width, height);
  const GLView = getGLView();
  const gl = await GLView.createContextAsync();
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = createProgram(gl, VERTEX_SHADER, MAGIC_COLOR_FRAGMENT_SHADER);
    sourceTexture = createSourceTexture(gl, uri);
    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    framebuffer = createFramebuffer(gl, outputTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, outputSize.width, outputSize.height);
    gl.useProgram(program);
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

    gl.uniform2f(texelSizeLocation, 1 / width, 1 / height);
    gl.uniform1f(sampleStepLocation, 12);
    gl.uniform1f(thresholdBiasLocation, 0.12);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish?.();
    gl.flush();
    gl.flushEXP?.();
    checkGlError(gl, 'rendering magic color');

    const snapshot = await GLView.takeSnapshotAsync(gl, {
      ...SNAPSHOT_OPTIONS,
      framebuffer,
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
      if (program) gl.deleteProgram(program);
      await GLView.destroyContextAsync(gl);
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

function getAxisAlignedTransform(crop) {
  return [
    [crop.right - crop.left, 0, crop.left],
    [0, crop.bottom - crop.top, crop.top],
    [0, 0, 1],
  ];
}

function getScaledOutputSize(width, height) {
  const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function getOutputSize(corners, sourceWidth, sourceHeight) {
  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  const top = distanceInPixels(corners.topLeft, corners.topRight, width, height);
  const bottom = distanceInPixels(corners.bottomLeft, corners.bottomRight, width, height);
  const left = distanceInPixels(corners.topLeft, corners.bottomLeft, width, height);
  const right = distanceInPixels(corners.topRight, corners.bottomRight, width, height);
  const rawWidth = Math.max(1, Math.round((top + bottom) / 2));
  const rawHeight = Math.max(1, Math.round((left + right) / 2));
  const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(rawWidth, rawHeight));

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
  precision mediump float;

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

const ADAPTIVE_THRESHOLD_FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D uTexture;
  uniform vec2 uTexelSize;
  uniform float uSampleStep;
  uniform float uThresholdBias;
  varying vec2 vOutputUv;

  float channelMaximum(vec3 color) {
    return max(color.r, max(color.g, color.b));
  }

  float channelMinimum(vec3 color) {
    return min(color.r, min(color.g, color.b));
  }

  float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
  }

  float hsvSaturation(vec3 color) {
    float value = channelMaximum(color);
    return (value <= 0.001) ? 0.0 : (value - channelMinimum(color)) / value;
  }

  float paperConfidence(vec3 color) {
    // Colored surroundings should not be promoted to document ink merely
    // because they have saturation. Bright, neutral pixels are more likely to
    // be the paper surrounding a colored pen stroke.
    float brightPaper = smoothstep(0.48, 0.86, luminance(color));
    float neutralPaper = 1.0 - smoothstep(0.06, 0.24, hsvSaturation(color));
    return brightPaper * neutralPaper;
  }

  float estimateLocalPaperConfidence(vec2 centerUv) {
    vec2 sampleStep = uTexelSize * 48.0;
    float confidenceSum = 0.0;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        confidenceSum += paperConfidence(texture2D(
            uTexture,
            clamp(centerUv + vec2(float(x), float(y)) * sampleStep, vec2(0.0), vec2(1.0))
          ).rgb);
      }
    }

    // A single white pixel beside a colorful object must not enable the color
    // rescue for the whole neighborhood. Require broad local evidence of
    // paper before chroma can influence the document mask.
    return smoothstep(0.36, 0.78, confidenceSum / 9.0);
  }

  float chromaticInkStrength(vec3 color, float localPaperConfidence) {
    // Saturated colored ink can be bright in luminance space. Use HSV-style
    // chroma and saturation as a secondary ink signal so red, blue, green,
    // yellow, and other colored strokes are not judged by their darkest RGB
    // channel alone.
    float value = channelMaximum(color);
    float chroma = value - channelMinimum(color);
    float saturation = hsvSaturation(color);
    float chromaSignal = smoothstep(0.06, 0.32, chroma);
    float saturationSignal = smoothstep(0.12, 0.55, saturation);
    float visibleColorSignal = smoothstep(0.18, 0.92, value);

    return chromaSignal * saturationSignal * visibleColorSignal * localPaperConfidence;
  }

  float inkIntensity(vec3 color, float localPaperConfidence) {
    // Luminance handles black, gray, and naturally dark ink. The chroma
    // signal lowers the effective intensity of bright colored ink without
    // treating lightly tinted paper as strongly as a raw min(R, G, B) test.
    float luminanceIntensity = luminance(color);
    float chromaticStrength = chromaticInkStrength(color, localPaperConfidence);
    float chromaticIntensity = 1.0 - chromaticStrength * 0.86;

    return min(luminanceIntensity, chromaticIntensity);
  }

  float paperBrightness(vec3 color) {
    return luminance(color);
  }

  float samplePaperBrightness(vec2 uv) {
    vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
    return paperBrightness(texture2D(uTexture, clampedUv).rgb);
  }

  float estimateIlluminationAtScale(vec2 centerUv, float pixelStep) {
    // Use the brightest point in a small cross. Dark text and narrow shadows
    // should not lower the paper estimate, while the cross keeps the sample
    // count lower than a full neighborhood kernel.
    vec2 illuminationStep = uTexelSize * pixelStep;
    float illumination = samplePaperBrightness(centerUv);

    illumination = max(
      illumination,
      samplePaperBrightness(centerUv + vec2(-illuminationStep.x, 0.0))
    );
    illumination = max(
      illumination,
      samplePaperBrightness(centerUv + vec2(illuminationStep.x, 0.0))
    );
    illumination = max(
      illumination,
      samplePaperBrightness(centerUv + vec2(0.0, -illuminationStep.y))
    );
    illumination = max(
      illumination,
      samplePaperBrightness(centerUv + vec2(0.0, illuminationStep.y))
    );

    return illumination;
  }

  float estimateLocalIllumination(vec2 centerUv) {
    // Combine local, page-region, and broad estimates. The fine scale reacts
    // to nearby shadow edges, the medium scale handles ordinary uneven light,
    // and the broad scale recovers the paper level when an entire local area
    // is covered by a shadow. Blending avoids the discontinuities caused by a
    // single fixed-size background window.
    float fineIllumination = estimateIlluminationAtScale(centerUv, 12.0);
    float mediumIllumination = estimateIlluminationAtScale(centerUv, 48.0);
    float broadIllumination = estimateIlluminationAtScale(centerUv, 144.0);
    float illumination =
      fineIllumination * 0.25 +
      mediumIllumination * 0.35 +
      broadIllumination * 0.40;

    return max(illumination, 0.5);
  }

  vec3 correctForIllumination(vec3 color, float illumination, float enabled) {
    float scale = min(1.45, 1.0 / max(illumination, 0.5));
    scale = mix(1.0, scale, enabled);
    return min(color * scale, vec3(1.0));
  }

  float sampleInkIntensity(
    vec2 uv,
    float illumination,
    float enabled,
    float localPaperConfidence
  ) {
    vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
    vec3 color = texture2D(uTexture, clampedUv).rgb;
    return inkIntensity(
      correctForIllumination(color, illumination, enabled),
      localPaperConfidence
    );
  }

  float blurredIntensity(
    vec2 centerUv,
    float illumination,
    float enabled,
    float localPaperConfidence
  ) {
    vec2 blurStep = uTexelSize;
    float center = sampleInkIntensity(
      centerUv,
      illumination,
      enabled,
      localPaperConfidence
    );
    float sum = center * 4.0;
    sum += sampleInkIntensity(
      centerUv + vec2(-blurStep.x, 0.0),
      illumination,
      enabled,
      localPaperConfidence
    );
    sum += sampleInkIntensity(
      centerUv + vec2(blurStep.x, 0.0),
      illumination,
      enabled,
      localPaperConfidence
    );
    sum += sampleInkIntensity(
      centerUv + vec2(0.0, -blurStep.y),
      illumination,
      enabled,
      localPaperConfidence
    );
    sum += sampleInkIntensity(
      centerUv + vec2(0.0, blurStep.y),
      illumination,
      enabled,
      localPaperConfidence
    );
    return sum / 8.0;
  }

  float estimateGlobalBackgroundBrightness() {
    float brightnessSum = 0.0;
    float confidenceSum = 0.0;
    float fallbackSum = 0.0;

    for (int x = 0; x < 3; x += 1) {
      for (int y = 0; y < 3; y += 1) {
        vec2 sampleUv = vec2(
          (float(x) + 0.5) / 3.0,
          (float(y) + 0.5) / 3.0
        );
        vec3 sampleColor = texture2D(uTexture, sampleUv).rgb;
        float brightness = paperBrightness(sampleColor);
        float confidence = paperConfidence(sampleColor);
        brightnessSum += brightness * confidence;
        confidenceSum += confidence;
        fallbackSum += brightness;
      }
    }

    // Surrounding wood, fabric, and dark objects must not make a mostly white
    // page look like a dark-background document. Use only samples that look
    // like paper for polarity; retain the unweighted average as a fallback
    // when no paper evidence is available.
    return confidenceSum > 0.35
      ? brightnessSum / confidenceSum
      : fallbackSum / 9.0;
  }

  float estimateDarkBackgroundConfidence(float backgroundBrightness) {
    // Treat polarity as a probability instead of making the page switch
    // abruptly at one brightness value. The midpoint remains 0.45, while the
    // transition band gives gray or unevenly lit pages a lower-confidence
    // result rather than forcing the wrong polarity.
    return 1.0 - smoothstep(0.28, 0.62, backgroundBrightness);
  }

  float softInkConfidence(
    float value,
    float darkThreshold,
    float lightThreshold,
    float backgroundIsDark
  ) {
    // Keep the transition narrow. This preserves the crisp binary body of a
    // stroke while giving anti-aliased edge pixels proportional coverage.
    float softness = max(0.018, uThresholdBias * 0.28);
    float darkConfidence = 1.0 - smoothstep(
      darkThreshold - softness,
      darkThreshold + softness,
      value
    );
    float lightConfidence = smoothstep(
      lightThreshold - softness,
      lightThreshold + softness,
      value
    );

    return mix(darkConfidence, lightConfidence, backgroundIsDark);
  }

  void main() {
    vec3 centerColor = texture2D(uTexture, vOutputUv).rgb;
    // Determine polarity from the paper/background brightness, not the
    // color-sensitive ink intensity. A saturated colored stroke must not make
    // a mostly white page switch into inverted mode. Keep the result
    // continuous so ambiguous backgrounds do not hard-switch polarity.
    float backgroundIsDark = estimateDarkBackgroundConfidence(
      estimateGlobalBackgroundBrightness()
    );
    float illuminationCorrectionEnabled = 1.0 - backgroundIsDark;
    float localIllumination = estimateLocalIllumination(vOutputUv);
    float localPaperConfidence = estimateLocalPaperConfidence(vOutputUv);
    vec3 correctedCenterColor = correctForIllumination(
      centerColor,
      localIllumination,
      illuminationCorrectionEnabled
    );
    float originalCenter = inkIntensity(correctedCenterColor, localPaperConfidence);
    float blurredCenter = blurredIntensity(
      vOutputUv,
      localIllumination,
      illuminationCorrectionEnabled,
      localPaperConfidence
    );
    // Very conservative unsharp masking: restore only a small amount of local
    // contrast so text edges stay clear without creating dark halos.
    float center = clamp(
      originalCenter + 0.12 * (originalCenter - blurredCenter),
      0.0,
      1.0
    );
    float localSum = 0.0;
    vec2 sampleOffset = uTexelSize * uSampleStep;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        vec2 sampleUv = clamp(
          vOutputUv + vec2(float(x), float(y)) * sampleOffset,
          vec2(0.0),
          vec2(1.0)
        );
        localSum += sampleInkIntensity(
          sampleUv,
          localIllumination,
          illuminationCorrectionEnabled,
          localPaperConfidence
        );
      }
    }

    float localMean = localSum / 9.0;
    float darkInkThreshold = localMean - uThresholdBias;
    float lightInkThreshold = localMean + uThresholdBias;
    float softCenterInk = softInkConfidence(
      center,
      darkInkThreshold,
      lightInkThreshold,
      backgroundIsDark
    );
    float darkCenterIsInk = 1.0 - step(darkInkThreshold, center);
    float lightCenterIsInk = step(lightInkThreshold, center);
    float centerIsInk = mix(darkCenterIsInk, lightCenterIsInk, backgroundIsDark);

    // Build a small, weighted morphology neighborhood. Axial neighbors carry
    // full weight, while diagonal neighbors carry less weight so a single
    // diagonal contact can preserve a thin stroke without making diagonal
    // scene noise look like connected text.
    float axialInkSupport = 0.0;
    float diagonalInkSupport = 0.0;
    float softInkSupport = 0.0;
    vec2 supportStep = uTexelSize;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        if (x != 0 || y != 0) {
          vec2 sampleUv = clamp(
            vOutputUv + vec2(float(x), float(y)) * supportStep,
            vec2(0.0),
            vec2(1.0)
          );
          vec3 neighborColor = texture2D(uTexture, sampleUv).rgb;
          vec3 correctedNeighborColor = correctForIllumination(
            neighborColor,
            localIllumination,
            illuminationCorrectionEnabled
          );
          float neighbor = inkIntensity(correctedNeighborColor, localPaperConfidence);
          float darkNeighborIsInk = 1.0 - step(darkInkThreshold, neighbor);
          float lightNeighborIsInk = step(lightInkThreshold, neighbor);
          float neighborIsInk =
            mix(darkNeighborIsInk, lightNeighborIsInk, backgroundIsDark);

          if (x == 0 || y == 0) {
            axialInkSupport += neighborIsInk;
          } else {
            diagonalInkSupport += neighborIsInk;
          }

          softInkSupport += softInkConfidence(
            neighbor,
            darkInkThreshold,
            lightInkThreshold,
            backgroundIsDark
          ) *
          ((x == 0 || y == 0) ? 1.0 : 0.55);
        }
      }
    }

    // Preserve strongly contrasted text pixels even when anti-aliasing makes
    // their immediate neighbors light. The soft support path keeps a thin
    // anti-aliased stroke alive when its neighbors are close to, but not yet
    // across, the hard threshold.
    float strongDarkInk = 1.0 - step(darkInkThreshold - 0.04, center);
    float strongLightInk = step(lightInkThreshold + 0.04, center);
    float strongInk = mix(strongDarkInk, strongLightInk, backgroundIsDark);

    float weightedHardSupport = axialInkSupport + diagonalInkSupport * 0.55;
    float connectedStroke = max(
      step(0.75, weightedHardSupport),
      step(0.95, softInkSupport)
    );

    // A two-sided opening/closing rule: remove weak isolated specks, while
    // filling small holes that sit between two or more real stroke pixels.
    // Strong isolated marks are intentionally retained for punctuation and
    // very small handwritten details.
    float weakIsolatedInk = centerIsInk * (1.0 - strongInk) * connectedStroke;
    float regularGapFill =
      (1.0 - centerIsInk) *
      step(2.25, weightedHardSupport);
    float structuralInkMask = max(
      strongInk,
      max(weakIsolatedInk, regularGapFill)
    );
    // Keep morphology responsible for rejecting isolated scene noise, then
    // use the soft confidence only where at least one neighboring pixel is
    // already recognized as ink. This restores connected anti-aliased pen
    // edges without turning nearby colorful objects into broad gray strokes.
    float supportedSoftInk = softCenterInk * connectedStroke;
    float inkMask = max(structuralInkMask, supportedSoftInk);
    float inkColor = 0.3019608; // #4d4d4d
    gl_FragColor = vec4(mix(vec3(1.0), vec3(inkColor), inkMask), 1.0);
  }
`;

const MAGIC_COLOR_FRAGMENT_SHADER = `
  precision mediump float;

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

  void main() {
    vec3 originalCenterColor = texture2D(uTexture, vOutputUv).rgb;
    float backgroundIsDark = 1.0 - step(
      0.45,
      estimateGlobalBackgroundBrightness()
    );
    float illuminationCorrectionEnabled = 1.0 - backgroundIsDark;
    float localIllumination = estimateLocalIllumination(vOutputUv);
    vec3 correctedCenterColor = sampleCorrectedColor(
      vOutputUv,
      localIllumination,
      illuminationCorrectionEnabled
    );
    float center = inkIntensity(correctedCenterColor);
    float localSum = 0.0;
    vec2 sampleOffset = uTexelSize * uSampleStep;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        vec2 sampleUv = clamp(
          vOutputUv + vec2(float(x), float(y)) * sampleOffset,
          vec2(0.0),
          vec2(1.0)
        );
        localSum += sampleInkIntensity(
          sampleUv,
          localIllumination,
          illuminationCorrectionEnabled
        );
      }
    }

    float localMean = localSum / 9.0;
    float centerInk = inkStrength(center, localMean, backgroundIsDark);
    float strongInk = smoothstep(0.04, 0.14, mix(
      (localMean - uThresholdBias) - center,
      center - (localMean + uThresholdBias),
      backgroundIsDark
    ));

    // Build a connected-stroke support mask exactly like the black-and-white
    // path, but keep the original color for pixels that survive the mask.
    float inkNeighborCount = 0.0;
    float redInkNeighborCount = 0.0;
    vec3 neighborInkColor = vec3(0.0);
    float neighborInkWeight = 0.0;
    vec2 supportStep = uTexelSize;

    for (int x = -1; x <= 1; x += 1) {
      for (int y = -1; y <= 1; y += 1) {
        vec2 sampleUv = clamp(
          vOutputUv + vec2(float(x), float(y)) * supportStep,
          vec2(0.0),
          vec2(1.0)
        );
        vec3 neighborColor = sampleCorrectedColor(
          sampleUv,
          localIllumination,
          illuminationCorrectionEnabled
        );
        float neighborIntensity = inkIntensity(neighborColor);
        float neighborStrength = inkStrength(
          neighborIntensity,
          localMean,
          backgroundIsDark
        );
        inkNeighborCount += neighborStrength;
        redInkNeighborCount += neighborStrength * smoothstep(
          0.025,
          0.14,
          redInkDominance(neighborColor)
        );
        neighborInkColor += neighborColor * neighborStrength;
        neighborInkWeight += neighborStrength;
      }
    }

    float supportedInk = centerInk * smoothstep(1.5, 2.8, inkNeighborCount);
    float regularGapFill = (1.0 - centerInk) *
      smoothstep(2.5, 4.5, inkNeighborCount);
    float redCenterSignal = smoothstep(
      0.025,
      0.14,
      redInkDominance(originalCenterColor)
    );
    float redGapFill = (1.0 - centerInk) *
      smoothstep(2.0, 4.0, redInkNeighborCount) *
      (1.0 - redCenterSignal);
    float inkMask = max(
      strongInk,
      max(supportedInk, max(regularGapFill, redGapFill))
    );

    vec3 estimatedInkColor = neighborInkColor / max(neighborInkWeight, 0.001);
    vec3 inkColor = mix(
      correctedCenterColor,
      estimatedInkColor,
      max(regularGapFill, redGapFill)
    );
    inkColor = increaseSaturation(inkColor, 1.10);

    float redInkSignal = smoothstep(
      0.025,
      0.14,
      redInkDominance(inkColor)
    );
    vec3 brighterRed = clamp(
      vec3(
        inkColor.r * 1.14 + 0.02,
        inkColor.g * 0.84,
        inkColor.b * 0.84
      ),
      vec3(0.0),
      vec3(0.995)
    );
    inkColor = mix(inkColor, brighterRed, 0.75 * redInkSignal);

    // The matte is intentionally white everywhere outside connected ink.
    // This is the key difference from a color filter: paper, shadows, wood,
    // and other background pixels never pass through to the output image.
    gl_FragColor = vec4(
      mix(vec3(1.0), clamp(inkColor, vec3(0.0), vec3(0.995)), inkMask),
      1.0
    );
  }
`;
