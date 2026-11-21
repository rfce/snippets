// One active analysis and at most one suspended workspace. Queued entries
// contain source metadata only; shutter pauses keep the algorithm's local state.
export function createPaperAnalysisQueue({ getCached, prepare, analyse, publish, waitForCapacity }) {
  const jobs = new Map();
  let current = null;
  let parked = null;

  const cancelledError = () => Object.assign(new Error('Document analysis was cancelled.'), {
    paperAnalysisCancelled: true,
  });
  const consumers = (job) => [...job.consumers].filter((entry) => !entry.shouldCancel?.());
  const cancelled = (job) => consumers(job).length === 0;
  const priority = (job) => consumers(job).some((entry) => entry.priority === 'high') ? 1 : 0;
  const paused = (job) => {
    const live = consumers(job);
    return live.length > 0 && live.every((entry) => entry.shouldPause?.());
  };
  const signal = (job) => {
    for (const resolve of job.waiters) resolve();
    job.waiters.clear();
  };
  const bestQueued = () => {
    let best = null;
    for (const job of jobs.values()) {
      if (job.state !== 'queued' || cancelled(job) || paused(job)) continue;
      if (!best || priority(job) > priority(best)) best = job;
    }
    return best;
  };
  const finish = (job, error, paper) => {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    if (current === job) current = null;
    if (parked === job) parked = null;
    job.state = 'done';
    signal(job);
    if (current) signal(current);
    if (parked) signal(parked);
    if (error) job.reject(error); else job.resolve(paper);
    pump();
  };
  const wait = (job) => new Promise((resolve) => job.waiters.add(resolve));

  const checkpoint = async (job) => {
    for (;;) {
      if (cancelled(job)) throw cancelledError();
      if (current === job) {
        const next = bestQueued();
        const needsPause = paused(job);
        const shouldPreempt = (next && priority(next) > priority(job)) ||
          (parked && !cancelled(parked) && !paused(parked) && priority(parked) > priority(job));
        if (!needsPause && !shouldPreempt) return;
        if (!parked) {
          parked = job;
          current = null;
          job.state = 'parked';
          pump();
        } else if (!cancelled(parked) && !paused(parked) &&
          (needsPause || priority(parked) > priority(job))) {
          const resume = parked;
          parked = job;
          current = resume;
          job.state = 'parked';
          resume.state = 'running';
          signal(resume);
        } else if (!needsPause) {
          // Two workspaces is the hard bound. A newer request can wait for the
          // current visible image; it never allocates a third analysis buffer.
          return;
        }
      }
      await wait(job);
    }
  };

  const execute = async (job) => {
    const control = {
      checkpoint: () => checkpoint(job),
      shouldCancel: () => cancelled(job),
      shouldPause: () => {
        if (current !== job || paused(job)) return true;
        if (parked && !cancelled(parked) && !paused(parked) && priority(parked) > priority(job)) return true;
        const next = !parked && bestQueued();
        return Boolean(next && priority(next) > priority(job));
      },
      getPriority: () => priority(job) ? 'high' : 'low',
    };
    try {
      await checkpoint(job);
      const cached = await getCached(job.key);
      if (cached) { finish(job, null, cached); return; }
      await waitForCapacity?.();
      await checkpoint(job);
      let input;
      for (;;) {
        try {
          input = await prepare(job.source, control);
          break;
        } catch (error) {
          // A shutter can interrupt a GL request before its readback begins.
          // No CPU analysis exists yet, so wait and retry just this small phase.
          if (!error?.paperAnalysisPaused) throw error;
          await checkpoint(job);
        }
      }
      await checkpoint(job);
      const paper = await analyse(input, control);
      if (cancelled(job)) throw cancelledError();
      await publish(job.key, paper);
      finish(job, null, paper);
    } catch (error) {
      finish(job, error);
    }
  };

  function pump() {
    for (const job of [...jobs.values()]) {
      if (job.state === 'queued' && cancelled(job)) {
        jobs.delete(job.key);
        job.state = 'done';
        job.reject(cancelledError());
      }
    }
    if (current) return;
    const queued = bestQueued();
    const resumable = parked && !cancelled(parked) && !paused(parked) ? parked : null;
    if (resumable && (!queued || priority(resumable) >= priority(queued))) {
      parked = null;
      current = resumable;
      resumable.state = 'running';
      signal(resumable);
    } else if (queued) {
      current = queued;
      queued.state = 'running';
      void execute(queued);
    }
  }

  return {
    request(key, source, { priority: requestedPriority = 'low', shouldCancel, shouldPause } = {}) {
      let job = jobs.get(key);
      if (!job || cancelled(job)) {
        // A cancelled running task will release its workspace at its next
        // checkpoint. Keep its replacement queued until that cleanup finishes.
        job = {
          key, source, state: 'queued', consumers: new Set(), waiters: new Set(),
        };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        jobs.set(key, job);
      }
      const consumer = { priority: requestedPriority, shouldCancel, shouldPause };
      job.consumers.add(consumer);
      this.wake();
      return job.promise.then((paper) => {
        if (shouldCancel?.()) throw cancelledError();
        return paper;
      }).finally(() => job.consumers.delete(consumer));
    },
    wake() {
      if (current) signal(current);
      if (parked) signal(parked);
      pump();
    },
  };
}
