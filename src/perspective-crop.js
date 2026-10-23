const MAX_OUTPUT_EDGE = 2048;

export async function renderPerspectiveCropAsync({
  uri,
  corners,
  sourceWidth,
  sourceHeight,
}) {
  console.log('[perspective-crop] Starting crop', {
    uri,
    sourceWidth: sourceWidth ?? null,
    sourceHeight: sourceHeight ?? null,
    corners,
  });

  if (!uri) {
    throw new Error('A source image is required for perspective cropping.');
  }

  validateCorners(corners);

  const outputSize = getOutputSize(corners, sourceWidth, sourceHeight);
  console.log('[perspective-crop] Output size calculated', outputSize);

  const axisAlignedCrop = getAxisAlignedCrop(corners);
  const destinationToSource = axisAlignedCrop
    ? getAxisAlignedTransform(axisAlignedCrop)
    : solveHomography(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
      );
  console.log('[perspective-crop] Sampling transform type', axisAlignedCrop ? 'rectangle' : 'homography');
  console.log('[perspective-crop] Homography solved', destinationToSource);
  console.log('[perspective-crop] Homography corner mapping', {
    outputTopLeft: applyHomography(destinationToSource, { x: 0, y: 0 }),
    outputTopRight: applyHomography(destinationToSource, { x: 1, y: 0 }),
    outputBottomRight: applyHomography(destinationToSource, { x: 1, y: 1 }),
    outputBottomLeft: applyHomography(destinationToSource, { x: 0, y: 1 }),
  });

  const GLView = getGLView();
  console.log('[perspective-crop] Creating headless GL context');
  const gl = await GLView.createContextAsync();
  let sourceTexture;
  let outputTexture;
  let framebuffer;
  let program;
  let positionBuffer;

  try {
    program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    console.log('[perspective-crop] Shader program created');
    sourceTexture = createSourceTexture(gl, uri);
    console.log('[perspective-crop] Source texture created');
    outputTexture = createOutputTexture(gl, outputSize.width, outputSize.height);
    console.log('[perspective-crop] Output texture created');
    framebuffer = createFramebuffer(gl, outputTexture);
    console.log('[perspective-crop] Framebuffer created');

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
    console.log('[perspective-crop] Render completed');

    console.log('[perspective-crop] Taking framebuffer snapshot');
    const snapshot = await GLView.takeSnapshotAsync(gl, {
      framebuffer,
      format: 'jpeg',
      compress: 0.95,
      flip: false,
    });
    console.log('[perspective-crop] Snapshot created', {
      uri: snapshot?.localUri ?? snapshot?.uri ?? null,
      width: snapshot?.width ?? null,
      height: snapshot?.height ?? null,
    });

    const snapshotUri = snapshot?.localUri ?? snapshot?.uri;
    if (!snapshotUri || typeof snapshotUri !== 'string') {
      throw new Error('Perspective crop completed without producing an image file.');
    }

    return {
      uri: snapshotUri,
      width: outputSize.width,
      height: outputSize.height,
    };
  } finally {
    try {
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      if (sourceTexture) gl.deleteTexture(sourceTexture);
      if (program) gl.deleteProgram(program);
      await GLView.destroyContextAsync(gl);
      console.log('[perspective-crop] GL resources released');
    } catch (cleanupError) {
      console.warn('[perspective-crop] GL cleanup failed after render', cleanupError);
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
      'Perspective cropping requires a development build with expo-gl installed and rebuilt.'
    );
  }
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
  console.log('[perspective-crop] Homography uniforms applied', matrix);
}

function applyHomography(matrix, point) {
  const denominator = matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2];
  return {
    x: (matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2]) / denominator,
    y: (matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2]) / denominator,
  };
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
