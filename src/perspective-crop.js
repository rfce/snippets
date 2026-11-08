import * as FileSystem from 'expo-file-system/legacy';

// Keep the processed document close to the camera's native resolution while
// using JPEG snapshots to avoid the large files and decode cost of PNG.
const MAX_OUTPUT_EDGE = 4096;
const BLACK_AND_WHITE_ANALYSIS_EDGE = 256;
const BLACK_AND_WHITE_PAPER_GRID = 32;
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

  const width = sourceWidth;
  const height = sourceHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Valid image dimensions are required for black-and-white enhancement.');
  }
  const outputSize = getScaledOutputSize(width, height);
  const analysisScale = Math.min(1, BLACK_AND_WHITE_ANALYSIS_EDGE / Math.max(width, height));
  const analysisWidth = Math.max(1, Math.round(width * analysisScale));
  const analysisHeight = Math.max(1, Math.round(height * analysisScale));
  const GLView = getGLView();
  const gl = await GLView.createContextAsync();
  let sourceTexture;
  let paperTexture;
  let outputTexture;
  let framebuffer;
  let analysisProgram;
  let program;
  let positionBuffer;

  try {
    sourceTexture = createSourceTexture(gl, uri);
    outputTexture = createOutputTexture(gl, analysisWidth, analysisHeight);
    framebuffer = createFramebuffer(gl, outputTexture);
    analysisProgram = createProgram(gl, VERTEX_SHADER, BLACK_AND_WHITE_ANALYSIS_FRAGMENT_SHADER);

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
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(analysisProgram, 'uTexture'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read only a small analysis image. Paper estimation and interpolation
    // happen once per image, rather than independently inside every ink pixel.
    const analysisPixels = new Uint8Array(analysisWidth * analysisHeight * 4);
    gl.readPixels(0, 0, analysisWidth, analysisHeight, gl.RGBA, gl.UNSIGNED_BYTE, analysisPixels);
    checkGlError(gl, 'analysing the document background');
    const paper = estimateBlackAndWhitePaper(analysisPixels, analysisWidth, analysisHeight);

    paperTexture = createOutputTexture(gl, paper.width, paper.height);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, paper.width, paper.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, paper.pixels
    );
    gl.bindTexture(gl.TEXTURE_2D, outputTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, outputSize.width, outputSize.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    checkGlError(gl, 'preparing the document paper map');

    program = createProgram(gl, VERTEX_SHADER, ADAPTIVE_THRESHOLD_FRAGMENT_SHADER);
    gl.useProgram(program);
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
      if (program) gl.deleteProgram(program);
      if (analysisProgram) gl.deleteProgram(analysisProgram);
      await GLView.destroyContextAsync(gl);
    } catch (cleanupError) {
      console.warn('[perspective-crop] Adaptive threshold cleanup failed', cleanupError);
    }
  }
}

