import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { backgroundSaves } from '@/background-saves';
import { ThemedText } from '@/components/themed-text';

const DONE_VISIBLE_MS = 1600;
// Below the camera's centred heading, clear of the Close and Flash buttons.
const TOP_OFFSET = 64;

/**
 * Small status pill for background saves, shown above every screen. It never
 * takes touches, so the camera's tap-to-focus and the library keep working
 * underneath it. Failures are handled by the queue's retry alert instead.
 */
export function SaveStatusPill() {
  const snapshot = useSyncExternalStore(backgroundSaves.subscribe, backgroundSaves.getSnapshot);
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const [doneLabel, setDoneLabel] = useState(null);
  const [content, setContent] = useState(null);

  const active = snapshot.jobs.filter((job) => job.status === 'queued' || job.status === 'saving');
  const total = active.reduce((sum, job) => sum + job.total, 0);
  const completed = active.reduce((sum, job) => sum + job.completed, 0);

  // Briefly confirm a finished save.
  useEffect(() => {
    const finished = snapshot.lastFinished;
    if (!finished) return undefined;
    const label = finished.total > 1 ? `Saved ${finished.total} images to Snippets` : 'Saved to Snippets';
    setDoneLabel(label);
    AccessibilityInfo.announceForAccessibility?.(label);
    const timer = setTimeout(() => setDoneLabel(null), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [snapshot.lastFinished]);

  const next = active.length
    ? { busy: true, label: total > 1 ? `Saving ${Math.min(completed + 1, total)} of ${total}` : 'Saving to Snippets' }
    : doneLabel ? { busy: false, label: doneLabel } : null;
  const nextKey = next ? `${next.busy}:${next.label}` : null;

  // Keep the last content on screen while fading out.
  useEffect(() => {
    if (next) setContent(next);
    const animation = Animated.timing(opacity, {
      toValue: next ? 1 : 0, duration: 180, useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !next) setContent(null);
    });
    return () => animation.stop();
  }, [nextKey, opacity]);

  if (!content) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.wrapper, { top: insets.top + TOP_OFFSET, opacity }]}>
      <View style={styles.pill}>
        {content.busy ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <SymbolView
            name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
            size={16}
            tintColor="#7DDBB0"
          />
        )}
        <ThemedText numberOfLines={1} style={styles.label}>{content.label}</ThemedText>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 1000, elevation: 1000 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '86%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(15, 23, 42, 0.86)',
  },
  label: { color: '#FFFFFF', fontSize: 13, lineHeight: 18, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
});
