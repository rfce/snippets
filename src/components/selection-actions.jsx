import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';

const ICON_COLOR = '#F5F5F5';
const BUTTON_COLORS = {
  share: '#2563EB',
  pdf: '#18794E',
  delete: '#C43D4A',
};

export const SelectionActionBar = memo(function SelectionActionBar({
  bottomInset, disabled, pdfDisabled, pdfProgress, onDelete, onShare, onSavePdf,
}) {
  const busy = Boolean(pdfProgress);

  return (
    <View pointerEvents="box-none" style={[styles.dock, { paddingBottom: bottomInset + Spacing.two }]}>
      <SelectionActionButton
        label="Share selected images"
        disabled={disabled}
        color={BUTTON_COLORS.share}
        onPress={onShare}>
        <SymbolView
          name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
          size={27}
          tintColor={ICON_COLOR}
        />
      </SelectionActionButton>
      <SelectionActionButton
        label={busy
          ? 'Creating PDF, ' + pdfProgress.completed + ' of ' + pdfProgress.total + ' images'
          : 'Save selected images as PDF'}
        disabled={disabled || pdfDisabled}
        busy={busy}
        color={BUTTON_COLORS.pdf}
        onPress={onSavePdf}>
        <Text
          accessible={false}
          allowFontScaling={false}
          numberOfLines={1}
          style={styles.pdfMark}>
          PDF
        </Text>
      </SelectionActionButton>
      <SelectionActionButton
        label="Delete selected images"
        disabled={disabled}
        color={BUTTON_COLORS.delete}
        onPress={onDelete}>
        <SymbolView
          name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
          size={27}
          tintColor={ICON_COLOR}
        />
      </SelectionActionButton>
    </View>
  );
});

const SelectionActionButton = memo(function SelectionActionButton({
  label, disabled, busy = false, color, onPress, children,
}) {
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
        { backgroundColor: color },
        disabled && !busy && styles.disabledButton,
        pressed && !disabled && styles.buttonPressed,
      ]}>
      <View pointerEvents="none" style={styles.icon}>
        {busy ? <ActivityIndicator color={ICON_COLOR} /> : children}
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
    direction: 'ltr',
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
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pdfMark: {
    width: 36,
    color: ICON_COLOR,
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 24,
    letterSpacing: 0.3,
    textAlign: 'center',
    includeFontPadding: false,
  },
  buttonPressed: {
    transform: [{ scale: 0.94 }],
  },
  disabledButton: {
    backgroundColor: '#596579',
    shadowOpacity: 0.08,
    elevation: 2,
  },
});
