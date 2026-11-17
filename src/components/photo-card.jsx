import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { getImageViewport } from '@/crop-geometry';

// Shared visual language for the finish screens (single Preview and batch
// Review): a white page, images on rounded cards, quiet controls.
export const FinishPalette = {
  accent: '#3C78D8',
  discard: '#C2415A',
  save: '#2F9E72',
  background: '#FFFFFF',
  canvas: '#F5F7FA',
  surface: '#F7F9FC',
  border: '#E4EAF2',
  text: '#0F172A',
  heading: '#122033',
  muted: '#667085',
  invertInk: '#282E42',
};

const CARD_RADIUS = 20;

/**
 * The card takes the image's own aspect ratio inside `frame`, so the image
 * fills it edge to edge with rounded corners and no part of the page is cut.
 */
export function getPhotoCardRect(photo, frame) {
  const ratio = photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 3 / 4;
  return getImageViewport(frame, ratio, 0);
}

/**
 * Rounded image card. `children` are the image layers; `overlay` is drawn
 * above the outline (badges and chips).
 */
export function PhotoCard({ rect, children, overlay }) {
  return (
    <View pointerEvents="none" style={[styles.card, rect]}>
      {children}
      {/* Drawn above the image so light pages keep a visible edge. */}
      <View style={styles.cardOutline} />
      {overlay}
    </View>
  );
}

export function PhotoCardBadge({ label = 'Original' }) {
  return (
    <View style={styles.badge}>
      <ThemedText type="smallBold" style={styles.badgeText}>{label}</ThemedText>
    </View>
  );
}

export function PhotoCardChip({ label, error = false }) {
  return (
    <View style={[styles.chip, error && styles.chipError]}>
      {error ? null : <ActivityIndicator size="small" color={FinishPalette.accent} />}
      <ThemedText numberOfLines={error ? 2 : 1} style={[styles.chipText, error && styles.chipErrorText]}>
        {label}
      </ThemedText>
    </View>
  );
}

/**
 * Header with a back button, centred title and subtitle, and a Compare
 * toggle that fills with the accent while it is on. Either button can be
 * left out (omit `onBack` / `onCompare`); its space is kept so the title
 * stays centred on every step of the flow.
 */
export function FinishHeader({
  title, subtitle, onBack, backLabel, backDisabled = false,
  compareActive = false, compareDisabled = false, onCompare,
}) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          accessibilityLabel={backLabel}
          accessibilityRole="button"
          disabled={backDisabled}
          onPress={onBack}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed, backDisabled && styles.disabled]}>
          <SymbolView
            name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
            size={22}
            tintColor={FinishPalette.text}
          />
        </Pressable>
      ) : <View style={styles.headerButton} />}
      <View style={styles.heading}>
        <ThemedText type="title" style={styles.title}>{title}</ThemedText>
        {subtitle ? <ThemedText style={styles.subtitle}>{subtitle}</ThemedText> : null}
      </View>
      {onCompare ? (
        <Pressable
          accessibilityLabel={compareActive ? 'Show finished image' : 'Compare with original'}
          accessibilityRole="button"
          accessibilityState={{ selected: compareActive, disabled: compareDisabled }}
          disabled={compareDisabled}
          onPress={onCompare}
          style={({ pressed }) => [
            styles.headerButton,
            compareActive && styles.headerButtonActive,
            pressed && styles.pressed,
            compareDisabled && styles.disabled,
          ]}>
          <SymbolView
            name={{ ios: 'square.on.square', android: 'compare', web: 'compare' }}
            size={21}
            tintColor={compareActive ? FinishPalette.background : FinishPalette.text}
          />
        </Pressable>
      ) : <View style={styles.headerButton} />}
    </View>
  );
}

export const finishStyles = StyleSheet.create({
  // Reserved below the image so hints appearing or clearing never resize it.
  hintRow: { height: 34, justifyContent: 'center', marginTop: 4 },
  hintText: { color: FinishPalette.muted, fontSize: 12, lineHeight: 16, textAlign: 'center' },
});

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: CARD_RADIUS,
    backgroundColor: FinishPalette.canvas,
  },
  cardOutline: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(15, 23, 42, 0.14)',
  },
  badge: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
  },
  badgeText: { color: FinishPalette.background, fontSize: 12, lineHeight: 16 },
  chip: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    maxWidth: '88%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderWidth: 1,
    borderColor: FinishPalette.border,
  },
  chipText: { color: FinishPalette.heading, fontSize: 12, lineHeight: 16, fontWeight: '600', flexShrink: 1 },
  chipError: { backgroundColor: '#FFF5F6', borderColor: '#F0C9CF' },
  chipErrorText: { color: FinishPalette.discard },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  headerButtonActive: { backgroundColor: FinishPalette.accent },
  heading: { flex: 1 },
  title: {
    color: FinishPalette.heading,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '600',
    letterSpacing: 0.35,
    textAlign: 'center',
  },
  subtitle: { color: FinishPalette.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
