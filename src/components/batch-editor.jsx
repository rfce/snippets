import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BatchFilmstrip } from '@/components/batch-filmstrip';
import { CropEditor } from '@/components/capture-review';
import { ThemedText } from '@/components/themed-text';
import { getBatchPhotoId } from '@/batch-workflow';
import { hasCustomCrop } from '@/crop-geometry';

const ICONS = {
  back: { ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' },
  crop: { ios: 'crop', android: 'crop', web: 'crop' },
  rotate: { ios: 'rotate.right', android: 'rotate_right', web: 'rotate_right' },
  reset: { ios: 'arrow.counterclockwise', android: 'restart_alt', web: 'restart_alt' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  next: { ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' },
};

export function BatchEditor({
  photos, editsById, onEditsChange, selectedIndex, onSelect,
  onBack, onNext, isPreparing, preparationProgress,
}) {
  const editorRef = useRef(null);
  const { height, fontScale } = useWindowDimensions();
  const compact = height < 740 || fontScale > 1.2;
  const [isCropping, setIsCropping] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const photo = photos[selectedIndex] ?? photos[0];
  const id = getBatchPhotoId(photo);
  const edits = editsById[id];
  const edited = Boolean(edits?.rotation || hasCustomCrop(edits?.corners));
  const editedCount = photos.filter((item) => {
    const value = editsById[getBatchPhotoId(item)];
    return value?.rotation || hasCustomCrop(value?.corners);
  }).length;

  const commitEdits = () => {
    const next = editorRef.current?.getEdits();
    const snapshot = next ? { ...editsById, [id]: next } : editsById;
    onEditsChange(snapshot);
    return snapshot;
  };

  const cancelCrop = useCallback(() => {
    // Remount from the last applied snapshot; a cancelled drag never changes it.
    setIsCropping(false);
    setEditorRevision((value) => value + 1);
  }, []);

  const goBack = useCallback(() => {
    if (isPreparing) return;
    if (isCropping) cancelCrop();
    else onBack();
  }, [cancelCrop, isCropping, isPreparing, onBack]);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack]));

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <IconButton label={isCropping ? 'Cancel crop changes' : 'Return to batch camera'}
            icon={ICONS.back} onPress={goBack} disabled={isPreparing} />
          <View style={styles.steps}>
            <View style={styles.step}>
              <View style={styles.stepDot}><ThemedText style={styles.stepNumber}>1</ThemedText></View>
              <ThemedText style={styles.stepActive}>Frame</ThemedText>
            </View>
            <View style={styles.stepLine} />
            <View style={styles.step}>
              <View style={styles.stepDotMuted}><ThemedText style={styles.stepNumberMuted}>2</ThemedText></View>
              <ThemedText style={styles.stepMuted}>Enhance</ThemedText>
            </View>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        {!compact && <View style={styles.intro}>
          <ThemedText style={styles.title}>Frame your stack</ThemedText>
          <ThemedText style={styles.subtitle}>A perfect fit for every snippet.</ThemedText>
        </View>}

        {!compact && <View style={styles.imageCaption}>
          <ThemedText style={styles.imageTitle}>Image {selectedIndex + 1}</ThemedText>
          <View style={[styles.status, isCropping && styles.statusActive]}>
            <View style={[styles.statusDot, (edited || isCropping) && styles.statusDotActive]} />
            <ThemedText style={styles.statusText}>
              {isCropping ? 'Fine-tuning' : edited ? 'Framing saved' : 'Original frame'}
            </ThemedText>
          </View>
        </View>}

        <View style={styles.canvas}>
          <CropEditor
            key={`${id}:${editorRevision}`}
            ref={editorRef}
            photo={photo}
            initialEdits={edits}
            disabled={isPreparing}
            showCropHandles={isCropping}
          />
          {isPreparing && (
            <View style={styles.preparingOverlay} accessibilityLiveRegion="polite">
              <ActivityIndicator color="#FFFFFF" size="large" />
              <ThemedText style={styles.preparingText}>Preparing your stack</ThemedText>
              <ThemedText style={styles.preparingCount}>{preparationProgress} / {photos.length}</ThemedText>
            </View>
          )}
        </View>

        <View style={styles.dock}>
          <IconButton label={isCropping ? 'Cancel crop changes' : 'Crop current image'}
            icon={ICONS.crop} active={isCropping} disabled={isPreparing}
            onPress={() => { if (isCropping) cancelCrop(); else setIsCropping(true); }} />
          <IconButton label="Rotate current image 90 degrees clockwise"
            icon={ICONS.rotate} disabled={isPreparing}
            onPress={() => { editorRef.current?.rotate(); if (!isCropping) commitEdits(); }} />
          {isCropping ? (
            <>
              <IconButton label="Reset crop to full image" icon={ICONS.reset}
                disabled={isPreparing} onPress={() => editorRef.current?.reset()} />
              <Pressable accessibilityRole="button" accessibilityLabel="Apply crop to current image"
                disabled={isPreparing}
                onPress={() => { commitEdits(); setIsCropping(false); }}
                style={({ pressed }) => [styles.apply, pressed && styles.pressed]}>
                <SymbolView name={ICONS.check} size={18} tintColor="#FFFFFF" />
                <ThemedText style={styles.applyText}>Apply crop</ThemedText>
              </Pressable>
            </>
          ) : (
            <ThemedText style={styles.dockHint}>Your originals stay intact</ThemedText>
          )}
        </View>
        <ThemedText numberOfLines={compact ? 1 : 2} style={[styles.hint, compact && styles.compactHint]}>
          {isCropping ? 'Drag a handle for a magnified view. Tap the crop icon to cancel.'
            : 'Tap crop to fine-tune. Tap a thumbnail to switch images.'}
        </ThemedText>

        <BatchFilmstrip photos={photos} editsById={editsById}
          selectedIndex={selectedIndex} onSelect={onSelect} disabled={isPreparing || isCropping}
          compact={compact} showCaption={!compact} />

        <Pressable accessibilityRole="button" accessibilityLabel="Next, review and enhance batch"
          accessibilityState={{ disabled: isPreparing || isCropping }}
          disabled={isPreparing || isCropping}
          onPress={() => onNext(commitEdits())}
          style={({ pressed }) => [styles.next, pressed && styles.pressed,
            (isPreparing || isCropping) && styles.disabled]}>
          <View style={styles.nextCopy}>
            <ThemedText style={styles.nextTitle}>{isPreparing ? 'Preparing…' : 'Next'}</ThemedText>
            <ThemedText style={styles.nextSubtitle}>
              {isCropping ? 'Apply your crop to continue' : `${photos.length} ${photos.length === 1 ? 'image' : 'images'} · ${editedCount} framed`}
            </ThemedText>
          </View>
          {isPreparing ? <ActivityIndicator color="#FFFFFF" /> : (
            <View style={styles.nextArrow}><SymbolView name={ICONS.next} size={22} tintColor="#FFFFFF" /></View>
          )}
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

function IconButton({ label, icon, onPress, active = false, disabled = false }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.iconButton, active && styles.iconActive,
        pressed && styles.pressed, disabled && styles.disabled]}>
      <SymbolView name={icon} size={22} tintColor={active ? '#FFFFFF' : '#31517F'} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  safeArea: { flex: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 },
  headerSpacer: { width: 44 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepDot: { width: 21, height: 21, borderRadius: 11, backgroundColor: '#3C78D8', alignItems: 'center', justifyContent: 'center' },
  stepDotMuted: { width: 21, height: 21, borderRadius: 11, backgroundColor: '#EDF1F7', alignItems: 'center', justifyContent: 'center' },
  stepNumber: { color: '#FFFFFF', fontSize: 11, lineHeight: 16, fontWeight: '700' },
  stepNumberMuted: { color: '#8795AA', fontSize: 11, lineHeight: 16, fontWeight: '700' },
  stepActive: { color: '#31517F', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  stepMuted: { color: '#8795AA', fontSize: 12, lineHeight: 18 },
  stepLine: { width: 20, height: 1, backgroundColor: '#DCE4F0' },
  intro: { paddingTop: 12, paddingBottom: 12, gap: 3 },
  title: { color: '#13243E', fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.7 },
  subtitle: { color: '#7B879A', fontSize: 13, lineHeight: 18 },
  imageCaption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  imageTitle: { color: '#526581', fontSize: 12, lineHeight: 18, fontWeight: '600' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#F1F5FA' },
  statusActive: { backgroundColor: '#EAF1FF' },
  statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#A2AFC1' },
  statusDotActive: { backgroundColor: '#3C78D8' },
  statusText: { color: '#526581', fontSize: 10, lineHeight: 14, fontWeight: '600' },
  canvas: { flex: 1, minHeight: 1, backgroundColor: '#F3F6FB', borderRadius: 24,
    borderWidth: 1, borderColor: '#E4EBF5', overflow: 'hidden' },
  preparingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(19,36,62,0.84)',
    alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 20 },
  preparingText: { color: '#FFFFFF', fontSize: 17, lineHeight: 24, fontWeight: '600' },
  preparingCount: { color: '#CFDDF3', fontSize: 13, lineHeight: 18 },
  dock: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  iconButton: { width: 44, height: 44, borderRadius: 15, backgroundColor: '#EEF3FB', alignItems: 'center', justifyContent: 'center' },
  iconActive: { backgroundColor: '#3C78D8' },
  dockHint: { flex: 1, color: '#8795AA', fontSize: 11, lineHeight: 16, textAlign: 'right' },
  apply: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, borderRadius: 15, backgroundColor: '#3C78D8', paddingHorizontal: 8 },
  applyText: { color: '#FFFFFF', fontSize: 12, lineHeight: 17, fontWeight: '700', flexShrink: 1 },
  hint: { color: '#7B879A', fontSize: 11, lineHeight: 16, marginTop: 7, minHeight: 32 },
  compactHint: { minHeight: 16 },
  next: { minHeight: 62, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#3C78D8' },
  nextCopy: { flex: 1, gap: 2 },
  nextTitle: { color: '#FFFFFF', fontSize: 17, lineHeight: 22, fontWeight: '700' },
  nextSubtitle: { color: '#DCE8FF', fontSize: 11, lineHeight: 16 },
  nextArrow: { width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
