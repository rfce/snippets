// Pure page analysis. Float64 work buffers preserve the original calculations;
// only allocation, sorting and image-independent geometry are optimized.
const BLACK_AND_WHITE_PAPER_GRID = 32;
const CARDINAL_NEIGHBORS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const geometryCache = new Map();

function createAxisLookup(length, gridLength) {
  const axis = {
    fraction: new Float64Array(length), lower: new Int16Array(length), upper: new Int16Array(length),
    neighbor: new Int16Array(length * 3), rawNeighbor: new Int16Array(length * 3),
    distance: new Float64Array(length * 3),
    before: new Uint16Array(length), after: new Uint16Array(length),
  };
  const clamp = (value) => Math.max(0, Math.min(gridLength - 1, value));
  for (let position = 0; position < length; position += 1) {
    const grid = (position + 0.5) * gridLength / length - 0.5;
    const base = Math.floor(grid);
    const center = Math.round(grid);
    axis.fraction[position] = grid - base;
    axis.lower[position] = clamp(base);
    axis.upper[position] = clamp(base + 1);
    axis.before[position] = Math.max(0, position - 1);
    axis.after[position] = Math.min(length - 1, position + 1);
    for (let offset = -1; offset <= 1; offset += 1) {
      const index = position * 3 + offset + 1;
      const neighbor = center + offset;
      axis.rawNeighbor[index] = neighbor;
      axis.neighbor[index] = clamp(neighbor);
      axis.distance[index] = (neighbor - grid) ** 2;
    }
  }
  return axis;
}

function getPaperGeometry(width, height, gridWidth, gridHeight) {
  const key = [width, height, gridWidth, gridHeight].join(':');
  let geometry = geometryCache.get(key);
  if (!geometry) geometry = {
    xAxis: createAxisLookup(width, gridWidth), yAxis: createAxisLookup(height, gridHeight),
  };
  geometryCache.delete(key);
  geometryCache.set(key, geometry);
  while (geometryCache.size > 4) geometryCache.delete(geometryCache.keys().next().value);
  return geometry;
}

export async function estimateBlackAndWhitePaperAsync(pixels, width, height, slice) {
  const luminances = new Float32Array(width * height);
  const neutralities = new Float32Array(width * height);
  const allValues = new Float64Array(width * height);
  const borderBuffer = new Float64Array(width * height);
  let borderCount = 0;
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
      allValues[y * width + x] = value;
      if (x < border || y < border || x >= width - border || y >= height - border) {
        borderBuffer[borderCount] = value;
        borderCount += 1;
      }
    }
    await slice();
  }

  // Typed arrays sort numerically in native code. This replaces a comparator
  // sort of ~65,000 values in JavaScript, the single largest cost here, and
  // returns exactly the same ordering.
  const borderValues = borderBuffer.subarray(0, borderCount);
  allValues.sort();
  borderValues.sort();
  await slice();
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
  const workspace = createPaperWorkspace(Math.ceil(width / gridWidth), Math.ceil(height / gridHeight));
  const paper = new Float32Array(count);
  const noise = new Float32Array(count);
  const neutrality = new Float32Array(count);
  const known = new Uint8Array(count);
  const shadowPaper = new Uint8Array(count);
  const paperCoverage = new Float32Array(count);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      let sampleCount = 0;
      const startX = Math.floor(gx * width / gridWidth);
      const endX = Math.floor((gx + 1) * width / gridWidth);
      const startY = Math.floor(gy * height / gridHeight);
      const endY = Math.floor((gy + 1) * height / gridHeight);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) workspace.samples[sampleCount++] = luminances[y * width + x];
      }
      let samples = workspace.samples.subarray(0, sampleCount);
      samples.sort();
      const plane = fitBlackAndWhitePaperPlane(luminances, width, startX, endX, startY, endY, workspace);
      if (plane) samples = plane.values;
      // An upper quantile rejects strokes without letting one specular pixel
      // set the background. The median of the paper cluster removes the
      // quantile's upward bias on textured paper and smooth lighting gradients.
      const upper = paperQuantile(samples, 0.80);
      let paperSampleCount = 0;
      for (let sample = 0; sample < samples.length; sample += 1) {
        if (Math.abs(samples[sample] - upper) <= 0.04) workspace.filtered[paperSampleCount++] = samples[sample];
      }
      const paperSamples = workspace.filtered.subarray(0, paperSampleCount);
      const level = paperQuantile(paperSamples, 0.50);
      const index = gy * gridWidth + gx;
      const deviations = workspace.deviations.subarray(0, paperSampleCount);
      for (let sample = 0; sample < paperSampleCount; sample += 1) {
        deviations[sample] = Math.abs(paperSamples[sample] - level);
      }
      deviations.sort();
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
      let inkCount = 0;
      for (let sample = 0; sample < samples.length; sample += 1) {
        if (samples[sample] < level - inkGap) inkCount += 1;
      }
      shadowPaper[index] = level >= Math.max(0.12, globalPaper * 0.18) &&
        neutrality[index] >= 0.60 && paperCoverage[index] >= 0.55 &&
        inkCount >= 1 && inkCount / samples.length <= 0.30 ? 1 : 0;
    }
    await slice();
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
    await slice();
    const admitted = [];
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = y * gridWidth + x;
        if (known[index] || paper[index] < 0.08) continue;
        for (const [dx, dy] of CARDINAL_NEIGHBORS) {
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
    await slice();
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
  const mapPixels = await expandBlackAndWhitePaperAsync(
    paper, noise, neutrality, luminances, gridWidth, gridHeight, width, height, slice
  );
  return { width, height, pixels: mapPixels, backgroundIsDark };
}

