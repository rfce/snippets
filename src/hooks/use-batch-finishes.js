import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  wakePaperAnalysis,
} from '@/perspective-crop';

// What the worker should process next, if anything. `paused` only holds back
// speculation; analysis has its own pause flag so it can run during the flight.
// The finish on screen in Review is always processed.
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

// Completion belongs to the batch session, independently of the bounded RAM
// cache. Walking every pending capture therefore terminates even after eviction.
function getAnalysisTarget(input, skipped, completed) {
  if (input.analysisPaused ?? input.paused) return null;
  return pickNextAnalysisJob({
    photos: input.active ? input.photos : input.speculativePhotos,
    // Review reopens at this index (zero for a new batch). Prepare that page
    // first, then walk capture order; a new shutter never restarts the old page.
    priorityIndex: input.priorityIndex,
    skipped,
    hasAnalysis: (source) => {
      const key = getPhotoAnalysisKey(source);
      if (completed.has(key)) return true;
      if (!hasPaperAnalysis(source)) return false;
      completed.add(key);
      return true;
    },
  });
}

/**
 * Owns per-photo preview results for a batch session. Selected finishes render
 * first. During camera idle time, one resumable worker prepares all paper maps
 * before warming the remembered finish. Pending entries are source metadata;
 * at most one active and one suspended CPU workspace exist in the native queue.
 */
