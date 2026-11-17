import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createFinishedPhoto,
  getFinishCacheKey,
  getFinishRenderKey,
  getStaleFinishKeys,
  pickNextFinishJob,
  summarizeFinishes,
} from '@/batch-finishes';
import { releaseTemporaryImagesAsync } from '@/batch-workflow';
import {
  cleanupProcessedImagesAsync,
  renderAdaptiveThresholdAsync,
  renderInvertAsync,
  renderMagicColorAsync,
} from '@/perspective-crop';

const FINISH_RENDERERS = {
  blackAndWhite: renderAdaptiveThresholdAsync,
  magicColor: renderMagicColorAsync,
  invert: renderInvertAsync,
};

/**
 * Owns batch finish results for the whole batch session, not just one visit to
 * Review. Results are cached per photo, so returning to the camera to add a
 * page and coming back reprocesses only the new page. Processing runs one
 * image at a time, starting with `priorityIndex`, and publishes each result
 * as soon as it is ready.
 *
 * Every processed file stays owned here until `prune`, `reset`, or unmount,
 * and is deleted only after `getPendingJobs()` (for example an active save)
 * has settled.
 */
export function useBatchFinishes({
  photos, mode, invertSettings, priorityIndex = 0, active, getPendingJobs, onError,
}) {
  const renderKey = getFinishRenderKey(mode, invertSettings);
  const cacheRef = useRef(new Map());
  const failuresRef = useRef(new Map());
  const alertedRenderKeysRef = useRef(new Set());
  const runningRef = useRef(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [activeKey, setActiveKey] = useState(null);
  const [, setVersion] = useState(0);
  // Bumped by retryFailed so the worker restarts from the effect below, after
  // any accompanying mode change has reached inputsRef.
  const [retryToken, setRetryToken] = useState(0);

  const inputsRef = useRef(null);
  inputsRef.current = { photos, mode, invertSettings, renderKey, priorityIndex, active };
  const getPendingJobsRef = useRef(getPendingJobs);
  getPendingJobsRef.current = getPendingJobs;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const publish = useCallback(() => {
    if (mountedRef.current) setVersion((value) => value + 1);
  }, []);

  const releaseFiles = useCallback((files) => {
    if (!files.length) return;
    const pending = [...(getPendingJobsRef.current?.() ?? []), runningRef.current];
    void releaseTemporaryImagesAsync(files, pending, cleanupProcessedImagesAsync);
  }, []);

  const hasPendingWork = useCallback(() => {
    const input = inputsRef.current;
    if (!input.active || input.mode === 'original' || !FINISH_RENDERERS[input.mode]) return false;
    return Boolean(pickNextFinishJob({
      photos: input.photos,
      renderKey: input.renderKey,
      priorityIndex: input.priorityIndex,
      isSettled: (key) => cacheRef.current.has(key) || failuresRef.current.has(key),
    }));
  }, []);

  const run = useCallback(() => {
    if (runningRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    const isCurrentGeneration = () => mountedRef.current && generationRef.current === generation;

    const job = (async () => {
      while (isCurrentGeneration()) {
        // Re-read inputs for every image, so a swipe re-prioritizes the queue
        // and a new finish applies after at most one in-flight image.
        const input = inputsRef.current;
        if (!input.active || input.mode === 'original') break;
        const render = FINISH_RENDERERS[input.mode];
        if (!render) break;
        const next = pickNextFinishJob({
          photos: input.photos,
          renderKey: input.renderKey,
          priorityIndex: input.priorityIndex,
          isSettled: (key) => cacheRef.current.has(key) || failuresRef.current.has(key),
        });
        if (!next) break;

        setActiveKey(next.key);
        try {
          // Review photos already carry their crop and rotation in their pixels,
          // so the identity geometry fast path applies (no corners/rotation).
          const rendered = await render({
            uri: next.photo.uri,
            sourceWidth: next.photo.width,
            sourceHeight: next.photo.height,
            ...(input.mode === 'invert' ? { settings: input.invertSettings } : {}),
          });
          if (!isCurrentGeneration()) {
            await cleanupProcessedImagesAsync([rendered]);
            break;
          }
          cacheRef.current.set(next.key, createFinishedPhoto(next.photo, rendered));
          failuresRef.current.delete(next.key);
        } catch (error) {
          if (!isCurrentGeneration()) break;
          failuresRef.current.set(next.key, error);
          // One alert per finish; the remaining failures show on the thumbnails.
          if (!alertedRenderKeysRef.current.has(input.renderKey)) {
            alertedRenderKeysRef.current.add(input.renderKey);
            onErrorRef.current?.(input.mode, error);
          }
        }
        publish();
      }
    })().finally(() => {
      if (runningRef.current === job) runningRef.current = null;
      if (mountedRef.current) setActiveKey(null);
      // Inputs can change between the last check and this cleanup.
      if (isCurrentGeneration() && hasPendingWork()) run();
    });
    runningRef.current = job;
  }, [hasPendingWork, publish]);

  useEffect(() => {
    if (active && mode !== 'original') run();
  }, [active, mode, renderKey, photos, priorityIndex, retryToken, run]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const files = [...cacheRef.current.values()];
      cacheRef.current.clear();
      failuresRef.current.clear();
      releaseFiles(files);
    };
  }, [releaseFiles]);

  /** Drops results that no longer match the batch (deleted or re-edited images). */
  const prune = useCallback((nextPhotos) => {
    const staleKeys = getStaleFinishKeys(cacheRef.current.keys(), nextPhotos);
    const files = staleKeys.map((key) => cacheRef.current.get(key)).filter(Boolean);
    staleKeys.forEach((key) => cacheRef.current.delete(key));
    getStaleFinishKeys(failuresRef.current.keys(), nextPhotos)
      .forEach((key) => failuresRef.current.delete(key));
    releaseFiles(files);
    if (files.length) publish();
  }, [publish, releaseFiles]);

  /** Ends the batch session: cancels queued work and releases every result. */
  const reset = useCallback(() => {
    generationRef.current += 1;
    const files = [...cacheRef.current.values()];
    cacheRef.current.clear();
    failuresRef.current.clear();
    alertedRenderKeysRef.current.clear();
    releaseFiles(files);
    publish();
  }, [publish, releaseFiles]);

  /** Lets failed images for a finish be tried again. */
  const retryFailed = useCallback((targetRenderKey = inputsRef.current.renderKey) => {
    let cleared = false;
    for (const key of [...failuresRef.current.keys()]) {
      if (JSON.parse(key)[2] === targetRenderKey) {
        failuresRef.current.delete(key);
        cleared = true;
      }
    }
    alertedRenderKeysRef.current.delete(targetRenderKey);
    if (cleared && mountedRef.current) setRetryToken((value) => value + 1);
  }, []);

  /** Resolves when no image is being processed; used before deleting sources. */
  const whenIdle = useCallback(() => runningRef.current ?? Promise.resolve(), []);

  const summary = summarizeFinishes({
    photos, mode, renderKey, cache: cacheRef.current, failures: failuresRef.current, activeKey,
  });

  return {
    ...summary,
    renderKey,
    isProcessing: mode !== 'original' && summary.statuses.some((status) =>
      status === 'processing' || status === 'queued'),
    getCachedFinish: (photo) => cacheRef.current.get(getFinishCacheKey(photo, renderKey)) ?? null,
    prune,
    reset,
    retryFailed,
    whenIdle,
  };
}
