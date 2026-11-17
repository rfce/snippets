import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { FinishPalette } from '@/components/photo-card';
import { ThemedText } from '@/components/themed-text';
import { INVERT_CLARITY_OPTIONS, PREVIEW_FILTER_OPTIONS } from '@/invert-settings';

// Icons hint at what each finish does; Invert keeps a dark selected state.
const FINISH_ICONS = {
  original: { ios: 'photo', android: 'image', web: 'image' },
  blackAndWhite: { ios: 'circle.lefthalf.filled', android: 'contrast', web: 'contrast' },
  magicColor: { ios: 'wand.and.stars', android: 'auto_fix_high', web: 'auto_fix_high' },
  invert: { ios: 'moon.fill', android: 'dark_mode', web: 'dark_mode' },
};

// Matches the horizontal padding of the Preview and Review screens, so the
// chip row can bleed to the screen edges and scroll out of view cleanly.
const SCREEN_INSET = 24;

/** Finish chips for the single Preview, followed by the Invert panel. */
export const PreviewFilters = memo(function PreviewFilters({
  selectedMode, onModeChange, invertSettings, onInvertSettingsChange, disabled,
}) {
  return (
    <View style={styles.container}>
      <FinishSelector mode={selectedMode} disabled={disabled} onModeChange={onModeChange} />
      <InvertAdjustments
        visible={selectedMode === 'invert'}
        invertSettings={invertSettings}
        onInvertSettingsChange={onInvertSettingsChange}
        disabled={disabled}
      />
    </View>
  );
});

/**
 * One row of rounded finish chips with icons. Labels never wrap; when the row
 * is wider than the screen it scrolls, and the selected chip is kept in view.
 */
