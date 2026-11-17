import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, BackHandler, StyleSheet, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BatchFilmstrip } from '@/components/batch-filmstrip';
import { CropEditor } from '@/components/capture-review';
import { ThemedText } from '@/components/themed-text';
import { createRotationSaveQueue, getBatchRotationPreviewStyle } from '@/batch-editing';
import { getBatchPhotoId } from '@/batch-workflow';
import { hasCustomCrop } from '@/crop-geometry';
import { useSwipeTrack } from '@/hooks/use-swipe-track';
import { EDIT_ICONS, IconButton, IconDock } from '@/components/icon-dock';

const ICONS = EDIT_ICONS;

// Shared by the plain preview and the crop canvas so entering crop mode never
// changes the displayed image size.
const CROP_PADDING = 12;

export function BatchEditor({
  photos, editsById, renderedPhotosById, onCommitEdits, selectedIndex, onSelect,
  onBack, onDone, onDelete, isApplying,
}) {
  const editorRef = useRef(null);
  const actionRef = useRef(false);
  const rotationQueueRef = useRef(null);
  const queuePhotoRef = useRef(null);
  const commitRef = useRef(onCommitEdits);
  const mountedRef = useRef(true);
  commitRef.current = onCommitEdits;
  const { width: windowWidth, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = height < 740 || fontScale > 1.2;
  const thumbSize = compact ? 78 : 92;
  // Fixed chrome: header, thumbnail strip, floating dock, paddings and the
  // minimum gap above the dock. The stage takes what is left over, so the photo
  // is never stranded in leftover space.
  const reservedHeight = 46 + 8 + (thumbSize + 28) + 84 + 12 + 20
    + insets.top + insets.bottom;
  const maxStageHeight = Math.max(160, height - reservedHeight);
  const [isCropping, setIsCropping] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [optimisticEdits, setOptimisticEdits] = useState(null);
  const [frozenPreview, setFrozenPreview] = useState(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const activeIndex = Math.min(Math.max(0, selectedIndex), photos.length - 1);
  const photo = photos[activeIndex];
  const id = getBatchPhotoId(photo);
  const edits = editsById[id];
  const preview = renderedPhotosById[id] ?? photo;
  // Keep the decoded bitmap stable while its final pixels are saved. Swapping
  // sources mid-rotation can briefly show the old orientation or a blank frame.
  // Both are tagged with the photo id so switching images never shows another
  // image's frozen frame or a stale optimistic rotation.
  const displayPreview = frozenPreview?.id === id ? frozenPreview.photo : preview;
  const pendingEdits = optimisticEdits?.id === id ? optimisticEdits.edits : null;
  const effectiveEdits = pendingEdits ? { ...editsById, [id]: pendingEdits } : editsById;
  const displayPhotos = useMemo(() => photos.map((item, index) => index === activeIndex
    ? displayPreview : renderedPhotosById[getBatchPhotoId(item)] ?? item),
  [photos, activeIndex, displayPreview, renderedPhotosById]);
  const editedCount = photos.filter((item) => {
    const value = effectiveEdits[getBatchPhotoId(item)];
    return value?.rotation || hasCustomCrop(value?.corners);
  }).length;
  const busy = isApplying || isFinishing;
  const previewRotation = (pendingEdits?.rotation ?? edits?.rotation ?? 0) -
    (displayPreview.sourcePhoto ? displayPreview.edits?.rotation ?? 0 : 0);
  // Size the fixed preview container from the batch, not the active photo.
  // Taking the tallest photo's unrotated shape keeps the container height
  // identical for every image, so switching between portrait and landscape
  // captures (or rotating/cropping one) never moves the thumbnails below.
  const stageWidth = frame.width > 0 ? frame.width : Math.max(0, windowWidth - 36);
  const stageHeight = useMemo(() => {
    if (stageWidth <= 0) return 0;
    const innerWidth = Math.max(0, stageWidth - CROP_PADDING * 2);
    const tallest = photos.reduce((max, item) => {
      const source = item.sourcePhoto ?? item;
      const ratio = source.width > 0 && source.height > 0 ? source.width / source.height : 4 / 3;
      return Math.max(max, innerWidth / ratio + CROP_PADDING * 2);
    }, 0);
    return Math.min(tallest, maxStageHeight);
  }, [photos, stageWidth, maxStageHeight]);
  // Lay the preview out against the computed stage size, not the last measured
  // height, so the first paint after a layout change is already correct.
  const previewFrame = {
    width: stageWidth,
    height: stageHeight > 0 ? stageHeight : frame.height,
  };
  const previewStyle = getBatchRotationPreviewStyle(displayPreview, previewRotation, previewFrame, CROP_PADDING);

  // Build the neighbouring slides from their rendered previews (when they
  // exist) so a swipe reveals exactly what the filmstrip shows, including any
  // applied rotation or crop.
  const buildSlide = (item) => {
    const itemId = getBatchPhotoId(item);
    const rendered = renderedPhotosById[itemId] ?? item;
    const value = editsById[itemId] ?? item.edits;
    const storedRotation = value?.rotation ?? 0;
    const bakedRotation = rendered.sourcePhoto ? rendered.edits?.rotation ?? 0 : 0;
    return {
      item: rendered,
      style: getBatchRotationPreviewStyle(rendered, storedRotation - bakedRotation, previewFrame, CROP_PADDING),
    };
  };
  const firstSlideIndex = Math.max(0, activeIndex - 1);
  const lastSlideIndex = Math.min(photos.length - 1, activeIndex + 1);
  const slideIndices = [];
  for (let index = firstSlideIndex; index <= lastSlideIndex; index += 1) slideIndices.push(index);
  // Slides are keyed by photo id and laid out at absolute page positions.
  // The page offset lands exactly on the incoming slide at the end of a swipe,
  // so committing a selection never re-bases styles or snaps the track, which
  // is what used to paint the outgoing frame for a frame.
  const slides = frame.width > 0 ? slideIndices.map((index) => {
    const isActive = index === activeIndex;
    const built = isActive ? null : buildSlide(photos[index]);
    return {
      id: getBatchPhotoId(photos[index]),
      isActive,
      offset: index * frame.width,
      item: isActive ? displayPreview : built.item,
      style: isActive ? previewStyle : built.style,
    };
  }) : [];

  const photoRef = useRef(photo);
  photoRef.current = photo;
  // Keep the previously decoded bitmap painted underneath until the newly
  // selected photo reports that it is decoded. Without this, swapping the
  // source leaves a blank frame that reads as a full-screen flash. The update
  // happens during render so both images are committed in the same frame.
  const [retainedPreview, setRetainedPreview] = useState(null);
  const skipRetainedPreviewRef = useRef(false);
  const shownPreviewRef = useRef(null);
  if (shownPreviewRef.current?.uri !== displayPreview.uri) {
    const previous = shownPreviewRef.current;
    shownPreviewRef.current = { uri: displayPreview.uri, photo: displayPreview, rotation: previewRotation };
    const skipRetained = skipRetainedPreviewRef.current;
    skipRetainedPreviewRef.current = false;
    if (previous?.uri && !skipRetained) setRetainedPreview(previous);
  }
  const retainedStyle = retainedPreview
    ? getBatchRotationPreviewStyle(retainedPreview.photo, retainedPreview.rotation, previewFrame, CROP_PADDING)
    : null;
  // Drop the retained frame if the new source never reports onDisplay.
  useEffect(() => {
    if (!retainedPreview) return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setRetainedPreview(null);
    }, 700);
    return () => clearTimeout(timer);
  }, [retainedPreview]);

  // Selection can change from outside (delete, parent clamping), so reset the
  // per-image editor state whenever the displayed photo really changes.
  const previousIdRef = useRef(id);
  useEffect(() => {
    if (previousIdRef.current === id) return;
    previousIdRef.current = id;
    setIsCropping(false);
    setFrozenPreview(null);
    setOptimisticEdits(null);
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rotationQueueRef.current?.dispose();
      rotationQueueRef.current = null;
    };
  }, []);

  const getRotationQueue = () => {
    // A staged rotation must always be written for the photo it was made on,
    // even if the user switches images while the 450 ms timer is pending.
    if (!rotationQueueRef.current ||
      queuePhotoRef.current !== getBatchPhotoId(photoRef.current)) {
      rotationQueueRef.current?.dispose();
      queuePhotoRef.current = getBatchPhotoId(photoRef.current);
      const queuedPhoto = photoRef.current;
      rotationQueueRef.current = createRotationSaveQueue({
        save: (next, { isCurrent }) =>
          commitRef.current(queuedPhoto, next, { background: true, isCurrent }),
      });
    }
    return rotationQueueRef.current;
  };

  const commitEdits = (options) => {
    const next = editorRef.current?.getEdits();
    return next ? onCommitEdits(photoRef.current, next, options) : Promise.resolve(true);
  };

  const flushRotations = async () => {
    const saved = await (rotationQueueRef.current?.flush() ?? Promise.resolve(true));
    if (!saved && mountedRef.current) {
      Alert.alert('Could not save rotation', 'Your changes are still visible. Please try again before leaving this image.');
    }
    return saved;
  };

  const flushRotationsRef = useRef(flushRotations);
  flushRotationsRef.current = flushRotations;

  const saveBeforeLeaving = async () => await flushRotations() && await commitEdits();

  const runAction = async (action) => {
    if (actionRef.current || isApplying) return;
    actionRef.current = true;
    setIsFinishing(true);
    try { await action(); }
    finally {
      actionRef.current = false;
      if (mountedRef.current) setIsFinishing(false);
    }
  };

  const selectPhoto = (index, fromSwipe = false) => {
    if (index === activeIndex || actionRef.current || isApplying) return Promise.resolve(false);
    // Switching must never raise `busy`: that dims the dock, swaps button
    // states and shows the applying overlay, which reads as a screen flash.
    actionRef.current = true;
    return flushRotations()
      .then((saved) => {
        if (!saved) return false;
        // Persist the outgoing photo in the background and navigate right away
        // so the newly selected preview is never blocked by a render pass.
        commitEdits({ background: true }).catch(() => {});
        setIsCropping(false);
        setFrozenPreview(null);
        setOptimisticEdits(null);
        skipRetainedPreviewRef.current = fromSwipe;
        onSelect(index);
        return true;
      })
      .catch(() => false)
      .finally(() => { actionRef.current = false; });
  };

  // Horizontal swipes translate a track of slides laid out at absolute page
  // positions (shared with batch Review through useSwipeTrack).
  const { trackX, panHandlers: swipeHandlers, resetTrack } = useSwipeTrack({
    count: photos.length,
    activeIndex,
    frameWidth: frame.width,
    disabled: busy || isCropping,
    isBlocked: () => actionRef.current,
    onSelect: selectPhoto,
    onSwipeStart: () => {
      // Drop any frame retained from an earlier image switch so it can never
      // cover the photo that slides in.
      setRetainedPreview(null);
      // Start any pending rotation save now so the commit at the end of the
      // swipe does not have to wait for the queue's debounce window.
      void flushRotationsRef.current();
    },
  });
  useEffect(() => {
    if (isCropping) resetTrack();
  }, [isCropping, activeIndex, frame.width]);

  const cancelCrop = useCallback(() => {
    setIsCropping(false);
    setEditorRevision((value) => value + 1);
  }, []);

  const goBack = () => {
    if (actionRef.current || isApplying) return;
    if (isCropping) cancelCrop();
    else return runAction(async () => { if (await saveBeforeLeaving()) onBack(); });
  };

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack]));

  const openCrop = () => {
    if (actionRef.current || isApplying) return;
    if (isCropping) { cancelCrop(); return; }
    return runAction(async () => {
      if (!await saveBeforeLeaving()) return;
      setFrozenPreview(null);
      setOptimisticEdits(null);
      setIsCropping(true);
    });
  };

  const rotate = () => {
    if (actionRef.current || isApplying) return;
    editorRef.current?.rotate();
    if (isCropping) return;
    const next = editorRef.current?.getEdits();
    if (!next) return;
    setFrozenPreview((current) => (current?.id === id ? current : { id, photo: preview }));
    setOptimisticEdits({ id, edits: next });
    getRotationQueue().stage(next);
  };

  const applyCrop = () => runAction(async () => {
    if (!await saveBeforeLeaving()) return;
    setFrozenPreview(null);
    setOptimisticEdits(null);
    setIsCropping(false);
  });

  const deletePhoto = () => runAction(async () => {
    await rotationQueueRef.current?.cancel();
    onDelete(photo);
  });

  const finish = () => runAction(async () => { if (await saveBeforeLeaving()) onDone(); });

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View style={styles.headerSpacer} />
          <View style={styles.headerCopy}>
            <ThemedText numberOfLines={1} style={styles.headerTitle}>Edit image</ThemedText>
            <ThemedText numberOfLines={1} style={styles.headerSubtitle}>
              {photos.length > 1 ? `${photos.length} images` : 'Single image'}
              {editedCount > 0 ? ` · ${editedCount} edited` : ''}
            </ThemedText>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.content}>
          <View style={[styles.stage, stageHeight > 0 && { height: stageHeight }]}
            onLayout={({ nativeEvent: { layout } }) => {
              setFrame((current) => current.width === layout.width && current.height === layout.height
                ? current : { width: layout.width, height: layout.height });
            }}>
            <View style={styles.canvas} {...swipeHandlers}>
              <View pointerEvents={isCropping ? 'auto' : 'none'}
                style={[StyleSheet.absoluteFill, { opacity: isCropping ? 1 : 0 }]}>
                <CropEditor
                  key={`${id}:${editorRevision}`}
                  ref={editorRef}
                  photo={photo}
                  initialEdits={edits}
                  disabled={busy}
                  showCropHandles={isCropping}
                  viewportPadding={CROP_PADDING}
                />
              </View>
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: trackX }] }]}>
                  {slides.map((slide) => (
                    <View key={`slide:${slide.id}`}
                      style={[StyleSheet.absoluteFill, { transform: [{ translateX: slide.offset }] }]}>
                      {slide.isActive && retainedPreview && retainedStyle &&
                        retainedPreview.uri !== displayPreview.uri ? (
                        <Image
                          key={`retained:${retainedPreview.uri}`}
                          source={retainedPreview.uri}
                          contentFit="contain"
                          cachePolicy="memory-disk"
                          transition={0}
                          accessible={false}
                          style={[retainedStyle, isCropping && styles.hiddenSlide]}
                        />
                      ) : null}
                      <Image
                        source={slide.item.uri}
                        contentFit="contain"
                        cachePolicy="memory-disk"
                        transition={0}
                        accessible={false}
                        onDisplay={slide.isActive ? () => setRetainedPreview(null) : undefined}
                        onError={slide.isActive ? () => setRetainedPreview(null) : undefined}
                        style={[slide.style, isCropping && styles.hiddenSlide]}
                      />
                    </View>
                  ))}
                </Animated.View>
              </View>
              {isApplying && (
                <View style={styles.applyingOverlay} accessibilityLiveRegion="polite">
                  <ActivityIndicator color="#3C78D8" />
                  <ThemedText style={styles.applyingText}>Applying edit…</ThemedText>
                </View>
              )}
            </View>
          </View>

          <BatchFilmstrip photos={displayPhotos} editsById={effectiveEdits}
            selectedIndex={activeIndex} onSelect={selectPhoto}
            disabled={busy} compact={compact} showCaption={false}
            size={thumbSize} style={styles.filmstrip} />
        </View>

        <View style={styles.spacer} />

        <View style={styles.footer}>
          <IconDock>
            <IconButton label={isCropping ? 'Cancel crop changes' : 'Crop current image'}
              icon={ICONS.crop} iconSize={28} large active={isCropping} disabled={busy}
              onPress={isCropping ? cancelCrop : openCrop} />
            {isCropping ? (
              <>
                <IconButton label="Reset crop to full image" icon={ICONS.reset} iconSize={28} large
                  disabled={busy}
                  onPress={() => { if (!actionRef.current) editorRef.current?.reset(); }} />
                <IconButton label="Apply crop to current image" icon={ICONS.check} iconSize={28} large
                  success disabled={busy} onPress={applyCrop} />
              </>
            ) : (
              <>
                <IconButton label="Rotate current image 90 degrees clockwise"
                  icon={ICONS.rotate} iconSize={28} large disabled={busy} onPress={rotate} />
                <IconButton label="Delete current image" icon={ICONS.delete} iconSize={28} large destructive
                  disabled={busy} onPress={deletePhoto} />
                <IconButton label="Save edits and return to batch camera" icon={ICONS.check} iconSize={28} large
                  primary disabled={busy} busy={isFinishing} onPress={finish} />
              </>
            )}
          </IconDock>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  safeArea: { flex: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 46 },
  headerSpacer: { width: 46 },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center', gap: 1 },
  headerTitle: { color: '#0F172A', fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2,
    textAlign: 'center' },
  headerSubtitle: { color: '#94A3B8', fontSize: 11, lineHeight: 15, fontWeight: '500',
    letterSpacing: 0.2, textAlign: 'center' },
  content: { width: '100%', alignItems: 'center' },
  stage: { width: '100%', marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  canvas: { flex: 1, width: '100%', minHeight: 1, overflow: 'hidden' },
  hiddenSlide: { opacity: 0 },
  applyingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center', justifyContent: 'center', gap: 8 },
  applyingText: { color: '#31517F', fontSize: 12, lineHeight: 18, fontWeight: '600' },
  filmstrip: { marginTop: 12, paddingVertical: 2 },
  spacer: { flex: 1, minHeight: 12 },
  footer: { width: '100%', alignItems: 'center', paddingTop: 4, paddingBottom: 2 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