function estimateBlackAndWhitePaper(pixels, width, height) {
  const luminances = new Float32Array(width * height);
  const neutralities = new Float32Array(width * height);
  const allValues = [];
  const borderValues = [];
  const border = Math.max(1, Math.round(Math.min(width, height) * 0.04));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // readPixels is bottom-up; localUri textures and the paper map use
      // top-to-bottom image coordinates throughout the crop/enhancement flow.
      const offset = ((height - 1 - y) * width + x) * 4;
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      const value = red * 0.299 + green * 0.587 + blue * 0.114;
      const maximum = Math.max(red, green, blue);
      const saturation = (maximum - Math.min(red, green, blue)) / Math.max(maximum, 0.001);
      luminances[y * width + x] = value;
      neutralities[y * width + x] = Math.max(0, 1 - saturation / 0.30);
      allValues.push(value);
      if (x < border || y < border || x >= width - border || y >= height - border) {
        borderValues.push(value);
      }
    }
  }

  allValues.sort((a, b) => a - b);
  borderValues.sort((a, b) => a - b);
  // Use both the page border and its bulk. A large black foreground shape on
  // light paper must not flip polarity merely because it occupies most pixels.
  const backgroundIsDark = paperQuantile(borderValues, 0.60) < 0.35 &&
    paperQuantile(allValues, 0.60) < 0.40;
  if (backgroundIsDark) {
    for (let index = 0; index < luminances.length; index += 1) {
      luminances[index] = 1 - luminances[index];
    }
    for (const values of [allValues, borderValues]) {
      for (let index = 0; index < values.length; index += 1) values[index] = 1 - values[index];
      values.reverse();
    }
  }
  const globalPaper = Math.max(0.08, paperQuantile(allValues, 0.85), paperQuantile(borderValues, 0.60));
  // Every cell needs a neighborhood, even for very wide/tall gallery images.
  // A one-analysis-pixel cell could otherwise mistake a sampled faint stroke
  // for an entire strip of paper.
  const gridWidth = Math.min(BLACK_AND_WHITE_PAPER_GRID, Math.ceil(width / 8));
  const gridHeight = Math.min(BLACK_AND_WHITE_PAPER_GRID, Math.ceil(height / 8));
  const count = gridWidth * gridHeight;
  const paper = new Float32Array(count);
  const noise = new Float32Array(count);
  const neutrality = new Float32Array(count);
  const known = new Uint8Array(count);
  const shadowPaper = new Uint8Array(count);
  const paperCoverage = new Float32Array(count);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      let samples = [];
      const startX = Math.floor(gx * width / gridWidth);
      const endX = Math.floor((gx + 1) * width / gridWidth);
      const startY = Math.floor(gy * height / gridHeight);
      const endY = Math.floor((gy + 1) * height / gridHeight);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) samples.push(luminances[y * width + x]);
      }
      samples.sort((a, b) => a - b);
      const plane = fitBlackAndWhitePaperPlane(luminances, width, startX, endX, startY, endY);
      if (plane) samples = plane.values;
      // An upper quantile rejects strokes without letting one specular pixel
      // set the background. The median of the paper cluster removes the
      // quantile's upward bias on textured paper and smooth lighting gradients.
      const upper = paperQuantile(samples, 0.80);
      const paperSamples = samples.filter((value) => Math.abs(value - upper) <= 0.04);
      const level = paperQuantile(paperSamples, 0.50);
      const index = gy * gridWidth + gx;
      const deviations = paperSamples.map((value) => Math.abs(value - level)).sort((a, b) => a - b);
      paper[index] = Math.max(0, Math.min(1, level));
      noise[index] = Math.min(0.08, Math.max(0.002, paperQuantile(deviations, 0.50) * 1.4826));
      let neutralSum = 0;
      let paperCount = 0;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const sampleIndex = y * width + x;
          const corrected = luminances[sampleIndex] -
            (plane?.slopeX ?? 0) * (x - (startX + endX - 1) * 0.5) -
            (plane?.slopeY ?? 0) * (y - (startY + endY - 1) * 0.5);
          if (Math.abs(corrected - level) <= 0.04) {
            neutralSum += neutralities[sampleIndex];
            paperCount += 1;
          }
        }
      }
      neutrality[index] = paperCount ? neutralSum / paperCount : 0;
      paperCoverage[index] = paperCount / samples.length;
      known[index] = plane || level >= Math.max(0.08, globalPaper * 0.88) ? 1 : 0;
      // A stable midtone with a minority of darker strokes is paper carrying
      // text, even when a cast shadow separates it from the lit page. A uniform
      // filled mark has no darker-stroke evidence and cannot seed this path.
      const inkGap = Math.max(0.006, noise[index] * 3.5, level * 0.02);
      const inkCount = samples.filter((value) => value < level - inkGap).length;
      shadowPaper[index] = level >= Math.max(0.12, globalPaper * 0.18) &&
        neutrality[index] >= 0.60 && paperCoverage[index] >= 0.55 &&
        inkCount >= 1 && inkCount / samples.length <= 0.30 ? 1 : 0;
    }
  }

  // Confirm that shadow candidates belong to a broad, consistent surface.
  // Neutral plateaus continuing to the page edge also provide a reference for
  // blank shadowed margins. Near-black fills remain excluded from both paths.
  const shadowSeeds = [];
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const index = y * gridWidth + x;
      if (known[index]) continue;
      const atEdge = x === 0 || y === 0 || x === gridWidth - 1 || y === gridHeight - 1;
      const edgePaper = atEdge && paperCoverage[index] >= 0.80 &&
        neutrality[index] >= 0.65 && paper[index] >= Math.max(0.18, globalPaper * 0.25);
      if (!shadowPaper[index] && !edgePaper) continue;
      let surfaceSupport = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const neighbor = ny * gridWidth + nx;
          const tolerance = 0.04 + Math.min(0.025, noise[index] + noise[neighbor]);
          if (neutrality[neighbor] >= 0.60 && Math.abs(paper[index] - paper[neighbor]) <= tolerance) {
            surfaceSupport += 1;
          }
        }
      }
      if (surfaceSupport >= 3) shadowSeeds.push(index);
    }
  }
  for (const index of shadowSeeds) known[index] = 1;

  // Admit darker paper only along a gradual lighting transition from trusted
  // paper. A dark/gray solid separated by an ink edge cannot seed its own
  // background, while a smooth shadow can extend well below the global level.
  for (let pass = 0; pass < Math.max(gridWidth, gridHeight); pass += 1) {
    const admitted = [];
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = y * gridWidth + x;
        if (known[index] || paper[index] < 0.08) continue;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const neighbor = ny * gridWidth + nx;
          const tolerance = 0.035 + Math.min(0.025, noise[index] + noise[neighbor]);
          if (known[neighbor] && Math.abs(paper[index] - paper[neighbor]) <= tolerance) {
            admitted.push(index);
            break;
          }
        }
      }
    }
    if (!admitted.length) break;
    for (const index of admitted) known[index] = 1;
  }

  // Inpaint only cells without plausible paper. Filled ink regions inherit
  // their surrounding paper instead of treating their own black interior as
  // the background. Seed cells retain local shadow/illumination information.
  for (let pass = 0; pass < Math.max(gridWidth, gridHeight); pass += 1) {
    const filled = [];
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = y * gridWidth + x;
        if (known[index]) continue;
        let weightSum = 0;
        let paperSum = 0;
        let noiseSum = 0;
        let neutralSum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
            const neighbor = ny * gridWidth + nx;
            if (!known[neighbor]) continue;
            const weight = dx === 0 || dy === 0 ? 1 : 0.7071;
            paperSum += paper[neighbor] * weight;
            noiseSum += noise[neighbor] * weight;
            neutralSum += neutrality[neighbor] * weight;
            weightSum += weight;
          }
        }
        if (weightSum) filled.push([index, paperSum / weightSum, noiseSum / weightSum, neutralSum / weightSum]);
      }
    }
    if (!filled.length) break;
    for (const [index, level, deviation, neutral] of filled) {
      paper[index] = level;
      noise[index] = deviation;
      neutrality[index] = neutral;
      known[index] = 1;
    }
  }

  // Resolve fallbacks before expanding the map so an unknown region cannot
  // bleed a zero paper/noise reference into its neighbors.
  for (let index = 0; index < count; index += 1) {
    if (!known[index]) {
      paper[index] = globalPaper;
      noise[index] = 0.002;
      neutrality[index] = 0;
    }
  }
  const mapPixels = expandBlackAndWhitePaper(
    paper, noise, neutrality, luminances, gridWidth, gridHeight, width, height
  );
  return { width, height, pixels: mapPixels, backgroundIsDark };
}

