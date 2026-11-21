import { createPaperAnalysisCache } from '../src/paper-analysis-cache.js';

export async function runPaperAnalysisCacheChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, run) => { await run(); passed.push(name); };
  const paper = (value = 1, width = 8, height = 8) => ({
    width, height, backgroundIsDark: value % 2 === 0,
    pixels: new Uint8Array(width * height * 4).fill(value),
  });
  const options = { schedule: () => 1, unschedule: () => {} };
  const storage = () => {
    const files = new Map();
    let reads = 0;
    return {
      files, get reads() { return reads; }, ensure: async () => {},
      async read(name) { reads += 1; if (!files.has(name)) throw new Error('missing'); return files.get(name).slice(); },
      async write(name, bytes) { files.set(name, bytes.slice()); },
      async remove(name) { files.delete(name); },
      async list() { return [...files.keys()]; },
    };
  };

  await check('200 analyses survive RAM eviction and a fresh cache instance', async () => {
    const disk = storage();
    const cache = createPaperAnalysisCache({ storage: disk, ...options });
    for (let index = 0; index < 200; index += 1) await cache.set('page-' + index, paper(index));
    assert(Array.from({ length: 200 }, (_, index) => cache.has('page-' + index)).filter(Boolean).length === 64,
      'RAM must stay at 64 entries');
    await cache.flush();
    const restarted = createPaperAnalysisCache({ storage: disk, ...options });
    for (let index = 0; index < 200; index += 1) {
      const result = await restarted.get('page-' + index);
      assert(result?.pixels[0] === index && result.backgroundIsDark === (index % 2 === 0),
        'an evicted page must reload its own unchanged analysis');
    }
    assert(disk.files.size === 201, 'all page maps plus the index are retained on disk');
    await restarted.flush();
  });

  await check('full-size analysis maps and Unicode source keys round-trip exactly', async () => {
    const disk = storage();
    const cache = createPaperAnalysisCache({ storage: disk, memoryLimit: 0, ...options });
    const original = paper(0, 256, 192);
    for (let index = 0; index < original.pixels.length; index += 1) original.pixels[index] = index % 251;
    await cache.set('file:///पन्ना-📄.jpg|1920x2560', original);
    const restored = await cache.get('file:///पन्ना-📄.jpg|1920x2560');
    assert(restored?.width === 256 && restored?.height === 192, 'map dimensions are retained');
    assert(restored.pixels.every((value, index) => value === original.pixels[index]), 'every map byte is retained');
    await cache.flush();
  });

  await check('concurrent requests share one disk read', async () => {
    const disk = storage();
    const cache = createPaperAnalysisCache({ storage: disk, memoryLimit: 0, ...options });
    await cache.set('same-page', paper());
    const before = disk.reads;
    const [first, second] = await Promise.all([cache.get('same-page'), cache.get('same-page')]);
    assert(first === second && disk.reads - before === 1, 'duplicate readers must join one load');
    await cache.flush();
  });

  await check('corrupt, truncated and mismatched maps are misses rather than wrong pages', async () => {
    const disk = storage();
    const cache = createPaperAnalysisCache({ storage: disk, memoryLimit: 0, ...options });
    await cache.set('a', paper(7));
    await cache.set('b', paper(9));
    const names = [...disk.files.keys()];
    const first = disk.files.get(names[0]).slice();
    const damaged = first.slice();
    damaged[damaged.length - 1] ^= 1;
    disk.files.set(names[0], damaged);
    assert(await cache.get('a') === null, 'the checksum rejects damaged map pixels');
    disk.files.set(names[0], first.subarray(0, first.length - 1));
    assert(await cache.get('a') === null, 'an incomplete map is never returned');
    disk.files.set(names[1], first);
    assert(await cache.get('b') === null, 'the original source key guards against collisions');
    await cache.set('a', paper(11));
    assert((await cache.get('a'))?.pixels[0] === 11, 'a later render can replace a damaged cache file');
    await cache.flush();
  });

  await check('disk failures preserve memory caching and never fail image processing', async () => {
    const disk = storage();
    disk.read = async () => { throw new Error('unavailable'); };
    disk.write = async () => { throw new Error('full'); };
    const cache = createPaperAnalysisCache({ storage: disk, ...options });
    const value = paper();
    assert(await cache.get('missing') === null, 'read failure is a miss');
    assert(await cache.set('page', value) === value, 'writing a cache must not fail a render');
    assert(await cache.get('page') === value, 'the result remains in the bounded memory cache');
    await cache.flush();
  });

  await check('disk cleanup uses an LRU byte budget', async () => {
    const disk = storage();
    let clock = 1;
    const seed = createPaperAnalysisCache({ storage: disk, memoryLimit: 0, now: () => ++clock, ...options });
    await seed.set('0', paper(1));
    const size = [...disk.files.values()][0].length;
    await seed.flush();
    const cache = createPaperAnalysisCache({
      storage: disk, memoryLimit: 0, diskLimit: size * 3 + 1, now: () => ++clock, ...options,
    });
    await cache.set('1', paper(1));
    await cache.set('2', paper(1));
    await cache.get('0');
    await cache.set('3', paper(1));
    await cache.flush();
    const bytes = [...disk.files].filter(([name]) => name.endsWith('.paper')).reduce((sum, [, value]) => sum + value.length, 0);
    assert(bytes <= size * 3 + 1, 'disk use stays within the byte budget');
    assert(await cache.get('1') === null, 'the least recently used map is evicted first');
    assert(await cache.get('0') && await cache.get('3'), 'recently used and newest maps survive');
    await cache.flush();
  });

  await check('expired files and abandoned temporary files are cleaned up', async () => {
    const disk = storage();
    let clock = 1;
    const cache = createPaperAnalysisCache({
      storage: disk, memoryLimit: 0, maxAge: 100, now: () => clock, ...options,
    });
    await cache.set('old', paper(1));
    disk.files.set('abandoned.tmp', new Uint8Array([1]));
    clock = 1000;
    await cache.set('new', paper(1));
    await cache.flush();
    assert(await cache.get('old') === null && await cache.get('new'), 'only expired entries are removed');
    assert(!disk.files.has('abandoned.tmp'), 'interrupted writes do not accumulate');
    await cache.flush();
  });

  await check('memory-only operation remains available when native storage is absent', async () => {
    const cache = createPaperAnalysisCache({ memoryLimit: 2, ...options });
    await cache.set('a', paper(1)); await cache.set('b', paper(2));
    await cache.get('a'); await cache.set('c', paper(3));
    assert(cache.has('a') && !cache.has('b') && cache.has('c'), 'the memory LRU still works');
    await cache.flush();
  });
  return passed;
}
