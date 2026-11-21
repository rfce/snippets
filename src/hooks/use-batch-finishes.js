import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createFinishedPhoto,
  getFinishCacheKey,
  getFinishRenderKey,
  getIdleBatchPhotos,
  getPhotoAnalysisKey,
  getStaleFinishKeys,
  pickNextAnalysisJob,
  pickNextFinishJob,
  summarizeFinishes,
} from '@/batch-finishes';
import { releaseTemporaryImagesAsync } from '@/batch-workflow';
import { isKnownFinish, renderFinishAsync } from '@/finish-render';
import { getBatchPreviewEdge, isBatchPreviewReady, PREVIEW_OUTPUT_EDGE } from '@/preview-quality';
import {
  cleanupProcessedImagesAsync,
  hasPaperAnalysis,
  prefetchDocumentAnalysisAsync,
} from '@/perspective-crop';

// What the worker should process next, if anything. `paused` only holds back
// speculation; the finish on screen in Review is always processed.
function getWorkTarget(input) {
  if (input.active && input.mode !== 'original' && isKnownFinish(input.mode)) {
    return {
      photos: input.photos,
      mode: input.mode,
      invertSettings: input.invertSettings,
      renderKey: input.renderKey,
      priorityIndex: input.priorityIndex,
      priority: 'high',
      speculative: false,
    };
  }
  const mode = input.speculativeMode;
  if (input.paused || !mode || mode === 'original' || !isKnownFinish(mode) || !input.speculativePhotos?.length) return null;
  const photos = getIdleBatchPhotos(
    input.speculativePhotos,
    input.active ? input.priorityIndex : Math.max(0, input.speculativePhotos.length - 2)
  );
  return {
    photos,
    mode,
    invertSettings: input.speculativeInvertSettings,
    renderKey: getFinishRenderKey(mode, input.speculativeInvertSettings),
    // The idle window is already ordered: current/next in Review, latest shots
    // in the camera. Only the chosen finish processes the entire batch.
    priorityIndex: 0,
    priority: 'low',
    speculative: true,
  };
}

// Idle analysis uses a small window: current/next in Review, latest captures
// in the camera. The chosen finish still processes the entire batch.
function getAnalysisTarget(input, skipped) {
  if (input.paused) return null;
  const candidates = input.active ? input.photos : input.speculativePhotos;
  const photos = getIdleBatchPhotos(
    candidates,
    input.active ? input.priorityIndex : Math.max(0, (candidates?.length ?? 0) - 2)
  );
  return pickNextAnalysisJob({
    photos,
    priorityIndex: 0,
    hasAnalysis: hasPaperAnalysis,
    skipped,
  });
}

/**
 * Owns batch finish results for the whole batch session, not just one visit to
 * Review. Results are preview-size and for display only: saving renders each
 * image again at full size from its original capture. Results are cached per photo, so returning to the camera to add a
 * page and coming back reprocesses only the new page. Processing runs one
 * image at a time, starting with `priorityIndex`, and publishes each result
 * as soon as it is ready.
 *
 * Every processed file stays owned here until `prune`, `reset`, or unmount,
 * and is deleted only after `getPendingJobs()` (for example an active save)
 * has settled.
 *
 * Speculation: when nothing on screen needs processing, the worker prepares
 * `speculativeMode` (the finish most likely to be chosen) for
 * `speculativePhotos` at low priority, for example between shots while
 * capturing a batch. The results share the cache, so choosing that finish
 * in Review is instant. `paused` stops new speculative work (an image
 * already in progress is cancelled when possible) so captures and edits do
 * not compete with it. Only two nearby images are warmed; the selected finish
 * still processes the full stack, one image at a time.
 *
 * With nothing left to render, idle time prepares nearby photos' page
 * analysis (the slow, JavaScript part of Black & White and Invert), so the
 * first tap on either starts straight on the GPU. That work is sliced into
 * short steps and is cancelled the moment a finish is chosen, a shot is
 * taken, or the app leaves the foreground.
 */
