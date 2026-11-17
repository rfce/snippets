import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getBatchPhotoId } from '@/batch-workflow';
import { BatchFilmstrip } from '@/components/batch-filmstrip';
import {
  FinishHeader, FinishPalette, PhotoCard, PhotoCardBadge, PhotoCardChip, finishStyles, getPhotoCardRect,
} from '@/components/photo-card';
import { FinishSelector, InvertAdjustments } from '@/components/preview-filters';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getNeighbourIndices, useSwipeTrack } from '@/hooks/use-swipe-track';
import { PREVIEW_FILTER_OPTIONS } from '@/invert-settings';

const ACCENT = FinishPalette.accent;
const DISCARD_ACCENT = FinishPalette.discard;
const SAVE_ACCENT = FinishPalette.save;
const BACKGROUND = FinishPalette.background;
const CANVAS = FinishPalette.canvas;
const BORDER = FinishPalette.border;
const HEADING = FinishPalette.heading;
const MUTED = FinishPalette.muted;

/**
 * Batch Review, "Choose your finish". Processing state and results are owned
 * by the parent (useBatchFinishes), so this screen is purely presentational
 * and can unmount and remount without losing any processed image.
 */
export function BatchReviewScreen({
  photos,
  displayedPhotos,
  statuses,
  mode,
  onModeChange,
  invertSettings,
  onInvertSettingsChange,
  currentIndex,
  onIndexChange,
  completed,
  failed,
  total,
  isProcessing,
  canSave,
  onRetryFailed,
  isSaving,
  saveProgress,
  onBack,
  onDiscard,
  onSave,
}) {
  const { height } = useWindowDimensions();
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [compareMode, setCompareMode] = useState(null);
  const count = photos.length;
  const index = Math.max(0, Math.min(currentIndex, count - 1));
  const hasSavedImages = saveProgress.completed > 0;
  const changesLocked = isSaving || hasSavedImages;
  const finishLabel = PREVIEW_FILTER_OPTIONS.find((option) => option.value === mode)?.label ?? 'Original';
  const currentStatus = statuses[index] ?? null;
  const canCompare = mode !== 'original' && currentStatus === 'done' && !isSaving;
  const comparing = Boolean(compareMode) && canCompare;

  // A new finish starts from the filtered view, like the single-image Preview.
  useEffect(() => { setCompareMode(null); }, [mode]);

  const selectIndex = useCallback((next) => {
    if (next < 0 || next >= count) return false;
    setCompareMode((current) => (current === 'hold' ? null : current));
    if (next !== index) onIndexChange(next);
    return true;
  }, [count, index, onIndexChange]);

  const { trackX, panHandlers } = useSwipeTrack({
    count,
    activeIndex: index,
    frameWidth: frame.width,
    disabled: isSaving,
    onSelect: selectIndex,
    // Supplying a hold handler makes the track claim touches immediately, so
    // only enable it when there is something to compare against.
    onHoldStart: mode !== 'original' ? () => {
      if (canCompare) setCompareMode('hold');
    } : undefined,
    onHoldEnd: () => setCompareMode((current) => (current === 'hold' ? null : current)),
  });

  const slides = frame.width > 0 && frame.height > 0
    ? getNeighbourIndices(index, count).map((slideIndex) => ({
      index: slideIndex,
      id: getBatchPhotoId(photos[slideIndex]),
      photo: displayedPhotos[slideIndex] ?? photos[slideIndex],
      original: photos[slideIndex],
      finished: statuses[slideIndex] === 'done',
      // Finishes keep the page's shape, so the unfiltered photo sizes the card
      // and switching finish never resizes it.
      rect: getPhotoCardRect(photos[slideIndex], frame),
    }))
    : [];
  const thumbnailSize = height >= 740 ? 88 : 76;

  const handleAccessibilityAction = (event) => {
    if (event.nativeEvent.actionName === 'increment') selectIndex(index + 1);
    else if (event.nativeEvent.actionName === 'decrement') selectIndex(index - 1);
  };

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <FinishHeader
          title="Review"
          subtitle={`${count} ${count === 1 ? 'image' : 'images'} · Choose your finish`}
          onBack={onBack}
          backLabel="Return to batch camera"
          backDisabled={changesLocked}
          compareActive={comparing && compareMode === 'toggle'}
          compareDisabled={!canCompare}
          onCompare={() => setCompareMode((current) => (current === 'toggle' ? null : 'toggle'))}
        />

        <View
          style={styles.imageFrame}
          onLayout={({ nativeEvent: { layout } }) => {
            setFrame((current) => (current.width === layout.width && current.height === layout.height
              ? current : { width: layout.width, height: layout.height }));
          }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Image ${index + 1} of ${count}, ${comparing ? 'original' : finishLabel}`}
          accessibilityHint={[
            count > 1 ? 'Swipe left or right to see other images.' : null,
            canCompare ? 'Hold to compare with the original.' : null,
          ].filter(Boolean).join(' ') || undefined}
          accessibilityActions={count > 1 ? [{ name: 'increment' }, { name: 'decrement' }] : undefined}
          onAccessibilityAction={handleAccessibilityAction}
          {...panHandlers}>
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { transform: [{ translateX: trackX }] }]}>
            {slides.map((slide) => {
              const isActive = slide.index === index;
              const status = statuses[slide.index] ?? null;
              return (
                <View
                  key={`slide:${slide.id}`}
                  style={[StyleSheet.absoluteFill, { transform: [{ translateX: slide.index * frame.width }] }]}>
                  <PhotoCard
                    rect={slide.rect}
                    overlay={isActive ? (
                      <>
                        {comparing ? <PhotoCardBadge /> : null}
                        {mode !== 'original' && (status === 'queued' || status === 'processing')
                          ? <PhotoCardChip label={`Applying ${finishLabel}`} /> : null}
                        {mode !== 'original' && status === 'error'
                          ? <PhotoCardChip error label={`${finishLabel} could not be applied to this image`} /> : null}
                      </>
                    ) : null}>
                    {/* A stable recyclingKey keeps the previous pixels on screen
                        until a newly finished result has decoded, so it
                        crossfades in. The card already has the image's aspect
                        ratio, so cover only absorbs sub-pixel rounding. */}
                    <Image
                      source={slide.photo.uri}
                      contentFit="cover"
                      recyclingKey={slide.id}
                      cachePolicy="memory-disk"
                      transition={slide.finished ? 160 : 0}
                      accessible={false}
                      style={StyleSheet.absoluteFill}
                    />
                    {isActive && slide.finished ? (
                      // Kept mounted under the finished image so comparing is instant.
                      <Image
                        source={slide.original.uri}
                        contentFit="cover"
                        recyclingKey={`original:${slide.id}`}
                        cachePolicy="memory-disk"
                        transition={0}
                        accessible={false}
                        style={[StyleSheet.absoluteFill, { opacity: comparing ? 1 : 0 }]}
                      />
                    ) : null}
                  </PhotoCard>
                </View>
              );
            })}
          </Animated.View>
        </View>

        <ReviewStatusRow
          mode={mode}
          finishLabel={finishLabel}
          isProcessing={isProcessing}
          completed={completed}
          failed={failed}
          total={total}
          compareMode={comparing ? compareMode : null}
          canRetry={!changesLocked}
          onRetryFailed={onRetryFailed}
        />

        <BatchFilmstrip
          photos={displayedPhotos}
          statuses={statuses}
          selectedIndex={index}
          onSelect={selectIndex}
          disabled={isSaving}
          showCaption={false}
          size={thumbnailSize}
        />

        {hasSavedImages && (
          <View style={styles.saveNotice} accessibilityLiveRegion="polite">
            <ThemedText style={styles.saveNoticeText}>
              {saveProgress.completed} of {count} saved. Retry saves only the remaining images.
            </ThemedText>
          </View>
        )}

        <FinishSelector mode={mode} disabled={changesLocked} onModeChange={onModeChange} />

        <InvertAdjustments
          visible={mode === 'invert'}
          invertSettings={invertSettings}
          onInvertSettingsChange={onInvertSettingsChange}
          disabled={changesLocked}
        />

        <View style={styles.actions}>
          <Pressable
            accessibilityLabel={hasSavedImages ? 'Discard unsaved images' : 'Discard batch'}
            accessibilityRole="button"
            disabled={isSaving}
            onPress={onDiscard}
            style={({ pressed }) => [
              styles.action,
              styles.discardAction,
              pressed && styles.pressed,
              isSaving && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
              size={25}
              tintColor={DISCARD_ACCENT}
            />
            <ThemedText type="smallBold" style={styles.discardText}>
              {hasSavedImages ? 'Discard remaining' : 'Discard'}
            </ThemedText>
          </Pressable>

          <Pressable
            accessibilityLabel={hasSavedImages ? 'Save remaining batch images' : 'Save batch'}
            accessibilityRole="button"
            accessibilityState={{ disabled: isSaving || !canSave, busy: isSaving }}
            disabled={isSaving || !canSave}
            onPress={onSave}
            style={({ pressed }) => [
              styles.action,
              styles.saveAction,
              pressed && styles.pressed,
              (isSaving || !canSave) && styles.disabled,
            ]}>
            {isSaving ? (
              <ActivityIndicator color={BACKGROUND} />
            ) : (
              <SymbolView
                name={{ ios: 'arrow.down.circle.fill', android: 'download', web: 'download' }}
                size={25}
                tintColor={BACKGROUND}
              />
            )}
            <ThemedText type="smallBold" style={styles.saveText}>
              {isSaving ? `${saveProgress.completed} / ${count}`
                : hasSavedImages ? `Retry (${count - saveProgress.completed})` : 'Save'}
            </ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

// Fixed height, so switching between nothing (Original), progress, error and
// the compare hint never moves the image or the filmstrip.
function ReviewStatusRow({
  mode, finishLabel, isProcessing, completed, failed, total, compareMode, canRetry, onRetryFailed,
}) {
  let content = null;
  if (mode === 'original') {
    content = null;
  } else if (isProcessing) {
    // Never fully empty while working, so the bar reads as active from the start.
    const progress = total > 0 ? Math.max(0.04, completed / total) : 0.04;
    content = (
      <View style={styles.progressBlock}>
        <View style={styles.progressLine}>
          <ThemedText style={styles.progressLabel}>Applying {finishLabel}</ThemedText>
          <ThemedText style={styles.progressCount}>{completed} of {total}</ThemedText>
        </View>
        <ProgressBar progress={progress} completed={completed} total={total} />
      </View>
    );
  } else if (failed > 0) {
    content = (
      <View style={styles.progressLine}>
        <ThemedText style={styles.errorText}>
          {failed} {failed === 1 ? 'image' : 'images'} could not be enhanced
        </ThemedText>
        {canRetry ? (
          <Pressable
            accessibilityLabel={`Try ${finishLabel} again on the failed images`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onRetryFailed}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
            <ThemedText type="smallBold" style={styles.retryText}>Try again</ThemedText>
          </Pressable>
        ) : null}
      </View>
    );
  } else {
    content = (
      <ThemedText style={finishStyles.hintText}>
        {compareMode === 'hold' ? 'Original · Release to return'
          : compareMode === 'toggle' ? 'Original · Tap Compare to return'
            : 'Hold image to compare with original'}
      </ThemedText>
    );
  }
  return <View style={finishStyles.hintRow} accessibilityLiveRegion="polite">{content}</View>;
}

function ProgressBar({ progress, completed, total }) {
  const valueRef = useRef(null);
  if (!valueRef.current) valueRef.current = new Animated.Value(progress);
  useEffect(() => {
    const animation = Animated.timing(valueRef.current, {
      toValue: progress,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress]);
  return (
    <View
      style={styles.progressTrack}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: completed }}>
      <Animated.View
        style={[styles.progressFill, {
          width: valueRef.current.interpolate({
            inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp',
          }),
        }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BACKGROUND },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
  // Clips the swipe track only; each slide draws its own rounded card.
  imageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    overflow: 'hidden',
  },
  progressBlock: { gap: 6 },
  progressLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  progressLabel: { color: HEADING, fontSize: 12, lineHeight: 16, fontWeight: '600', flexShrink: 1 },
  progressCount: { color: MUTED, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: BORDER },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: ACCENT },
  errorText: { color: DISCARD_ACCENT, fontSize: 12, lineHeight: 16, flexShrink: 1 },
  retryButton: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: '#EEF4FF' },
  retryText: { color: ACCENT, fontSize: 12, lineHeight: 16 },
  saveNotice: { padding: 10, borderRadius: 12, backgroundColor: '#EAF6EF', marginBottom: Spacing.one },
  saveNoticeText: { color: '#28754F', fontSize: 12, lineHeight: 17 },
  actions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    marginTop: Spacing.two,
    marginHorizontal: -Spacing.four,
    marginBottom: -Spacing.three,
    backgroundColor: CANVAS,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DCE4ED',
  },
  action: {
    flex: 1,
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
  },
  discardAction: {
    backgroundColor: '#FFF5F6',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#F0C9CF',
  },
  saveAction: { backgroundColor: SAVE_ACCENT },
  discardText: { color: DISCARD_ACCENT, flexShrink: 1, textAlign: 'center' },
  saveText: { color: BACKGROUND, flexShrink: 1, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
