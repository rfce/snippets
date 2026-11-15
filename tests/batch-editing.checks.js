import { getBatchEditKey, renderBatchEditAsync } from '../src/batch-editing.js';
import { getDefaultCorners } from '../src/crop-geometry.js';
import { getBatchPhotoId } from '../src/batch-workflow.js';

export async function runBatchEditingChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, run) => { await run(); passed.push(name); };
  const photo = { uri: 'file:///original.jpg', width: 1920, height: 2560 };

  await check('default edits reuse the original without rendering', async () => {
    let calls = 0;
    const result = await renderBatchEditAsync(photo, {}, async () => { calls++; });
    assert(calls === 0 && result.uri === photo.uri, 'no needless processing');
    assert(result.sourcePhoto === photo && result.edits.rotation === 0, 'keep original identity');
  });
  await check('crop is rendered with original dimensions and returned as the preview', async () => {
    const corners = getDefaultCorners(); corners.topLeft.x = 0.15;
    let request;
    const result = await renderBatchEditAsync(photo, { corners, rotation: 0 }, async (options) => {
      request = options;
      return { uri: 'file:///cropped.png', width: 1200, height: 1800, temporary: true };
    });
    assert(request.uri === photo.uri && request.sourceWidth === 1920 && request.sourceHeight === 2560, 'render from original pixels');
    assert(result.uri === 'file:///cropped.png' && result.width === 1200 && result.temporary, 'expose rendered crop');
    assert(getBatchPhotoId(result) === getBatchPhotoId(photo), 'save identity remains the original capture');
  });
  await check('rotation also produces a ready-to-display image', async () => {
    let rotation;
    const result = await renderBatchEditAsync(photo, { rotation: 90 }, async (options) => {
      rotation = options.rotation;
      return { uri: 'file:///rotated.png', width: 2560, height: 1920, temporary: true };
    });
    assert(rotation === 90 && result.uri === 'file:///rotated.png' && result.height === 1920, 'render and use rotated dimensions');
  });
  await check('edit snapshots do not change while native rendering runs', async () => {
    const corners = getDefaultCorners(); corners.topRight.x = 0.85;
    let finish;
    const job = renderBatchEditAsync(photo, { corners, rotation: 90 }, () => new Promise((resolve) => { finish = resolve; }));
    corners.topRight.x = 0.5;
    finish({ uri: 'file:///snapshot.png', temporary: true });
    const result = await job;
    assert(result.edits.corners.topRight.x === 0.85, 'freeze geometry before async work');
  });
  await check('equivalent edit keys support cached apply and rotation reset', () => {
    assert(getBatchEditKey() === getBatchEditKey({ rotation: 360, corners: getDefaultCorners() }), 'full rotations equal the default');
    assert(getBatchEditKey({ rotation: -90 }) === getBatchEditKey({ rotation: 270 }), 'normalize equivalent rotations');
    assert(getBatchEditKey({ rotation: 90 }) !== getBatchEditKey(), 'changed rotation is a new render');
  });
  await check('native errors cannot masquerade as a saved edit', async () => {
    let rejected = false;
    try { await renderBatchEditAsync(photo, { rotation: 90 }, async () => { throw new Error('Render failed'); }); }
    catch { rejected = true; }
    assert(rejected && photo.uri === 'file:///original.jpg', 'preserve original after a failed write');
  });
  return passed;
}