export function useBatchFinishes({
  photos, mode, invertSettings, priorityIndex = 0, active, getPendingJobs, onError,
  speculativePhotos = null, speculativeMode = null, speculativeInvertSettings, paused = false,
}) {
  const renderKey = getFinishRenderKey(mode, invertSettings);
  const cacheRef = useRef(new Map());
  // Keep replaced files owned until reset; a decoded view may still be using them.
  const supersededFilesRef = useRef(new Map());
  const failuresRef = useRef(new Map());
  const alertedRenderKeysRef = useRef(new Set());
  // Photos whose analysis cannot be prepared ahead of time (or failed to).
  const analysisSkippedRef = useRef(new Set());
  const runningRef = useRef(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [activeKey, setActiveKey] = useState(null);
  const [, setVersion] = useState(0);
  // Bumped by retryFailed so the worker restarts from the effect below, after
  // any accompanying mode change has reached inputsRef.
  const [retryToken, setRetryToken] = useState(0);

  const inputsRef = useRef(null);
  inputsRef.current = {
    photos, mode, invertSettings, renderKey, priorityIndex, active,
    speculativePhotos, speculativeMode, speculativeInvertSettings, paused,
  };
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

  const isSettled = useCallback(
    (key, job) => failuresRef.current.has(key) || isBatchPreviewReady(cacheRef.current.get(key), job), []
  );

  // A finish the person chose that still has images to process. Anything
  // else (speculation, analysis) yields to it immediately.
  const getUrgentWork = useCallback(() => {
    const target = getWorkTarget(inputsRef.current);
    if (!target || target.speculative) return null;
    const next = pickNextFinishJob({ ...target, isSettled });
    if (!next) return null;
    const source = next.photo.sourcePhoto ?? next.photo;
    return {
      ...next,
      analysisKey: target.mode === 'blackAndWhite' || target.mode === 'invert'
        ? getPhotoAnalysisKey(source) : null,
    };
  }, [isSettled]);

  const hasPendingWork = useCallback(() => {
    const input = inputsRef.current;
    const target = getWorkTarget(input);
    return Boolean(
      (target && pickNextFinishJob({ ...target, isSettled })) ||
      getAnalysisTarget(input, analysisSkippedRef.current)
    );
  }, [isSettled]);

  const run = useCallback(() => {
    if (runningRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    const isCurrentGeneration = () => mountedRef.current && generationRef.current === generation;

    const job = (async () => {
      while (isCurrentGeneration()) {
        // Re-read inputs for every image, so a swipe re-prioritizes the queue
        // and a new finish applies after at most one in-flight image.
        const target = getWorkTarget(inputsRef.current);
        const next = target ? pickNextFinishJob({ ...target, isSettled }) : null;

        if (!next) {
          // Nothing to render: prepare the next photo's page analysis.
          const analysis = getAnalysisTarget(inputsRef.current, analysisSkippedRef.current);
          if (!analysis) break;
          try {
            const outcome = await prefetchDocumentAnalysisAsync(analysis.source, {
              shouldCancel: () => {
                if (!isCurrentGeneration()) return true;
                const urgent = getUrgentWork();
                // Choosing a finish for this source promotes the work already
                // running instead of discarding its partial analysis.
                return urgent ? urgent.analysisKey !== analysis.key : inputsRef.current.paused;
              },
            });
            if (!isCurrentGeneration()) break;
            if (outcome === 'skipped') analysisSkippedRef.current.add(analysis.key);
          } catch (error) {
            if (!isCurrentGeneration()) break;
            // A failure here only means the first render does the analysis.
            analysisSkippedRef.current.add(analysis.key);
          }
          continue;
        }

        const shouldCancel = () => {
          if (!isCurrentGeneration()) return true;
          const current = getWorkTarget(inputsRef.current);
          if (!current || current.renderKey !== target.renderKey) return true;
          // A stable Review array needs no per-slice scan or cache-key allocation.
          if (current.photos === target.photos) return false;
          return !current.photos.some((photo) => getFinishCacheKey(photo, current.renderKey) === next.key);
        };
        const source = next.photo.sourcePhoto ?? next.photo;
        const sourceAnalysisKey = getPhotoAnalysisKey(source);
        const shouldCancelAnalysis = () => {
          if (!isCurrentGeneration()) return true;
          if (!shouldCancel()) return false;
          const urgent = getUrgentWork();
          return urgent?.analysisKey !== sourceAnalysisKey;
        };
        const previewMaxEdge = getBatchPreviewEdge(next);
        setActiveKey(next.key);
        try {
          // Crop, rotation and finish in one preview-size pass from the
          // original capture; the crop is metadata on the Review photo.
          const rendered = await renderFinishAsync({
            source,
            edits: next.photo.edits,
            mode: target.mode,
            invertSettings: target.invertSettings,
            size: 'preview',
            priority: previewMaxEdge === PREVIEW_OUTPUT_EDGE ? 'high' : 'low',
            previewMaxEdge,
            shouldCancel,
            shouldCancelAnalysis,
          });
          if (shouldCancel()) {
            await cleanupProcessedImagesAsync([rendered]);
            if (!isCurrentGeneration()) break;
            continue;
          }
          const previous = cacheRef.current.get(next.key);
          if (previous?.temporary && previous.uri !== rendered.uri) {
            supersededFilesRef.current.set(previous.uri, previous);
          }
          cacheRef.current.set(next.key, createFinishedPhoto(next.photo, rendered));
          failuresRef.current.delete(next.key);
        } catch (error) {
          if (!isCurrentGeneration()) break;
          if (error?.renderCancelled || error?.paperAnalysisCancelled) continue;
          failuresRef.current.set(next.key, error);
          // One alert per finish the person chose; speculative failures stay
          // silent and are retried when that finish is selected.
          if (!target.speculative && !alertedRenderKeysRef.current.has(target.renderKey)) {
            alertedRenderKeysRef.current.add(target.renderKey);
            onErrorRef.current?.(target.mode, error);
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
  }, [hasPendingWork, getUrgentWork, isSettled, publish]);

  const speculativeRenderKey = speculativeMode
    ? getFinishRenderKey(speculativeMode, speculativeInvertSettings) : null;
  useEffect(() => {
    run();
  }, [active, mode, renderKey, photos, priorityIndex, retryToken, run,
    speculativePhotos, speculativeRenderKey, paused]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const files = [...cacheRef.current.values(), ...supersededFilesRef.current.values()];
      cacheRef.current.clear();
      supersededFilesRef.current.clear();
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
    const files = [...cacheRef.current.values(), ...supersededFilesRef.current.values()];
    cacheRef.current.clear();
    supersededFilesRef.current.clear();
    failuresRef.current.clear();
    alertedRenderKeysRef.current.clear();
    analysisSkippedRef.current.clear();
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
