import {
  createBatchCaptureSizeController, selectBatchCaptureSize, selectSingleCaptureSize,
} from '../src/camera-capture.js';

export async function runCameraCaptureChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, run) => { await run(); passed.push(name); };
  const catalog = ['4032x3024', '3264x2448', '2560x1920', '2048x1536', '1920x1440', '1280x960'];

  await check('batch requests the largest supported 4:3 size within the target', () => {
    assert(selectBatchCaptureSize(catalog) === '2560x1920', 'select ~5 MP rather than full sensor resolution');
    assert(2560 * 1920 < 4032 * 3024 / 2, 'less than half the pixels of this default 12 MP image');
  });
  await check('selection is independent of catalog order and orientation', () => {
    assert(selectBatchCaptureSize([...catalog].reverse()) === '2560x1920', 'unsorted catalog');
    assert(selectBatchCaptureSize(['1440x1920', '1920x2560', '3024x4032']) === '1920x2560', 'portrait size strings');
  });
  await check('no medium size falls back to the smallest larger native 4:3 size', () => {
    assert(selectBatchCaptureSize(['4032x3024', '3072x2304', '1280x960']) === '3072x2304', 'safe larger fallback');
  });
  await check('unsupported presets, tiny sizes and other ratios keep native defaults', () => {
    for (const list of [
      undefined, [], ['photo', 'high', 'medium'], ['1920x1080', '1280x720'],
      ['640x480', '1280x960'], ['0x0', 'oops', null, 'Infinityx1920'],
    ]) assert(selectBatchCaptureSize(list) === undefined, 'do not force an unsupported or tiny size');
  });
  await check('single requests ~12 MP instead of a 50 MP sensor default', () => {
    const highMegapixel = ['8160x6120', '4080x3060', '4000x3000', '2560x1920', '1920x1440'];
    assert(selectSingleCaptureSize(highMegapixel) === '4080x3060', 'largest size the pipeline can use');
    assert(selectSingleCaptureSize(catalog) === '4032x3024', 'keep a 12 MP sensor at full resolution');
  });
  await check('single never drops to a low size when only full resolution is larger', () => {
    assert(selectSingleCaptureSize(['8160x6120', '1920x1440']) === '8160x6120', 'quality before speed');
    assert(selectSingleCaptureSize(['2560x1920']) === '2560x1920', 'use the best available size');
    assert(selectSingleCaptureSize(['photo', 'high']) === undefined, 'iOS presets keep the native default');
  });

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const harness = (camera) => {
    const state = { camera, busy: false, sizes: [] };
    const controller = createBatchCaptureSizeController({
      getCamera: () => state.camera,
      isBusy: () => state.busy,
      onSize: (size) => state.sizes.push(size),
    });
    controller.setActive(true);
    return { state, controller };
  };

  await check('size discovery runs once per camera, outside the shutter path', async () => {
    let lookups = 0;
    const { state, controller } = harness({
      async getAvailablePictureSizesAsync() { lookups++; return catalog; },
    });
    await Promise.all([controller.prepare(), controller.prepare()]);
    await controller.prepare();
    assert(lookups === 1 && state.sizes.join() === '2560x1920', 'deduplicate native queries');
  });
  await check('one query provides the size for both capture modes', async () => {
    let received;
    const controller = createBatchCaptureSizeController({
      getCamera: () => camera,
      isBusy: () => false,
      onSize: (_, sizes) => { received = sizes; },
    });
    const camera = { async getAvailablePictureSizesAsync() { return catalog; } };
    controller.setActive(true);
    await controller.prepare();
    assert(received?.batch === '2560x1920' && received?.single === '4032x3024', 'batch and single sizes');
  });
  await check('size discovery never reconfigures an in-flight capture', async () => {
    const lookup = deferred();
    const { state, controller } = harness({ getAvailablePictureSizesAsync: () => lookup.promise });
    const ready = controller.prepare();
    state.busy = true;
    lookup.resolve(catalog);
    await ready;
    controller.flush();
    assert(state.sizes.length === 0, 'wait while saving/capturing');
    state.busy = false;
    controller.flush(); controller.flush();
    assert(state.sizes.join() === '2560x1920', 'apply once after capture completes');
  });
  await check('backgrounding or unmounting ignores an outstanding native query', async () => {
    const lookup = deferred();
    const { state, controller } = harness({ getAvailablePictureSizesAsync: () => lookup.promise });
    const ready = controller.prepare();
    controller.setActive(false);
    lookup.resolve(catalog);
    await ready;
    assert(state.sizes.length === 0, 'no late camera/state update');
  });
  await check('a query from a replaced camera cannot update the new camera', async () => {
    const lookup = deferred();
    const { state, controller } = harness({ getAvailablePictureSizesAsync: () => lookup.promise });
    const ready = controller.prepare();
    state.camera = { async getAvailablePictureSizesAsync() { return ['2048x1536']; } };
    await controller.prepare();
    lookup.resolve(catalog);
    await ready;
    assert(state.sizes.join() === '2048x1536', 'only the current camera contributes sizes');
  });
  await check('a pending size from an old camera is discarded before applying', async () => {
    const { state, controller } = harness({ async getAvailablePictureSizesAsync() { return catalog; } });
    state.busy = true;
    await controller.prepare();
    state.camera = {};
    state.busy = false;
    controller.flush();
    assert(state.sizes.length === 0, 'do not apply old hardware capabilities');
  });
  await check('old or unavailable discovery APIs do not block camera use', async () => {
    for (const camera of [{}, { async getAvailablePictureSizesAsync() { throw new Error('Unavailable'); } }]) {
      const { state, controller } = harness(camera);
      await controller.prepare();
      assert(state.sizes.length === 0, 'keep the default resolution without failing capture');
    }
  });
  await check('resuming a camera retries discovery after backgrounding', async () => {
    let lookups = 0;
    const { state, controller } = harness({
      async getAvailablePictureSizesAsync() { lookups++; return catalog; },
    });
    await controller.prepare();
    controller.setActive(false); controller.setActive(true);
    await controller.prepare();
    assert(lookups === 2 && state.sizes.length === 2, 'new active session may discover sizes again');
  });
  return passed;
}