function fitBlackAndWhitePaperPlane(luminances, width, startX, endX, startY, endY) {
  const rows = Array.from({ length: endY - startY }, () => []);
  const columns = Array.from({ length: endX - startX }, () => []);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const value = luminances[y * width + x];
      rows[y - startY].push(value);
      columns[x - startX].push(value);
    }
  }
  const paperLevels = (groups) => groups.map((values) =>
    paperQuantile(values.sort((a, b) => a - b), 0.80)
  );
  const robustSlope = (levels) => {
    const slopes = [];
    for (let first = 0; first < levels.length; first += 1) {
      for (let second = first + 1; second < levels.length; second += 1) {
        slopes.push((levels[second] - levels[first]) / (second - first));
      }
    }
    return paperQuantile(slopes.sort((a, b) => a - b), 0.50);
  };
  const slopeX = robustSlope(paperLevels(columns));
  const slopeY = robustSlope(paperLevels(rows));
  const range = Math.abs(slopeX) * (endX - startX - 1) + Math.abs(slopeY) * (endY - startY - 1);
  if (range < 0.025 || range > 0.60) return null;

  // Estimate noise after removing the lighting slope. A steep penumbra must
  // not look like noisy paper or lose its darker half during quantile sampling.
  // Median pairwise slopes tolerate rows/columns containing text.
  const values = [];
  const centerX = (startX + endX - 1) * 0.5;
  const centerY = (startY + endY - 1) * 0.5;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      values.push(luminances[y * width + x] - slopeX * (x - centerX) - slopeY * (y - centerY));
    }
  }
  values.sort((a, b) => a - b);
  const upper = paperQuantile(values, 0.80);
  const paperValues = values.filter((value) => Math.abs(value - upper) <= 0.025);
  const level = paperQuantile(paperValues, 0.50);
  if (paperValues.length / values.length < 0.65 || level < 0.12 || level > 1.02) return null;
  return { values, slopeX, slopeY };
}