function createPaperWorkspace(width, height) {
  const count = width * height;
  const edge = Math.max(width, height);
  return {
    samples: new Float64Array(count), corrected: new Float64Array(count),
    filtered: new Float64Array(count), deviations: new Float64Array(count),
    row: new Float64Array(width), column: new Float64Array(height),
    rowLevels: new Float64Array(height), columnLevels: new Float64Array(width),
    slopes: new Float64Array(edge * (edge - 1) / 2),
  };
}

function fitBlackAndWhitePaperPlane(luminances, width, startX, endX, startY, endY, workspace) {
  const cellWidth = endX - startX;
  const cellHeight = endY - startY;
  const column = workspace.column.subarray(0, cellHeight);
  const row = workspace.row.subarray(0, cellWidth);
  for (let x = startX; x < endX; x += 1) {
    for (let y = startY; y < endY; y += 1) column[y - startY] = luminances[y * width + x];
    column.sort();
    workspace.columnLevels[x - startX] = paperQuantile(column, 0.80);
  }
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) row[x - startX] = luminances[y * width + x];
    row.sort();
    workspace.rowLevels[y - startY] = paperQuantile(row, 0.80);
  }
  const robustSlope = (levels) => {
    let count = 0;
    for (let first = 0; first < levels.length; first += 1) {
      for (let second = first + 1; second < levels.length; second += 1) {
        workspace.slopes[count++] = (levels[second] - levels[first]) / (second - first);
      }
    }
    return paperQuantile(workspace.slopes.subarray(0, count).sort(), 0.50);
  };
  const slopeX = robustSlope(workspace.columnLevels.subarray(0, cellWidth));
  const slopeY = robustSlope(workspace.rowLevels.subarray(0, cellHeight));
  const range = Math.abs(slopeX) * (endX - startX - 1) + Math.abs(slopeY) * (endY - startY - 1);
  if (range < 0.025 || range > 0.60) return null;

  // The quantiles, slope correction and acceptance tests are unchanged.
  const values = workspace.corrected.subarray(0, cellWidth * cellHeight);
  const centerX = (startX + endX - 1) * 0.5;
  const centerY = (startY + endY - 1) * 0.5;
  let count = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      values[count++] = luminances[y * width + x] - slopeX * (x - centerX) - slopeY * (y - centerY);
    }
  }
  values.sort();
  const upper = paperQuantile(values, 0.80);
  let paperCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (Math.abs(values[index] - upper) <= 0.025) workspace.filtered[paperCount++] = values[index];
  }
  const paperValues = workspace.filtered.subarray(0, paperCount);
  const level = paperQuantile(paperValues, 0.50);
  if (paperValues.length / values.length < 0.65 || level < 0.12 || level > 1.02) return null;
  return { values, slopeX, slopeY };
}

async function expandBlackAndWhitePaperAsync(
  paper, noise, neutrality, luminances, gridWidth, gridHeight, width, height, slice
) {
  const pixels = new Uint8Array(width * height * 4);
  const { xAxis, yAxis } = getPaperGeometry(width, height, gridWidth, gridHeight);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < height; y += 1) {
    const fy = yAxis.fraction[y];
    for (let x = 0; x < width; x += 1) {
      const fx = xAxis.fraction[x];
      let level = 0;
      let deviation = 0;
      let neutral = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const index = (dy ? yAxis.upper[y] : yAxis.lower[y]) * gridWidth +
            (dx ? xAxis.upper[x] : xAxis.lower[x]);
          const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          level += paper[index] * weight;
          deviation += noise[index] * weight;
          neutral += neutrality[index] * weight;
        }
      }
      let lowest = 1;
      let highest = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const index = yAxis.neighbor[y * 3 + dy + 1] * gridWidth + xAxis.neighbor[x * 3 + dx + 1];
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
            const nx = xAxis.rawNeighbor[x * 3 + dx + 1];
            const ny = yAxis.rawNeighbor[y * 3 + dy + 1];
            if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
            const index = ny * gridWidth + nx;
            const distance = xAxis.distance[x * 3 + dx + 1] + yAxis.distance[y * 3 + dy + 1];
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
            const firstX = dx ? xAxis.before[x] : x;
            const secondX = dx ? xAxis.after[x] : x;
            const firstY = dy === 1 ? yAxis.before[y] : dy === -1 ? yAxis.after[y] : y;
            const secondY = dy === 1 ? yAxis.after[y] : dy === -1 ? yAxis.before[y] : y;
            const first = luminances[firstY * width + firstX];
            const second = luminances[secondY * width + secondX];
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
    await slice();
  }
  return pixels;
}

function paperQuantile(sortedValues, fraction) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * fraction))] ?? 0;
}

