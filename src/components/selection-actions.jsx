import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

// Adobe Acrobat Reader mark, bundled locally (Simple Icons 5.0.0, CC0).
const ACROBAT_MARK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#EC1C24"><path d="M23.63 15.3c-.71-.745-2.166-1.17-4.224-1.17-1.1 0-2.377.106-3.761.354a19.443 19.443 0 0 1-2.307-2.661c-.532-.71-.994-1.49-1.42-2.236.817-2.484 1.207-4.507 1.207-5.962 0-1.632-.603-3.336-2.342-3.336-.532 0-1.065.32-1.349.781-.78 1.384-.425 4.4.923 7.381a60.277 60.277 0 0 1-1.703 4.507c-.568 1.349-1.207 2.733-1.917 4.01C2.834 18.53.314 20.34.03 21.758c-.106.533.071 1.03.462 1.42.142.107.639.533 1.49.533 2.59 0 5.323-4.188 6.707-6.707 1.065-.355 2.13-.71 3.194-.994a34.963 34.963 0 0 1 3.407-.745c2.732 2.448 5.145 2.839 6.352 2.839 1.49 0 2.023-.604 2.2-1.1.32-.64.106-1.349-.213-1.704zm-1.42 1.03c-.107.532-.64.887-1.384.887-.213 0-.39-.036-.604-.071-1.348-.32-2.626-.994-3.903-2.059a17.717 17.717 0 0 1 2.98-.248c.746 0 1.385.035 1.81.142.497.106 1.278.426 1.1 1.348zm-7.524-1.668a38.01 38.01 0 0 0-2.945.674 39.68 39.68 0 0 0-2.52.745 40.05 40.05 0 0 0 1.207-2.555c.426-.994.78-2.023 1.136-2.981.354.603.745 1.207 1.135 1.739a50.127 50.127 0 0 0 1.987 2.378zM10.038 1.46a.768.768 0 0 1 .674-.425c.745 0 .887.851.887 1.526 0 1.135-.355 2.874-.958 4.861-1.03-2.768-1.1-5.074-.603-5.962zM6.134 17.997c-1.81 2.981-3.549 4.826-4.613 4.826a.872.872 0 0 1-.532-.177c-.213-.213-.32-.461-.249-.745.213-1.065 2.271-2.555 5.394-3.904Z"/></svg>'
);

function getNativeGlassView() {
  if (Platform.OS !== 'ios') return null;
  try {
    const glass = require('expo-glass-effect');
    return glass.isLiquidGlassAvailable?.() && glass.isGlassEffectAPIAvailable?.() ? glass.GlassView : null;
  } catch {
    return null;
  }
}

const NativeGlassView = getNativeGlassView();

export const SelectionActionBar = memo(function SelectionActionBar({
  bottomInset, disabled, pdfDisabled, pdfProgress, onDelete, onShare, onSavePdf, backgroundColor,
}) {
  const dark = backgroundColor === Colors.dark.background;
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    let active = true;
    Promise.resolve(AccessibilityInfo.isReduceTransparencyEnabled?.() ?? false)
      .then((value) => { if (active) setReduceTransparency(value); })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => { active = false; subscription?.remove(); };
  }, []);

  const busy = Boolean(pdfProgress);
  return (
    <View pointerEvents="box-none" style={[styles.dock, { paddingBottom: bottomInset + Spacing.two }]}>
      <GlassActionButton
        label="Delete selected images"
        disabled={disabled}
        dark={dark}
        reduceTransparency={reduceTransparency}
        onPress={onDelete}>
        <SymbolView
          name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
          size={27}
          tintColor={dark ? '#FF797F' : '#D92D20'}
        />
      </GlassActionButton>
      <GlassActionButton
        label="Share selected images"
        disabled={disabled}
        dark={dark}
        reduceTransparency={reduceTransparency}
        onPress={onShare}>
        <SymbolView
          name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
          size={27}
          tintColor={dark ? '#A1C7FF' : '#2563EB'}
        />
      </GlassActionButton>
      <GlassActionButton
        label={busy
          ? `Creating PDF, ${pdfProgress.completed} of ${pdfProgress.total} images`
          : 'Save selected images as PDF'}
        disabled={disabled || pdfDisabled}
        busy={busy}
        dark={dark}
        reduceTransparency={reduceTransparency}
        onPress={onSavePdf}>
        <Image
          accessible={false}
          contentFit="contain"
          source={ACROBAT_MARK}
          style={styles.pdfMark}
          transition={0}
        />
      </GlassActionButton>
    </View>
  );
});

const GlassActionButton = memo(function GlassActionButton({
  label, disabled, busy = false, dark, reduceTransparency, onPress, children,
}) {
  const nativeGlass = Boolean(NativeGlassView) && !reduceTransparency;
  const surface = reduceTransparency
    ? (dark ? '#202B3D' : '#F8FAFC')
    : (dark ? 'rgba(28, 39, 57, 0.78)' : 'rgba(255, 255, 255, 0.78)');

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), busy }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: nativeGlass ? 'transparent' : surface },
        pressed && !disabled && styles.buttonPressed,
      ]}>
      <View
        pointerEvents="none"
        style={[
          styles.surface,
          { borderColor: dark ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.9)' },
        ]}>
        {nativeGlass ? (
          <NativeGlassView
            style={StyleSheet.absoluteFill}
            glassEffectStyle="regular"
            colorScheme={dark ? 'dark' : 'light'}
            tintColor={dark ? 'rgba(28,39,57,0.25)' : 'rgba(255,255,255,0.22)'}
            isInteractive={false}
          />
        ) : null}
        <View style={[styles.sheen, dark && styles.darkSheen]} />
      </View>
      <View pointerEvents="none" style={[styles.icon, disabled && !busy && styles.disabledIcon]}>
        {busy ? <ActivityIndicator color={dark ? '#A1C7FF' : '#2563EB'} /> : children}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingTop: Spacing.two,
    zIndex: 20,
  },
  button: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  surface: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 32,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sheen: {
    position: 'absolute',
    top: 2,
    left: 7,
    right: 7,
    height: 22,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  darkSheen: {
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pdfMark: {
    width: 30,
    height: 30,
  },
  buttonPressed: {
    transform: [{ scale: 0.94 }],
  },
  disabledIcon: {
    opacity: 0.35,
  },
});
