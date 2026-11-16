import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  reset: { ios: 'arrow.counterclockwise', android: 'restart_alt', web: 'restart_alt' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  delete: { ios: 'trash', android: 'delete', web: 'delete' },
};

export function BatchEditor({
  photos, editsById, renderedPhotosById, onCommitEdits, selectedIndex, onSelect,
  onBack, onDone, onDelete, isApplying,
}) {
  const editorRef = useRef(null);
  const actionRef = useRef(false);
  const rotationQueueRef = useRef(null);
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
  const displayPreview = frozenPreview ?? preview;
  const effectiveEdits = optimisticEdits ? { ...editsById, [id]: optimisticEdits } : editsById;
  const displayPhotos = photos.map((item, index) => index === activeIndex
    ? displayPreview : renderedPhotosById[getBatchPhotoId(item)] ?? item);
  const editedCount = photos.filter((item) => {
    const value = effectiveEdits[getBatchPhotoId(item)];
    return value?.rotation || hasCustomCrop(value?.corners);
  }).length;
  const busy = isApplying || isFinishing;
  const previewRotation = (optimisticEdits?.rotation ?? edits?.rotation ?? 0) -
    (displayPreview.sourcePhoto ? displayPreview.edits?.rotation ?? 0 : 0);
  const previewStyle = getBatchRotationPreviewStyle(displayPreview, previewRotation, frame);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rotationQueueRef.current?.dispose();
      rotationQueueRef.current = null;
    };
  }, []);

  const getRotationQueue = () => {
    if (!rotationQueueRef.current) {
      rotationQueueRef.current = createRotationSaveQueue({
        save: (next, { isCurrent }) => commitRef.current(photo, next, { background: true, isCurrent }),
      });
    }
    return rotationQueueRef.current;
  };

  const commitEdits = () => {
    const next = editorRef.current?.getEdits();
    return next ? onCommitEdits(photo, next) : Promise.resolve(true);
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
    if (index === activeIndex) return;
    return runAction(async () => {
      if (!await saveBeforeLeaving()) return;
      setIsCropping(false);
      onSelect(index);
    });
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
    setFrozenPreview((current) => current ?? preview);
    setOptimisticEdits(next);
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
              viewportPadding={isCropping ? 28 : 0}
            />
          </View>
          <Image
            source={displayPreview.uri}
            pointerEvents="none"
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={0}
            accessible={false}
            style={[previewStyle, { opacity: isCropping ? 0 : 1 }]}
          />
          {isApplying && (
            <View style={styles.applyingOverlay} accessibilityLiveRegion="polite">
              <ActivityIndicator color="#3C78D8" />
              <ThemedText style={styles.applyingText}>Applying edit…</ThemedText>
            </View>
          )}
        </View>

        <BatchFilmstrip photos={displayPhotos} editsById={effectiveEdits}
          selectedIndex={activeIndex} onSelect={selectPhoto}
          disabled={busy} compact={compact} />

        <View style={styles.footer}>
          {isCropping && (
            <View style={styles.cropActions}>
              <IconButton label="Reset crop to full image" icon={ICONS.reset}
                disabled={busy} onPress={() => { if (!actionRef.current) editorRef.current?.reset(); }} />
              <Pressable accessibilityRole="button" accessibilityLabel="Apply crop to current image"
                disabled={busy}
                onPress={applyCrop}
                style={({ pressed }) => [styles.apply, pressed && styles.pressed, busy && styles.disabled]}>
                <SymbolView name={ICONS.check} size={18} tintColor="#FFFFFF" />
                <ThemedText style={styles.applyText}>Apply crop</ThemedText>
              </Pressable>
            </View>
          )}
          <View style={styles.dock}>
            <IconButton label={isCropping ? 'Cancel crop changes' : 'Crop current image'}
              icon={ICONS.crop} active={isCropping} disabled={busy} onPress={openCrop} />
            <IconButton label="Rotate current image 90 degrees clockwise"
              icon={ICONS.rotate} disabled={busy} onPress={rotate} />
            <IconButton label="Delete current image" icon={ICONS.delete} destructive disabled={busy}
              onPress={deletePhoto} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save edits and return to batch camera"
            accessibilityHint="Keeps the crop and rotation of every image so you can continue scanning."
            disabled={busy}
            onPress={finish}
            style={({ pressed }) => [styles.doneButton, pressed && styles.pressed, busy && styles.disabled]}>
            {isFinishing ? <ActivityIndicator color="#FFFFFF" /> :
              <SymbolView name={ICONS.check} size={30} tintColor="#FFFFFF" />}
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function IconButton({ label, icon, onPress, active = false, destructive = false, disabled = false }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.iconButton, active && styles.iconActive,
        destructive && styles.iconDestructive, pressed && styles.pressed, disabled && styles.disabled]}>
      <SymbolView name={icon} size={22}
        tintColor={destructive ? '#C2415A' : active ? '#FFFFFF' : '#31517F'} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  safeArea: { flex: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 },
  headerSpacer: { width: 44 },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2 },
  headerTitle: { color: '#13243E', fontSize: 18, lineHeight: 24, fontWeight: '700', textAlign: 'center' },
  headerSubtitle: { color: '#7B879A', fontSize: 11, lineHeight: 16, textAlign: 'center' },
  canvas: { flex: 1, minHeight: 1, marginTop: 12 },
  applyingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center', justifyContent: 'center', gap: 8 },
  applyingText: { color: '#31517F', fontSize: 12, lineHeight: 18, fontWeight: '600' },
  footer: { alignItems: 'center', gap: 12, paddingTop: 8 },
  dock: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  cropActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconButton: { width: 44, height: 44, borderRadius: 15, backgroundColor: '#EEF3FB', alignItems: 'center', justifyContent: 'center' },
  iconActive: { backgroundColor: '#3C78D8' },
  iconDestructive: { backgroundColor: '#FFF1F3' },
  apply: { minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 6, borderRadius: 15, backgroundColor: '#3C78D8' },
  applyText: { color: '#FFFFFF', fontSize: 12, lineHeight: 17, fontWeight: '700' },
  doneButton: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: '#3C78D8',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#2A5EB0', shadowOpacity: 0.22, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
