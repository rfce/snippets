import { estimateBlackAndWhitePaperAsync } from '../src/paper-analysis.js';

function fixture(width, height, pattern) {
  const pixels = new Uint8Array(width * height * 4);
  let state = 123456789 + pattern;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = ((state >>> 24) % 11) - 5;
      const stroke = (x % 17 < 2 && y % 13 < 8) || (y % 29 === 8 && x % 31 < 23);
      let level = 232;
      let red, green, blue;
      if (pattern === 0) level = stroke ? 65 : 244 + noise;
      if (pattern === 1) level = (stroke ? 175 : 230) - x / Math.max(1, width - 1) * 110 + noise;
      if (pattern === 2) level = (stroke ? 120 : 238) * (x < width / 2 ? 0.35 : 1) + noise;
      if (pattern === 3) level = (x > width / 5 && x < width * 0.8 && y > height / 5 && y < height * 0.8) ? 12 : 240;
      if (pattern === 4) level = stroke ? 220 : 23 + noise;
      if (pattern === 5) level = stroke ? 215 : 234 + noise;
      red = green = blue = Math.max(0, Math.min(255, Math.round(level)));
      if (pattern === 5 && x % 47 < 3) { red = 225; green = 70; blue = 70; }
      if (pattern === 5 && y % 43 < 3) { red = 70; green = 110; blue = 225; }
      const offset = (y * width + x) * 4;
      pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue; pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
function hashPixels(pixels) {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 1) hash = Math.imul(hash ^ pixels[index], 16777619);
  return hash >>> 0;
}

const GOLDENS = [{"width":256,"height":192,"pattern":0,"dark":false,"hash":912758709},{"width":256,"height":192,"pattern":1,"dark":false,"hash":3759163989},{"width":256,"height":192,"pattern":2,"dark":false,"hash":3988457088},{"width":256,"height":192,"pattern":3,"dark":false,"hash":4062453189},{"width":256,"height":192,"pattern":4,"dark":true,"hash":3947212472},{"width":256,"height":192,"pattern":5,"dark":false,"hash":2624483684},{"width":192,"height":256,"pattern":0,"dark":false,"hash":2875475352},{"width":192,"height":256,"pattern":1,"dark":false,"hash":1759087018},{"width":192,"height":256,"pattern":2,"dark":false,"hash":1784985210},{"width":192,"height":256,"pattern":3,"dark":false,"hash":4062453189},{"width":192,"height":256,"pattern":4,"dark":true,"hash":2770780076},{"width":192,"height":256,"pattern":5,"dark":false,"hash":1654281740},{"width":256,"height":256,"pattern":0,"dark":false,"hash":894286498},{"width":256,"height":256,"pattern":1,"dark":false,"hash":1499961162},{"width":256,"height":256,"pattern":2,"dark":false,"hash":1035113005},{"width":256,"height":256,"pattern":3,"dark":false,"hash":1831247301},{"width":256,"height":256,"pattern":4,"dark":true,"hash":343340382},{"width":256,"height":256,"pattern":5,"dark":false,"hash":1118368877},{"width":249,"height":137,"pattern":0,"dark":false,"hash":4243188988},{"width":249,"height":137,"pattern":1,"dark":false,"hash":2877083666},{"width":249,"height":137,"pattern":2,"dark":false,"hash":705015642},{"width":249,"height":137,"pattern":3,"dark":false,"hash":3573441711},{"width":249,"height":137,"pattern":4,"dark":true,"hash":1935141853},{"width":249,"height":137,"pattern":5,"dark":false,"hash":4034250651},{"width":256,"height":16,"pattern":0,"dark":false,"hash":4057210228},{"width":256,"height":16,"pattern":1,"dark":false,"hash":2957241476},{"width":256,"height":16,"pattern":2,"dark":false,"hash":3500240189},{"width":256,"height":16,"pattern":3,"dark":false,"hash":803028421},{"width":256,"height":16,"pattern":4,"dark":true,"hash":2738410635},{"width":256,"height":16,"pattern":5,"dark":false,"hash":4233721026},{"width":1,"height":256,"pattern":0,"dark":true,"hash":346234309},{"width":1,"height":256,"pattern":1,"dark":false,"hash":344240627},{"width":1,"height":256,"pattern":2,"dark":true,"hash":1608870138},{"width":1,"height":256,"pattern":3,"dark":false,"hash":3352864709},{"width":1,"height":256,"pattern":4,"dark":false,"hash":2933254085},{"width":1,"height":256,"pattern":5,"dark":false,"hash":2898038213},{"width":256,"height":1,"pattern":0,"dark":false,"hash":4214759439},{"width":256,"height":1,"pattern":1,"dark":false,"hash":654463999},{"width":256,"height":1,"pattern":2,"dark":false,"hash":3760709337},{"width":256,"height":1,"pattern":3,"dark":false,"hash":3352864709},{"width":256,"height":1,"pattern":4,"dark":true,"hash":3135920150},{"width":256,"height":1,"pattern":5,"dark":false,"hash":1728118725},{"width":17,"height":19,"pattern":0,"dark":false,"hash":2577170128},{"width":17,"height":19,"pattern":1,"dark":false,"hash":3259357630},{"width":17,"height":19,"pattern":2,"dark":false,"hash":2003994242},{"width":17,"height":19,"pattern":3,"dark":false,"hash":924412315},{"width":17,"height":19,"pattern":4,"dark":true,"hash":1418586992},{"width":17,"height":19,"pattern":5,"dark":false,"hash":1021870898}];

export async function runPaperAnalysisChecks() {
  const passed = [];
  for (const { width, height, pattern, dark, hash } of GOLDENS) {
    const result = await estimateBlackAndWhitePaperAsync(fixture(width, height, pattern), width, height, async () => {});
    if (result.width !== width || result.height !== height || result.backgroundIsDark !== dark ||
      hashPixels(result.pixels) !== hash) throw new Error('Analysis changed: ' + [width, height, pattern].join(':'));
    passed.push([width, height, pattern].join(':'));
  }
  return passed;
}
