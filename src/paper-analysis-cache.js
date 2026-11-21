const CACHE_VERSION = 1;
const INDEX_NAME = 'index.json';
const ENTRY_NAME = /^[0-9a-f]{16}\.paper$/;
const MAX_ANALYSIS_EDGE = 256;

function asciiBytes(text) {
  const value = text.replace(/[^\x00-\x7f]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  return bytes;
}

function asciiText(bytes) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return chunks.join('');
}

function bytesHash(bytes) {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) hash = Math.imul(hash ^ bytes[index], 16777619);
  return hash >>> 0;
}

function entryName(key) {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < key.length; index += 1) {
    const value = key.charCodeAt(index);
    first = Math.imul(first ^ value, 16777619);
    second = Math.imul(second, 33) ^ value;
  }
  return (first >>> 0).toString(16).padStart(8, '0') +
    (second >>> 0).toString(16).padStart(8, '0') + '.paper';
}

function encodePaper(key, paper) {
  const header = asciiBytes(JSON.stringify({
    version: CACHE_VERSION, key, width: paper.width, height: paper.height,
    backgroundIsDark: paper.backgroundIsDark, checksum: bytesHash(paper.pixels),
  }));
  const bytes = new Uint8Array(4 + header.length + paper.pixels.length);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  bytes.set(paper.pixels, 4 + header.length);
  return bytes;
}

function decodePaper(key, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (length > 65536 || length + 4 > bytes.length) return null;
  const header = JSON.parse(asciiText(bytes.subarray(4, 4 + length)));
  const { width, height } = header;
  if (header.version !== CACHE_VERSION || header.key !== key ||
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > MAX_ANALYSIS_EDGE || height > MAX_ANALYSIS_EDGE ||
    typeof header.backgroundIsDark !== 'boolean' || bytes.length !== 4 + length + width * height * 4) return null;
  const pixels = bytes.subarray(4 + length);
  if (bytesHash(pixels) !== header.checksum) return null;
  return { width, height, backgroundIsDark: header.backgroundIsDark, pixels: pixels.slice() };
}

/**
 * Only the most recently used maps stay in RAM. Disk maps contain the original
 * source key and a checksum, so a collision, incomplete write or damaged cache
 * is a miss, never the analysis of a different page.
 */
