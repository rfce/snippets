import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';

const LABEL_COLOR = '#F5F5F5';
const DISABLED_COLOR = '#718096';
const TINTS = {
  share: '#91B9FF',
  pdf: '#74D7AD',
  delete: '#FFA0AB',
};

export const SelectionActionBar = memo(function SelectionActionBar({
  bottomInset = 0, disabled, pdfDisabled, pdfProgress, onDelete, onShare, onSavePdf,
}) {
  const busy = Boolean(pdfProgress);
  const pdfUnavailable = Boolean(disabled || pdfDisabled);
  const pdfTint = pdfUnavailable && !busy ? DISABLED_COLOR : TINTS.pdf;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, Spacing.one) }]}>
      <View style={styles.tabs}>
        <ActionTab
          title="Share"
          label="Share selected images"
          disabled={disabled}
          tint={TINTS.share}
          onPress={onShare}>
          <SymbolView
            name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
            size={25}
            tintColor={disabled ? DISABLED_COLOR : TINTS.share}
          />
        </ActionTab>
        <View pointerEvents="none" style={styles.divider} />
        <ActionTab
          title={busy ? 'PDF ' + pdfProgress.completed + '/' + pdfProgress.total : 'Save PDF'}
          label={busy
            ? 'Creating PDF, ' + pdfProgress.completed + ' of ' + pdfProgress.total + ' images'
            : 'Save selected images as PDF'}
          disabled={pdfUnavailable}
          busy={busy}
          tint={TINTS.pdf}
          onPress={onSavePdf}>
          <View style={[styles.pdfDocument, { borderColor: pdfTint }]}>
            <Text
              accessible={false}
              allowFontScaling={false}
              numberOfLines={1}
              style={[styles.pdfMark, { color: pdfTint }]}>
              PDF
            </Text>
          </View>
        </ActionTab>
        <View pointerEvents="none" style={styles.divider} />
        <ActionTab
          title="Delete"
          label="Delete selected images"
          disabled={disabled}
          tint={TINTS.delete}
          onPress={onDelete}>
          <SymbolView
            name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
            size={25}
            tintColor={disabled ? DISABLED_COLOR : TINTS.delete}
          />
        </ActionTab>
      </View>
    </View>
  );
});

const ActionTab = memo(function ActionTab({
  title, label, disabled, busy = false, tint, onPress, children,
}) {
  const unavailable = Boolean(disabled || busy);

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: unavailable, busy }}
      disabled={unavailable}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        pressed && !unavailable && styles.tabPressed,
      ]}>
      <View pointerEvents="none" style={styles.tabContent}>
        <View style={styles.icon}>
          {busy ? <ActivityIndicator accessible={false} color={tint} /> : children}
        </View>
        <Text
          numberOfLines={1}
          style={[styles.label, unavailable && !busy && styles.disabledLabel]}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#111B2B',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2B384D',
    zIndex: 20,
  },
  tabs: {
    width: '100%',
    maxWidth: 560,
    minHeight: 72,
    alignSelf: 'center',
    direction: 'ltr',
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  tab: {
    flex: 1,
    minHeight: 72,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.one,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPressed: {
    backgroundColor: '#203149',
  },
  tabContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  icon: {
    width: 34,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: LABEL_COLOR,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  disabledLabel: {
    color: DISABLED_COLOR,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: 15,
    backgroundColor: '#2B384D',
  },
  pdfDocument: {
    width: 30,
    height: 24,
    borderWidth: 1.2,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pdfMark: {
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 16,
    letterSpacing: 0.1,
    includeFontPadding: false,
    textAlign: 'center',
  },
});
