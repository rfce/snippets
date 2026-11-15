import { Image } from 'expo-image';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Easing, Modal, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { createBatchCapturePlayer, getBatchCaptureMotion, resolveBatchCaptureCardGeometry } from '@/batch-capture-geometry';

const CAN_INVERT_COUNT = Platform.OS !== 'android' || Number(Platform.Version) >= 29;

export const BatchCaptureTray = memo(forwardRef(function BatchCaptureTray({ photo, count, onLayout }, ref) {
  const hasPhoto = Boolean(photo?.uri) && count > 0;
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={onLayout}
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLiveRegion="polite"
      accessibilityLabel={hasPhoto
        ? `${count} ${count === 1 ? 'image' : 'images'} captured in batch. Latest capture shown.`
        : 'No batch captures yet'}
      style={[styles.tray, !hasPhoto && styles.emptyTray]}>
      {hasPhoto && (
        <>
          <Image
            key={photo.uri}
            source={photo.uri}
            recyclingKey={photo.uri}
            contentFit="cover"
            transition={0}
            accessible={false}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.countLayer}>
            <View style={CAN_INVERT_COUNT && styles.invertedCount}>
              <Text
                allowFontScaling={false}
                adjustsFontSizeToFit
                minimumFontScale={0.5}
                numberOfLines={1}
                ellipsizeMode="clip"
                style={[styles.countText, count > 99 && styles.largeCount]}>
                {String(count)}
              </Text>
            </View>
          </View>
        </>
      )}
      <View style={styles.trayBorder} />
    </View>
  );
}));

export function BatchCaptureOverlay({ flights, onComplete }) {
  const [shown, setShown] = useState(false);
  const markShown = useCallback(() => setShown(true), []);
  const dismiss = useCallback(() => {
    flights.forEach((capture) => onComplete(capture.id));
  }, [flights, onComplete]);

  return (
    <Modal
      transparent
      visible={flights.length > 0}
      animationType="none"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onShow={markShown}
      onRequestClose={dismiss}>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={markShown}
        style={styles.overlay}>
        {flights.map((capture) => (
          <CaptureFlight key={capture.id} capture={capture} shown={shown} onComplete={onComplete} />
        ))}
      </View>
    </Modal>
  );
}

function CaptureFlight({ capture, shown, onComplete }) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const geometry = useMemo(() => resolveBatchCaptureCardGeometry(
    capture.photo, capture.geometry, { width: windowWidth, height: windowHeight }
  ), [capture.photo, capture.geometry, windowWidth, windowHeight]);
  const { from } = geometry;
  const cardSize = useMemo(() => ({ width: from.width, height: from.height }), [from.width, from.height]);
  const progress = useRef(new Animated.Value(0)).current;
  const playerRef = useRef(null);
  const imageReadyRef = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    let cancelled = false;
    progress.setValue(0);
    const player = createBatchCapturePlayer({
      onComplete: () => { if (!cancelled) onComplete(capture.id); },
      startAnimation: (done) => {
        const animation = Animated.sequence([
          Animated.delay(180),
          Animated.timing(progress, {
            toValue: 1, duration: 680, easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true, isInteraction: false,
          }),
        ]);
        animation.start(({ finished }) => { if (finished) done(); });
        return () => animation.stop();
      },
    });
    playerRef.current = player;
    // These signals may arrive in either order, including before this effect.
    if (imageReadyRef.current) player.imageReady();
    if (shownRef.current) player.show();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') player.finish();
    });
    if (['background', 'inactive'].includes(AppState.currentState)) player.finish();

    return () => {
      cancelled = true;
      subscription.remove();
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [capture.id, onComplete, progress]);

  useEffect(() => { if (shown) playerRef.current?.show(); }, [shown]);
  const imageReady = useCallback(() => {
    imageReadyRef.current = true;
    playerRef.current?.imageReady();
  }, []);
  const imageFailed = useCallback(() => playerRef.current?.finish(), []);
  const motion = useMemo(() => getBatchCaptureMotion(geometry), [geometry]);

  // The photo is visible from the first render. Only transforms and opacity
  // animate, so the complete flight runs on the native UI thread.
  const translationStyle = useMemo(() => ({
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, motion.translateX] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, motion.translateY] }) },
    ],
  }), [motion, progress]);
  const photoStyle = useMemo(() => ({
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, motion.scale] }) }],
    opacity: progress.interpolate({ inputRange: [0, 0.93, 1], outputRange: [1, 1, 0] }),
  }), [motion, progress]);

  return (
    <Animated.View
      collapsable={false}
      style={[styles.flight, { left: from.x, top: from.y }, cardSize, translationStyle]}>
      <Animated.View collapsable={false} style={[styles.flightPhoto, cardSize, photoStyle]}>
        <View collapsable={false} style={[styles.photoClip, cardSize]}>
          <Image
            source={capture.photo.uri}
            recyclingKey={capture.photo.uri}
            contentFit="contain"
            transition={0}
            onLoad={imageReady}
            onDisplay={imageReady}
            onError={imageFailed}
            style={cardSize}
          />
        </View>
        <View style={[styles.flightBorder, cardSize]} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tray: {
    width: 72, height: 72, borderRadius: 18, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#172331',
    isolation: 'isolate',
  },
  emptyTray: { backgroundColor: '#101D27' },
  trayBorder: {
    ...StyleSheet.absoluteFillObject, borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.3)', borderRadius: 18,
  },
  countLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  invertedCount: { mixBlendMode: 'difference' },
  countText: {
    color: '#FFFFFF', fontSize: 25, lineHeight: 32, fontWeight: '800',
    fontVariant: ['tabular-nums'], textAlign: 'center', maxWidth: 56, includeFontPadding: false,
    padding: 0, margin: 0, backgroundColor: 'transparent', textDecorationLine: 'none',
  },
  largeCount: { fontSize: 19, lineHeight: 28 },
  overlay: { flex: 1, backgroundColor: 'transparent' },
  flight: { position: 'absolute' },
  flightPhoto: {
    backgroundColor: '#0B1521', borderRadius: 16,
    shadowColor: '#000000', shadowOpacity: 0.4, shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 }, elevation: 12,
  },
  photoClip: { borderRadius: 16, overflow: 'hidden' },
  flightBorder: {
    position: 'absolute', left: 0, top: 0, borderRadius: 16,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.86)',
  },
});
