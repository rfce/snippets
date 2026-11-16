import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BatchFilmstrip } from '@/components/batch-filmstrip';
import { CropEditor } from '@/components/capture-review';
import { ThemedText } from '@/components/themed-text';
import { createRotationSaveQueue, getBatchRotationPreviewStyle } from '@/batch-editing';
import { getBatchPhotoId } from '@/batch-workflow';
import { hasCustomCrop } from '@/crop-geometry';

const ICONS = {
  back: { ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' },
  crop: { ios: 'crop', android: 'crop', web: 'crop' },
  rotate: { ios: 'rotate.right', android: 'rotate_right', web: 'rotate_right' },
  reset: { ios: 'arrow.up.left.and.arrow.down.right', android: 'open_in_full', web: 'open_in_full' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  delete: { ios: 'trash', android: 'delete', web: 'delete' },
};

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
  const { height, fontScale } = useWindowDimensions();
  const compact = height < 740 || fontScale > 1.2;
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
  const previewStyle = getBatchRotationPreviewStyle(displayPreview, previewRotation, frame, CROP_PADDING);

  const photoRef = useRef(photo);
  photoRef.current = photo;
  // Keep the previously decoded bitmap painted underneath until the newly
  // selected photo reports that it is decoded. Without this, swapping the
  // source leaves a blank frame that reads as a full-screen flash. The update
  // happens during render so both images are committed in the same frame.
  const [retainedPreview, setRetainedPreview] = useState(null);
  const shownPreviewRef = useRef(null);
  if (shownPreviewRef.current?.uri !== displayPreview.uri) {
    const previous = shownPreviewRef.current;
    shownPreviewRef.current = { uri: displayPreview.uri, photo: displayPreview, rotation: previewRotation };
    if (previous?.uri) setRetainedPreview(previous);
  }
  const retainedStyle = retainedPreview
    ? getBatchRotationPreviewStyle(retainedPreview.photo, retainedPreview.rotation, frame, CROP_PADDING)
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

  const selectPhoto = (index) => {
    if (index === activeIndex || actionRef.current || isApplying) return;
    // Switching must never raise `busy`: that dims the dock, swaps button
    // states and shows the applying overlay, which reads as a screen flash.
    actionRef.current = true;
    flushRotations()
      .then((saved) => {
        if (!saved) return;
        // Persist the outgoing photo in the background and navigate right away
        // so the newly selected preview is never blocked by a render pass.
        commitEdits({ background: true }).catch(() => {});
        setIsCropping(false);
        setFrozenPreview(null);
        setOptimisticEdits(null);
        onSelect(index);
      })
      .catch(() => {})
      .finally(() => { actionRef.current = false; });
  };

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
          <IconButton label={isCropping ? 'Cancel crop changes' : 'Return to batch camera'}
            icon={ICONS.back} onPress={goBack} disabled={busy} />
          <View style={styles.headerCopy}>
            <ThemedText numberOfLines={1} style={styles.headerTitle}>Edit image</ThemedText>
            <ThemedText numberOfLines={1} style={styles.headerSubtitle}>
              {photos.length} {photos.length === 1 ? 'image' : 'images'} · {editedCount} edited
            </ThemedText>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.canvas} onLayout={({ nativeEvent: { layout } }) => {
          setFrame((current) => current.width === layout.width && current.height === layout.height
            ? current : { width: layout.width, height: layout.height });
        }}>
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
          {retainedPreview && retainedStyle && retainedPreview.uri !== displayPreview.uri ? (
            <Image
              key={`retained:${retainedPreview.uri}`}
              source={retainedPreview.uri}
              pointerEvents="none"
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={0}
              accessible={false}
              style={[retainedStyle, { opacity: isCropping ? 0 : 1 }]}
            />
          ) : null}
          <Image
            key={`preview:${displayPreview.uri}`}
            source={displayPreview.uri}
            pointerEvents="none"
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={0}
            accessible={false}
            onDisplay={() => setRetainedPreview(null)}
            onError={() => setRetainedPreview(null)}
            style={[previewStyle, { opacity: isCropping ? 0 : 1 }]}
          />
          {isApplying && (
            <View style={styles.applyingOverlay} accessibilityLiveRegion="polite">
              <ActivityIndicator color="#3C78D8" />
              <ThemedText style={styles.applyingText}>Applying edit…</ThemedText>
            </View>
          )}
        </View>

        <ThemedText style={styles.stackCount}>
          {photos.length ? activeIndex + 1 : 0} / {photos.length}
        </ThemedText>

        <BatchFilmstrip photos={displayPhotos} editsById={effectiveEdits}
          selectedIndex={activeIndex} onSelect={selectPhoto}
          disabled={busy} compact={compact} showCaption={false}
          size={compact ? 64 : 76} />

        <View style={styles.footer}>
          <View style={styles.dock}>
            <IconButton label={isCropping ? 'Cancel crop changes' : 'Crop current image'}
              icon={ICONS.crop} active={isCropping} disabled={busy}
              onPress={isCropping ? cancelCrop : openCrop} />
            {isCropping ? (
              <>
                <IconButton label="Reset crop to full image" icon={ICONS.reset}
                  disabled={busy}
                  onPress={() => { if (!actionRef.current) editorRef.current?.reset(); }} />
                <IconButton label="Apply crop to current image" icon={ICONS.check}
                  success disabled={busy} onPress={applyCrop} />
              </>
            ) : (
              <>
                <IconButton label="Rotate current image 90 degrees clockwise"
                  icon={ICONS.rotate} disabled={busy} onPress={rotate} />
                <IconButton label="Delete current image" icon={ICONS.delete} destructive disabled={busy}
                  onPress={deletePhoto} />
                <IconButton label="Save edits and return to batch camera" icon={ICONS.check}
                  primary disabled={busy} busy={isFinishing} onPress={finish} />
              </>
            )}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

function IconButton({
  label, icon, onPress, active = false, destructive = false, disabled = false, primary = false,
  success = false, busy = false,
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled, busy }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.iconButton, active && styles.iconActive,
        destructive && styles.iconDestructive, primary && styles.iconPrimary,
        success && styles.iconSuccess,
        pressed && styles.pressed, disabled && styles.disabled]}>
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <SymbolView name={icon} size={22}
          tintColor={primary || success ? '#FFFFFF'
            : destructive ? '#C2415A' : active ? '#FFFFFF' : '#31517F'} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  safeArea: { flex: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 46 },
  headerSpacer: { width: 46 },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2 },
  headerTitle: { color: '#13243E', fontSize: 18, lineHeight: 24, fontWeight: '700', textAlign: 'center' },
  headerSubtitle: { color: '#7B879A', fontSize: 11, lineHeight: 16, textAlign: 'center' },
  canvas: { flex: 1, minHeight: 1, marginTop: 8 },
  applyingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center', justifyContent: 'center', gap: 8 },
  applyingText: { color: '#31517F', fontSize: 12, lineHeight: 18, fontWeight: '600' },
  stackCount: { color: '#526581', fontSize: 12, lineHeight: 16, fontWeight: '600',
    textAlign: 'center', marginTop: 10, fontVariant: ['tabular-nums'] },
  footer: { alignItems: 'center', gap: 12, paddingTop: 4 },
  dock: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  iconButton: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: '#EEF3FB',
    alignItems: 'center', justifyContent: 'center',
  },
  iconActive: { backgroundColor: '#3C78D8' },
  iconDestructive: { backgroundColor: '#FFF1F3' },
  iconSuccess: {
    backgroundColor: '#2F9E72',
    shadowColor: '#1F7A56', shadowOpacity: 0.22, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  iconPrimary: {
    backgroundColor: '#3C78D8',
    shadowColor: '#2A5EB0', shadowOpacity: 0.22, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