function expandBlackAndWhitePaper(paper, noise, neutrality, luminances, gridWidth, gridHeight, width, height) {
  const pixels = new Uint8Array(width * height * 4);
  const clampX = (x) => Math.max(0, Math.min(gridWidth - 1, x));
  const clampY = (y) => Math.max(0, Math.min(gridHeight - 1, y));
  const sourceAt = (x, y) => luminances[
    Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))
  ];
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < height; y += 1) {
    const gy = (y + 0.5) * gridHeight / height - 0.5;
    const iy = Math.floor(gy);
    const fy = gy - iy;
    for (let x = 0; x < width; x += 1) {
      const gx = (x + 0.5) * gridWidth / width - 0.5;
      const ix = Math.floor(gx);
      const fx = gx - ix;
      let level = 0;
      let deviation = 0;
      let neutral = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const index = clampY(iy + dy) * gridWidth + clampX(ix + dx);
          const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          level += paper[index] * weight;
          deviation += noise[index] * weight;
          neutral += neutrality[index] * weight;
        }
      }
      const centerX = Math.round(gx);
      const centerY = Math.round(gy);
      let lowest = 1;
      let highest = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const index = clampY(centerY + dy) * gridWidth + clampX(centerX + dx);
          lowest = Math.min(lowest, paper[index]);
          highest = Math.max(highest, paper[index]);
        }
      }
      if (highest - lowest > 0.025) {
        // At a cast-shadow edge, ordinary interpolation mixes lit paper into
        // dark paper, creating a false gray band. Guide the interpolation by
        // the observed brightness; keep ordinary interpolation for gradients.
        let weightSum = 0;
        let paperSum = 0;
        let noiseSum = 0;
        let neutralSum = 0;
        const intensity = luminances[y * width + x];
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = centerX + dx;
            const ny = centerY + dy;
            if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
            const index = ny * gridWidth + nx;
            const distance = (nx - gx) ** 2 + (ny - gy) ** 2;
            const difference = Math.abs(paper[index] - intensity) / Math.max(0.018, noise[index] * 4);
            const weight = 1 / ((1 + distance * 4) * (1 + difference ** 4));
            paperSum += paper[index] * weight;
            noiseSum += noise[index] * weight;
            neutralSum += neutrality[index] * weight;
            weightSum += weight;
          }
        }
        if (weightSum) {
          level = paperSum / weightSum;
          deviation = noiseSum / weightSum;
          neutral = neutralSum / weightSum;
        }
        // A penumbra can change faster than the coarse grid. Opposite paper
        // samples recover that local lighting slope while cancelling its
        // gradient. Reject one-sided bright jumps at a hard shadow boundary;
        // allow two bright sides to recover the paper across a narrow stroke.
        if (intensity > lowest * 0.80 && intensity <= highest + 0.02) {
          let localPaper = level;
          // Keep a model that already matches the local paper. At a shadow
          // boundary, prefer the darker valid paper pair over one mixing in
          // the lit side; an inflated reference would promote show-through.
          let lightingError = Math.abs(level - intensity);
          let strokePaper = Infinity;
          let hasLocalPaper = false;
          let hasStrokePaper = false;
          // This tests for paper on both sides of a stroke, not final ink.
          // Analysis downsampling can halve a thin pencil stroke's contrast;
          // the final shader still applies the stricter paper-noise threshold.
          const contrastGap = Math.max(0.003, deviation * 1.5, intensity * 0.008);
          for (const [dx, dy] of directions) {
            const first = sourceAt(x - dx, y - dy);
            const second = sourceAt(x + dx, y + dy);
            const mean = (first + second) * 0.5;
            const difference = mean - intensity;
            const followsLighting = difference >= -0.01 &&
              difference <= Math.max(0.04, intensity * 0.12);
            const spansStroke = Math.min(first, second) > intensity + contrastGap;
            const spansSlopedStroke = Math.min(first, second) < intensity - contrastGap &&
              difference > contrastGap && difference <= Math.max(0.06, intensity * 0.12);
            if (spansStroke || spansSlopedStroke) {
              strokePaper = Math.min(strokePaper, mean);
              hasStrokePaper = true;
            }
            if (followsLighting && Math.abs(difference) < lightingError) {
              localPaper = mean;
              lightingError = Math.abs(difference);
              hasLocalPaper = true;
            }
          }
          if (hasStrokePaper) level = Math.max(lowest, Math.min(highest, strokePaper));
          else if (hasLocalPaper) level = Math.max(lowest, Math.min(highest, localPaper));
        }
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(level * 255);
      // Encode small paper-noise values with enough precision in RGBA8.
      pixels[offset + 1] = Math.round(Math.min(1, deviation * 8) * 255);
      pixels[offset + 2] = Math.round(neutral * 255);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function paperQuantile(sortedValues, fraction) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * fraction))] ?? 0;
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
    gl.uniform1f(thresholdBiasLocation, 0.09);

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

