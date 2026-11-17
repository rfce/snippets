import { createBackgroundSaveQueue } from '../src/background-save-queue.js';

export async function runBackgroundSaveQueueChecks() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, run) => { await run(); passed.push(name); };
  const rendered = (name) => ({ uri: `file:///${name}.jpg`, width: 10, height: 10, temporary: true });

  await check('enqueue returns at once; images render and save in order', async () => {
    const saved = [];
    const deleted = [];
    const queue = createBackgroundSaveQueue({
      saveImage: async (uri) => { saved.push(uri); return { id: uri }; },
      cleanup: async (files) => { deleted.push(...files.map((file) => file.uri)); },
    });
    const { settled } = queue.enqueue({
      label: 'batch',
      items: ['a', 'b', 'c'].map((name) => ({ id: name, render: async () => rendered(name) })),
    });
    assert(queue.getSnapshot().jobs.length === 1, 'job visible immediately');
    const result = await settled;
    assert(result.status === 'done' && saved.join() === 'file:///a.jpg,file:///b.jpg,file:///c.jpg', 'capture order');
    assert(deleted.length === 3, 'every full-size render is deleted after saving');
    assert(queue.getSnapshot().jobs.length === 0 && queue.getSnapshot().savedCount === 3, 'progress reported');
  });

  await check('a retry saves only the images that are still missing', async () => {
    const saved = [];
    let failOnce = true;
    let reportedFailure = null;
    const queue = createBackgroundSaveQueue({
      saveImage: async (uri) => {
        if (uri.endsWith('b.jpg') && failOnce) { failOnce = false; throw new Error('disk full'); }
        saved.push(uri);
        return { id: uri };
      },
      onError: (job) => { reportedFailure = job; },
    });
    const { id, settled } = queue.enqueue({
      label: 'batch',
      items: ['a', 'b', 'c'].map((name) => ({ id: name, render: async () => rendered(name) })),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(reportedFailure?.completed === 1 && queue.getSnapshot().jobs[0].status === 'failed', 'paused with progress');
    assert(queue.retry(id), 'retry accepted');
    await settled;
    assert(saved.join() === 'file:///a.jpg,file:///b.jpg,file:///c.jpg', 'image a is not saved twice');
  });

  await check('owned files outlive a failure and are deleted only when the job ends', async () => {
    const deleted = [];
    const source = { uri: 'file:///import.jpg', temporary: true };
    const queue = createBackgroundSaveQueue({
      saveImage: async () => { throw new Error('denied'); },
      cleanup: async (files) => { deleted.push(...files.map((file) => file.uri)); },
    });
    const { id, settled } = queue.enqueue({
      items: [{ id: 'one', render: async () => rendered('one') }],
      ownedFiles: [source],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!deleted.includes(source.uri), 'a retry can still read the source');
    queue.dismiss(id);
    const result = await settled;
    assert(result.status === 'dismissed' && deleted.includes(source.uri), 'released on dismiss');
  });

  await check('a failed job does not block later saves', async () => {
    const saved = [];
    const queue = createBackgroundSaveQueue({
      saveImage: async (uri) => {
        if (uri.endsWith('bad.jpg')) throw new Error('nope');
        saved.push(uri);
        return {};
      },
    });
    queue.enqueue({ items: [{ id: 'bad', render: async () => rendered('bad') }] });
    const { settled } = queue.enqueue({ items: [{ id: 'good', render: async () => rendered('good') }] });
    await settled;
    assert(saved.join() === 'file:///good.jpg', 'next job still runs');
  });

  return passed;
}