export function useBatchFinishes({
  photos, mode, invertSettings, priorityIndex = 0, active, getPendingJobs, onError,
  speculativePhotos = null, speculativeMode = null, speculativeInvertSettings, paused = false,
  analysisPaused = paused,
}) {
  const renderKey = getFinishRenderKey(mode, invertSettings);
  const cacheRef = useRef(new Map());
  // Keep replaced files owned until reset; a decoded view may still be using them.
  const supersededFilesRef = useRef(new Map());
  const failuresRef = useRef(new Map());
  const alertedRenderKeysRef = useRef(new Set());
  // Photos whose analysis cannot be prepared ahead of time (or failed to).
  const analysisSkippedRef = useRef(new Set());
  const analysisCompletedRef = useRef(new Set());
  const analysisRunningRef = useRef(null);
  const runRef = useRef(() => {});
  const runAnalysisRef = useRef(() => {});
  const runningRef = useRef(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [activeKey, setActiveKey] = useState(null);
  const [, setVersion] = useState(0);
  // Bumped by retryFailed so the worker restarts from the effect below, after
  // any accompanying mode change has reached inputsRef.
  const [retryToken, setRetryToken] = useState(0);

  const analysisPhotos = photos ?? speculativePhotos;
  const analysisKeys = useMemo(() => new Set((analysisPhotos ?? []).map((photo) =>
    getPhotoAnalysisKey(photo.sourcePhoto ?? photo)
  )), [analysisPhotos]);
  const inputsRef = useRef(null);
  inputsRef.current = {
    photos, mode, invertSettings, renderKey, priorityIndex, active,
    speculativePhotos, speculativeMode, speculativeInvertSettings, paused, analysisPaused, analysisKeys,
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
    const pending = [...(getPendingJobsRef.current?.() ?? []), runningRef.current, analysisRunningRef.current];
    void releaseTemporaryImagesAsync(files, pending, cleanupProcessedImagesAsync);
  }, []);

  const isSettled = useCallback(
    (key, job) => failuresRef.current.has(key) || isBatchPreviewReady(cacheRef.current.get(key), job), []
  );

  const pickAnalysis = useCallback(() => {
    const input = inputsRef.current;
    const target = getWorkTarget(input);
    // The chosen finish already prepares its own paper maps. Keep idle work
    // behind visible renders, including Magic Color, until those settle.
    if (target && !target.speculative && pickNextFinishJob({ ...target, isSettled })) return null;
    return getAnalysisTarget(input, analysisSkippedRef.current, analysisCompletedRef.current);
  }, [isSettled]);

  const pickRender = useCallback(() => {
    const input = inputsRef.current;
    const target = getWorkTarget(input);
    if (!target) return null;
    if (target.speculative && (analysisRunningRef.current ||
      getAnalysisTarget(input, analysisSkippedRef.current, analysisCompletedRef.current))) return null;
    const next = pickNextFinishJob({ ...target, isSettled });
    return next ? { target, next } : null;
  }, [isSettled]);

  const run = useCallback(() => {
    if (runningRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    const isCurrentGeneration = () => mountedRef.current && generationRef.current === generation;

    const job = (async () => {
      while (isCurrentGeneration()) {
        // Re-read inputs for every image, so a swipe re-prioritizes the queue
        // and a new finish applies after at most one in-flight image.
        const work = pickRender();
        if (!work) break;
        const { target, next } = work;

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
        const shouldCancelAnalysis = () => !isCurrentGeneration() ||
          !inputsRef.current.analysisKeys.has(sourceAnalysisKey);
        const shouldPauseAnalysis = () => Boolean(inputsRef.current.analysisPaused ?? inputsRef.current.paused);
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
            shouldPauseAnalysis,
            onAnalysisReady: () => {
              if (!shouldCancelAnalysis()) analysisCompletedRef.current.add(sourceAnalysisKey);
            },
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
      // A previous generation can finish after a new batch has arrived. Use
      // the latest callbacks so that cancellation never strands its new work.
      if (mountedRef.current) {
        if (pickRender()) runRef.current();
        if (pickAnalysis()) runAnalysisRef.current();
      }
    });
    runningRef.current = job;
  }, [pickAnalysis, pickRender, publish]);
  runRef.current = run;

  const runAnalysis = useCallback(() => {
    if (analysisRunningRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    const isCurrentGeneration = () => mountedRef.current && generationRef.current === generation;
    const job = (async () => {
      while (isCurrentGeneration()) {
        const analysis = pickAnalysis();
        if (!analysis) break;
        const shouldCancel = () => !isCurrentGeneration() ||
          !inputsRef.current.analysisKeys.has(analysis.key);
        try {
          const outcome = await prefetchDocumentAnalysisAsync(analysis.source, {
            shouldCancel,
            shouldPause: () => Boolean(inputsRef.current.analysisPaused ?? inputsRef.current.paused),
          });
          if (!isCurrentGeneration()) break;
          if (outcome === 'done' && !shouldCancel()) analysisCompletedRef.current.add(analysis.key);
          if (outcome === 'skipped') analysisSkippedRef.current.add(analysis.key);
        } catch (error) {
          if (!isCurrentGeneration()) break;
          // A later explicit finish can retry; idle failures must not loop.
          analysisSkippedRef.current.add(analysis.key);
        }
      }
    })().finally(() => {
      if (analysisRunningRef.current === job) analysisRunningRef.current = null;
      if (mountedRef.current) {
        if (pickRender()) runRef.current();
        if (pickAnalysis()) runAnalysisRef.current();
      }
    });
    analysisRunningRef.current = job;
  }, [pickAnalysis, pickRender]);
  runAnalysisRef.current = runAnalysis;

  const speculativeRenderKey = speculativeMode
    ? getFinishRenderKey(speculativeMode, speculativeInvertSettings) : null;
  useEffect(() => {
    for (const set of [analysisCompletedRef.current, analysisSkippedRef.current]) {
      for (const key of set) if (!analysisKeys.has(key)) set.delete(key);
    }
    wakePaperAnalysis();
    run();
    runAnalysis();
  }, [active, mode, renderKey, photos, priorityIndex, retryToken, run, runAnalysis, analysisKeys,
    speculativePhotos, speculativeRenderKey, paused, analysisPaused]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      wakePaperAnalysis();
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
    wakePaperAnalysis();
    const files = [...cacheRef.current.values(), ...supersededFilesRef.current.values()];
    cacheRef.current.clear();
    supersededFilesRef.current.clear();
    failuresRef.current.clear();
    alertedRenderKeysRef.current.clear();
    analysisSkippedRef.current.clear();
    analysisCompletedRef.current.clear();
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
  const whenIdle = useCallback(() => Promise.allSettled(
    [runningRef.current, analysisRunningRef.current].filter(Boolean)
  ), []);

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
