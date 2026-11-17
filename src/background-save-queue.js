/**
 * Saves images in the background so the person never waits for a save.
 *
 * A job is a list of items, each rendering its own full-size image just in
 * time (`render()`), which is then written to the gallery (`saveImage(uri)`)
 * and deleted (`cleanup`). Jobs run one at a time, in order, so pages keep
 * their capture order and the GPU is never shared between saves.
 *
 * A failed job pauses with its progress kept: `retry(id)` saves only the
 * items that are still missing; `dismiss(id)` gives up on them. A job owns
 * `ownedFiles` (for example a temporary imported copy) and deletes them
 * only once it is finished or dismissed, so a retry can still read them.
 *
 * The queue does not depend on React; screens observe it with
 * `subscribe` / `getSnapshot` (useSyncExternalStore).
 */
export function createBackgroundSaveQueue({ saveImage, cleanup = async () => {}, onError } = {}) {
  const jobs = [];
  const listeners = new Set();
  let sequence = 0;
  let pumping = false;
  let snapshot = { jobs: [], savedCount: 0, lastFinished: null };

  const publish = (patch = {}) => {
    snapshot = {
      ...snapshot,
      ...patch,
      jobs: jobs.map(({ id, label, total, completed, status, error }) => ({
        id, label, total, completed, status, error,
      })),
    };
    listeners.forEach((listener) => listener());
  };

  const release = async (files) => {
    const owned = (files ?? []).filter((file) => file?.temporary);
    if (!owned.length) return;
    try {
      await cleanup(owned);
    } catch {
      // Deleting temporary files is best effort and must not fail a save.
    }
  };

  const finish = async (job, status) => {
    job.status = status;
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    await release(job.ownedFiles);
    publish(status === 'done'
      ? { lastFinished: { id: job.id, label: job.label, total: job.total, at: Date.now() } }
      : {});
    job.resolve({ status, saved: [...job.saved.values()] });
  };

  const runJob = async (job) => {
    job.status = 'saving';
    job.error = null;
    publish();
    try {
      for (const item of job.items) {
        if (job.saved.has(item.id)) continue;
        const rendered = await item.render();
        try {
          const asset = await saveImage(rendered.uri);
          // Record each native success immediately; a later failure must not
          // cause a retry to save this image twice.
          job.saved.set(item.id, asset);
          job.onItemSaved?.(asset, item);
        } finally {
          await release([rendered]);
        }
        job.completed = job.saved.size;
        publish({ savedCount: snapshot.savedCount + 1 });
      }
      await finish(job, 'done');
    } catch (error) {
      job.status = 'failed';
      job.error = error;
      publish();
      onError?.({ id: job.id, label: job.label, total: job.total, completed: job.completed }, error);
    }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const next = jobs.find((job) => job.status === 'queued');
        if (!next) break;
        await runJob(next);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    /**
     * Queues a save and returns at once. `settled` resolves when the job is
     * done or dismissed (never rejects), so callers can wait before deleting
     * files a job might still read.
     */
    enqueue({ label = 'image', items, ownedFiles = [], onItemSaved }) {
      let resolve;
      const settled = new Promise((done) => { resolve = done; });
      const job = {
        id: `save-${++sequence}`,
        label,
        items: [...items],
        total: items.length,
        completed: 0,
        status: 'queued',
        error: null,
        saved: new Map(),
        ownedFiles,
        onItemSaved,
        resolve,
      };
      jobs.push(job);
      publish();
      void pump();
      return { id: job.id, settled };
    },
    retry(id) {
      const job = jobs.find((candidate) => candidate.id === id && candidate.status === 'failed');
      if (!job) return false;
      job.status = 'queued';
      publish();
      void pump();
      return true;
    },
    dismiss(id) {
      const job = jobs.find((candidate) => candidate.id === id && candidate.status === 'failed');
      if (!job) return false;
      void finish(job, 'dismissed');
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}
