import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { INVERT_CLARITY_OPTIONS, PREVIEW_FILTER_OPTIONS } from '@/invert-settings';

export const PreviewFilters = memo(function PreviewFilters({
  selectedMode, onModeChange, invertSettings, onInvertSettingsChange, disabled,
}) {
  const scrollRef = useRef(null);
  const layoutsRef = useRef({});
  const [showAdjustments, setShowAdjustments] = useState(false);

  const revealFilter = useCallback((mode) => {
    const layout = layoutsRef.current[mode];
    if (layout) scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - 8), animated: true });
  }, []);

  useEffect(() => { revealFilter(selectedMode); }, [revealFilter, selectedMode]);

  const recordLayout = useCallback((mode, layout) => {
    layoutsRef.current[mode] = layout;
    if (mode === selectedMode) revealFilter(mode);
  }, [revealFilter, selectedMode]);

  const changeSetting = (patch) => {
    if (!disabled) onInvertSettingsChange({ ...invertSettings, ...patch });
  };

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        horizontal
        accessibilityLabel="Image filters"
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}>
        <View accessibilityRole="tablist" style={styles.pills}>
          {PREVIEW_FILTER_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              label={option.label}
              value={option.value}
              selected={selectedMode === option.value}
              disabled={disabled}
              dark={option.value === 'invert'}
              onLayout={recordLayout}
              onPress={(mode) => {
                onModeChange(mode);
                revealFilter(mode);
              }}
            />
          ))}
        </View>
      </ScrollView>

      {selectedMode === 'invert' ? (
        <View style={styles.invertPanel}>
          <Pressable
            accessibilityLabel="Adjust Invert"
            accessibilityRole="button"
            accessibilityState={{ expanded: showAdjustments }}
            onPress={() => setShowAdjustments((value) => !value)}
            style={({ pressed }) => [styles.adjustButton, pressed && styles.pressed]}>
            <View>
              <ThemedText type="smallBold" style={styles.panelTitle}>Adjust Invert</ThemedText>
              <ThemedText style={styles.summary}>
                {INVERT_CLARITY_OPTIONS.find((option) => option.value === invertSettings.inkClarity)?.label}
                {' · '}{invertSettings.warmInk ? 'Warm ink' : 'White ink'}
                {invertSettings.preserveAccents ? ' · Color accents' : ''}
              </ThemedText>
            </View>
            <SymbolView
              name={showAdjustments
                ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
                : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
              size={20}
              tintColor="#64748B"
            />
          </Pressable>
          {showAdjustments ? (
            <View style={styles.adjustments}>
              <ThemedText type="smallBold" style={styles.settingLabel}>Ink clarity</ThemedText>
              <View accessibilityRole="tablist" style={styles.clarityRow}>
                {INVERT_CLARITY_OPTIONS.map((option) => (
                  <FilterPill
                    key={option.value}
                    label={option.label}
                    value={option.value}
                    selected={invertSettings.inkClarity === option.value}
                    disabled={disabled}
                    dark
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
      ) : null}
    </View>
  );
});

const FilterPill = memo(function FilterPill({
  label, value, selected, disabled, dark = false, onPress, onLayout,
}) {
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
      onLayout={({ nativeEvent: { layout } }) => onLayout?.(value, layout)}
      onPress={() => onPress(value)}
      style={({ pressed }) => [styles.pill, pressed && styles.pressed, disabled && styles.disabled]}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.pillSelection, dark && styles.darkSelection,
          { opacity: animationRef.current }]}
      />
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        style={[styles.pillText, selected && styles.selectedText, selected && dark && styles.darkText]}>
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
        trackColor={{ false: '#CBD5E1', true: '#3C78D8' }}
        thumbColor="#FFFFFF"
        ios_backgroundColor="#CBD5E1"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', flexShrink: 0, marginTop: 8 },
  filterScroll: { flexGrow: 0, height: 56 },
  filterRow: { padding: 4, alignItems: 'center' },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { minHeight: 44, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center',
    borderRadius: 14, overflow: 'hidden', backgroundColor: '#E8EDF3' },
  pillSelection: { borderRadius: 14, backgroundColor: '#FFFFFF' },
  darkSelection: { backgroundColor: '#282E42' },
  pillText: { color: '#667085', fontSize: 13, lineHeight: 18 },
  selectedText: { color: '#122033' },
  darkText: { color: '#F5F5F5' },
  invertPanel: { marginTop: 4, borderRadius: 16, backgroundColor: '#EEF1F7' },
  adjustButton: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 6,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  panelTitle: { color: '#282E42' },
  summary: { fontSize: 11, lineHeight: 16, color: '#64748B' },
  adjustments: { paddingHorizontal: 12, paddingBottom: 8, gap: 6 },
  settingLabel: { fontSize: 12, color: '#475569' },
  clarityRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  switchLabel: { color: '#475569', fontSize: 13, flexShrink: 1 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 },
});