export const FinishSelector = memo(function FinishSelector({
  mode, disabled, onModeChange, inset = SCREEN_INSET,
}) {
  const scrollRef = useRef(null);
  const layoutsRef = useRef({});
  const viewportWidthRef = useRef(0);

  const reveal = useCallback((value, animated = true) => {
    const layout = layoutsRef.current[value];
    const viewport = viewportWidthRef.current;
    if (!layout || !viewport) return;
    const centered = layout.x - (viewport - layout.width) / 2;
    scrollRef.current?.scrollTo({ x: Math.max(0, centered), animated });
  }, []);

  useEffect(() => { reveal(mode); }, [mode, reveal]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel="Finish"
      onLayout={({ nativeEvent: { layout } }) => { viewportWidthRef.current = layout.width; }}
      style={[styles.finishScroll, { marginHorizontal: -inset }]}
      contentContainerStyle={[styles.finishRow, { paddingHorizontal: inset }]}>
      {PREVIEW_FILTER_OPTIONS.map((option) => {
        const selected = mode === option.value;
        const dark = option.value === 'invert';
        return (
          <Pressable
            key={option.value}
            accessibilityLabel={option.label}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onLayout={({ nativeEvent: { layout } }) => {
              layoutsRef.current[option.value] = layout;
              if (selected) reveal(option.value, false);
            }}
            onPress={() => onModeChange(option.value)}
            style={({ pressed }) => [
              styles.finishChip,
              selected && (dark ? styles.finishChipSelectedDark : styles.finishChipSelected),
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}>
            <SymbolView
              name={FINISH_ICONS[option.value]}
              size={17}
              tintColor={selected ? FinishPalette.background : FinishPalette.text}
            />
            <ThemedText
              numberOfLines={1}
              allowFontScaling={false}
              style={[styles.finishChipText, selected && styles.finishChipTextSelected]}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
});

export const InvertAdjustments = memo(function InvertAdjustments({
  visible = true, invertSettings, onInvertSettingsChange, disabled,
}) {
  const [showAdjustments, setShowAdjustments] = useState(false);

  const changeSetting = (patch) => {
    if (!disabled) onInvertSettingsChange({ ...invertSettings, ...patch });
  };

  if (!visible) return null;

  return (
    <View style={styles.invertPanel}>
      <Pressable
        accessibilityLabel="Adjust Invert"
        accessibilityRole="button"
        accessibilityState={{ expanded: showAdjustments }}
        onPress={() => setShowAdjustments((value) => !value)}
        style={({ pressed }) => [styles.adjustButton, pressed && styles.pressed]}>
        <View style={styles.adjustIcon}>
          <SymbolView
            name={{ ios: 'slider.horizontal.3', android: 'tune', web: 'tune' }}
            size={16}
            tintColor={FinishPalette.background}
          />
        </View>
        <View style={styles.adjustText}>
          <ThemedText type="smallBold" style={styles.panelTitle}>Adjust Invert</ThemedText>
          <ThemedText numberOfLines={1} style={styles.summary}>
            {INVERT_CLARITY_OPTIONS.find((option) => option.value === invertSettings.inkClarity)?.label}
            {' · '}{invertSettings.warmInk ? 'Warm ink' : 'White ink'}
            {invertSettings.preserveAccents ? ' · Color accents' : ''}
          </ThemedText>
        </View>
        <SymbolView
          name={showAdjustments
            ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
            : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
          size={18}
          tintColor={FinishPalette.muted}
        />
      </Pressable>
      {showAdjustments ? (
        <View style={styles.adjustments}>
          <ThemedText type="smallBold" style={styles.settingLabel}>Ink clarity</ThemedText>
          <View accessibilityRole="tablist" style={styles.segmentTrack}>
            {INVERT_CLARITY_OPTIONS.map((option) => (
              <Segment
                key={option.value}
                label={option.label}
                value={option.value}
                selected={invertSettings.inkClarity === option.value}
                disabled={disabled}
                onPress={(inkClarity) => changeSetting({ inkClarity })}
              />
            ))}
          </View>
          <SettingSwitch
            label="Warm ink"
            value={invertSettings.warmInk}
            disabled={disabled}
            onValueChange={(warmInk) => changeSetting({ warmInk })}
          />
          <SettingSwitch
            label="Preserve color accents"
            value={invertSettings.preserveAccents}
            disabled={disabled}
            onValueChange={(preserveAccents) => changeSetting({ preserveAccents })}
          />
        </View>
      ) : null}
    </View>
  );
});

// One option of a segmented control; the selection fades in and out.
const Segment = memo(function Segment({ label, value, selected, disabled, onPress }) {
  const animationRef = useRef(null);
  if (!animationRef.current) animationRef.current = new Animated.Value(selected ? 1 : 0);

  useEffect(() => {
    const animation = Animated.timing(animationRef.current, {
      toValue: selected ? 1 : 0,
      duration: 150,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [selected]);

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={() => onPress(value)}
      style={({ pressed }) => [styles.segment, pressed && styles.pressed, disabled && styles.disabled]}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.segmentSelection, { opacity: animationRef.current }]}
      />
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        allowFontScaling={false}
        style={[styles.segmentText, selected && styles.segmentTextSelected]}>
        {label}
      </ThemedText>
    </Pressable>
  );
});

function SettingSwitch({ label, value, disabled, onValueChange }) {
  return (
    <View style={styles.switchRow}>
      <ThemedText style={styles.switchLabel}>{label}</ThemedText>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#CBD5E1', true: FinishPalette.accent }}
        thumbColor="#FFFFFF"
        ios_backgroundColor="#CBD5E1"
      />
    </View>
  );
}

const chipShadow = {
  shadowOpacity: 0.25,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 3 },
  elevation: 3,
};

const styles = StyleSheet.create({
  container: { width: '100%', flexShrink: 0 },
  // Vertical padding leaves room for the selected chip's shadow.
  finishScroll: { flexGrow: 0, marginTop: 4 },
  finishRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4, paddingBottom: 10 },
  finishChip: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 14,
    paddingRight: 18,
    borderRadius: 23,
    backgroundColor: FinishPalette.surface,
    borderWidth: 1,
    borderColor: FinishPalette.border,
  },
  finishChipSelected: {
    ...chipShadow,
    backgroundColor: FinishPalette.accent,
    borderColor: FinishPalette.accent,
    shadowColor: '#2A5EB0',
  },
  finishChipSelectedDark: {
    ...chipShadow,
    backgroundColor: FinishPalette.invertInk,
    borderColor: FinishPalette.invertInk,
    shadowColor: FinishPalette.invertInk,
  },
  finishChipText: { color: FinishPalette.text, fontSize: 14, lineHeight: 18, fontWeight: '600' },
  finishChipTextSelected: { color: FinishPalette.background },
  invertPanel: {
    borderRadius: 18,
    backgroundColor: FinishPalette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#DCE4ED',
    marginBottom: 4,
  },
  adjustButton: {
    minHeight: 56,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  adjustIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: FinishPalette.invertInk,
  },
  adjustText: { flex: 1 },
  panelTitle: { color: FinishPalette.invertInk },
  summary: { fontSize: 12, lineHeight: 16, color: FinishPalette.muted },
  adjustments: { paddingHorizontal: 12, paddingBottom: 10, gap: 8 },
  settingLabel: { fontSize: 12, color: '#475569' },
  segmentTrack: { flexDirection: 'row', padding: 3, gap: 3, borderRadius: 14, backgroundColor: '#E8EDF3' },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 11,
    overflow: 'hidden',
  },
  segmentSelection: { borderRadius: 11, backgroundColor: FinishPalette.invertInk },
  segmentText: { color: FinishPalette.muted, fontSize: 13, lineHeight: 18 },
  segmentTextSelected: { color: '#F5F5F5' },
  switchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  switchLabel: { color: '#475569', fontSize: 13, flexShrink: 1 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 },
});