const BLACK_AND_WHITE_ANALYSIS_FRAGMENT_SHADER = `
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vOutputUv;

  void main() {
    gl_FragColor = texture2D(uTexture, vOutputUv);
  }
`;

const ADAPTIVE_THRESHOLD_FRAGMENT_SHADER = `
  precision highp float;

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

  void main() {
    float observed = luminance(texture2D(uTexture, vOutputUv).rgb);
    observed = mix(observed, 1.0 - observed, uBackgroundIsDark);
    vec3 background = paperReference(vOutputUv, observed);
    float paper = max(background.r, 0.08);
    float relativeNoise = background.g * 0.125 / paper;

    // Faint show-through must not become foreground merely because it forms
    // connected letters. Require a clearly darker stroke relative to the
    // corrected paper; keep a lower threshold only for its anti-aliased edge.
    float edgeThreshold = clamp(0.065 + 1.5 * relativeNoise, 0.080, 0.24);
    float foregroundThreshold = clamp(0.16 + 3.0 * relativeNoise, 0.180, 0.42);
    float center = inkEvidence(vOutputUv, paper, background.b);
    vec2 stepSize = uTexelSize;

    float north = neighboringInkEvidence(vOutputUv + vec2(0.0, -stepSize.y), background);
    float south = neighboringInkEvidence(vOutputUv + vec2(0.0, stepSize.y), background);
    float west = neighboringInkEvidence(vOutputUv + vec2(-stepSize.x, 0.0), background);
    float east = neighboringInkEvidence(vOutputUv + vec2(stepSize.x, 0.0), background);
    float northWest = neighboringInkEvidence(vOutputUv - stepSize, background);
    float southEast = neighboringInkEvidence(vOutputUv + stepSize, background);
    float northEast = neighboringInkEvidence(vOutputUv + vec2(stepSize.x, -stepSize.y), background);
    float southWest = neighboringInkEvidence(vOutputUv + vec2(-stepSize.x, stepSize.y), background);

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
    float inkColor = 0.3019608; // Preserve the existing #4d4d4d export style.
    gl_FragColor = vec4(vec3(mix(1.0, inkColor, inkMask)), 1.0);
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
    vec3 centerColor = texture2D(uTexture, vOutputUv).rgb;
    vec3 centerLab = rgbToLab(centerColor);
    vec3 exposurePaperLab = estimatePaperLab(vOutputUv);
    vec3 paperLab = estimateLocalPaperLab(vOutputUv);
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
            vOutputUv + vec2(float(x), float(y)) * supportOffset
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