export function createPaperAnalysisCache({
  storage = null, memoryLimit = 64, diskLimit = 256 * 1024 * 1024, maxPendingWrites = 4,
  maxAge = 3 * 24 * 60 * 60 * 1000, now = Date.now,
  schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  const memory = new Map();
  const reads = new Map();
  const writes = new Map();
  const index = new Map();
  const capacityWaiters = new Set();
  const writeLimit = Math.max(1, maxPendingWrites);
  let loaded = null;
  let mutations = Promise.resolve();
  let timer = null;
  let flushing = null;
  let scanOrphans = true;
  let revision = 0;

  const whenWritable = async () => {
    while (writes.size >= writeLimit) {
      await new Promise((resolve) => capacityWaiters.add(resolve));
    }
  };
  const notifyCapacity = () => {
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  };
  const mutate = (task) => {
    const job = mutations.then(task);
    mutations = job.catch(() => {});
    return job;
  };
  const remember = (key, paper) => {
    memory.delete(key);
    memory.set(key, paper);
    while (memory.size > memoryLimit) memory.delete(memory.keys().next().value);
    return paper;
  };
  const load = () => {
    if (!storage) return Promise.resolve(false);
    if (!loaded) loaded = (async () => {
      await storage.ensure();
      try {
        const saved = JSON.parse(asciiText(await storage.read(INDEX_NAME)));
        if (saved.version === CACHE_VERSION) {
          for (const [name, value] of Object.entries(saved.entries ?? {})) {
            if (ENTRY_NAME.test(name) && Number.isFinite(value.bytes) && value.bytes > 0 &&
              Number.isFinite(value.used)) index.set(name, value);
          }
        }
      } catch {
        // A missing or damaged index cannot make a render fail.
      }
      return true;
    })().catch(() => false);
    return loaded;
  };
  const scheduleFlush = () => {
    if (!storage || timer !== null) return;
    timer = schedule(() => { timer = null; void flush(); }, 500);
  };
  const touch = (name, bytes) => {
    index.set(name, { bytes, used: now() });
    revision += 1;
    scheduleFlush();
  };
  const remove = async (name, expected) => mutate(async () => {
    if (expected && index.get(name) !== expected) return;
    try { await storage.remove(name); } catch {}
    if (!expected || index.get(name) === expected) index.delete(name);
  });

  // Maintenance runs outside the render's write. Individual mutations are
  // serialized, but new map writes can run between old-file removals.
  const flush = () => {
    if (timer !== null) { unschedule(timer); timer = null; }
    if (flushing) return flushing;
    const job = (async () => {
      await Promise.allSettled([...writes.values()]);
      if (!await load()) return;
      if (scanOrphans && storage.list) {
        scanOrphans = false;
        try {
          for (const name of await storage.list()) {
            if ((ENTRY_NAME.test(name) && !index.has(name)) || name.endsWith('.tmp')) {
              await mutate(async () => {
                if (ENTRY_NAME.test(name) && index.has(name)) return;
                try { await storage.remove(name); } catch {}
              });
            }
          }
        } catch {}
      }
      let total = [...index.values()].reduce((sum, value) => sum + value.bytes, 0);
      const cutoff = now() - maxAge;
      for (const [name, value] of [...index].sort((a, b) => a[1].used - b[1].used)) {
        if (value.used >= cutoff && total <= diskLimit) break;
        await remove(name, value);
        if (!index.has(name)) total -= value.bytes;
      }
      const writtenRevision = revision;
      await mutate(() => storage.write(INDEX_NAME, asciiBytes(JSON.stringify({
        version: CACHE_VERSION, entries: Object.fromEntries(index),
      }))));
      return writtenRevision;
    })().catch(() => undefined).then((writtenRevision) => {
      if (flushing === job) flushing = null;
      if (writtenRevision !== undefined && revision !== writtenRevision) scheduleFlush();
    });
    flushing = job;
    return job;
  };

  return {
    has: (key) => memory.has(key),
    async get(key) {
      const cached = memory.get(key);
      if (cached) {
        remember(key, cached);
        const saved = index.get(entryName(key));
        if (saved) touch(entryName(key), saved.bytes);
        return cached;
      }
      if (reads.has(key)) return reads.get(key);
      const job = (async () => {
        if (writes.has(key)) await writes.get(key);
        if (!await load()) return null;
        const name = entryName(key);
        try {
          const bytes = await storage.read(name);
          const paper = decodePaper(key, bytes);
          if (!paper) return null;
          touch(name, bytes.length);
          return remember(key, paper);
        } catch {
          return null;
        }
      })().finally(() => { if (reads.get(key) === job) reads.delete(key); });
      reads.set(key, job);
      return job;
    },
    async set(key, paper) {
      // Publish before any persistence. The analysis producer observes capacity
      // before starting another workspace, so disk backlog stays bounded.
      remember(key, paper);
      if (!storage) return paper;
      await whenWritable();
      const previous = writes.get(key);
      const job = (async () => {
        // Let the map reach its waiting preview before encoding or disk I/O.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (previous) await previous;
        if (!await load()) return;
        const bytes = encodePaper(key, paper);
        if (bytes.length > diskLimit) return;
        await mutate(async () => {
          await storage.write(entryName(key), bytes);
          touch(entryName(key), bytes.length);
        });
      })().catch(() => {}).finally(() => {
        if (writes.get(key) === job) writes.delete(key);
        notifyCapacity();
      });
      writes.set(key, job);
      // Persistence is owned by the cache; the visible GPU pass can start now.
      return paper;
    },
    whenWritable,
    flush,
  };
}

function createNativeStorage() {
  try {
    const { Directory, File, Paths } = require('expo-file-system');
    const directory = new Directory(Paths.cache, 'snippets-paper-analysis-v1');
    return {
      ensure: async () => directory.create({ idempotent: true, intermediates: true }),
      read: (name) => new File(directory, name).bytes(),
      async write(name, bytes) {
        const temporary = new File(directory, name + '.tmp');
        temporary.create({ overwrite: true, intermediates: true });
        try {
          await temporary.write(bytes);
          const destination = new File(directory, name);
          try { await destination.delete(); } catch {}
          await temporary.move(destination);
        } catch (error) {
          try { await new File(directory, name + '.tmp').delete(); } catch {}
          throw error;
        }
      },
      remove: (name) => new File(directory, name).delete(),
      list: async () => (await directory.list()).map((file) => file.name),
    };
  } catch {
    return null;
  }
}

let sharedCache = null;
export function getSharedPaperAnalysisCache() {
  if (!sharedCache) sharedCache = createPaperAnalysisCache({ storage: createNativeStorage() });
  return sharedCache;
}
