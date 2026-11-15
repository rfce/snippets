import { Image } from 'expo-image';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Easing, Modal, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { createBatchCapturePlayer, getBatchCaptureMotion, resolveBatchCaptureCardGeometry } from '@/batch-capture-geometry';

const CAN_INVERT_COUNT = Platform.OS !== 'android' || Number(Platform.Version) >= 29;

export const BatchCaptureTray = memo(forwardRef(function BatchCaptureTray({
  photo, count, pendingPhotos = [], onLayout,
}, ref) {
  const hasPhoto = Boolean(photo?.uri) && count > 0;
  // Keep pending thumbnails mounted at zero opacity. The URI key survives the
  // handoff, so landing reveals a prepared image without reloading its source.
  const images = [...new Map(
    [photo, ...pendingPhotos].filter((item) => item?.uri).map((item) => [item.uri, item])
  ).values()];
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
      {images.map((item) => (
        <Image
          key={item.uri}
          source={item.uri}
          recyclingKey={item.uri}
          contentFit="cover"
          transition={0}
          accessible={false}
          style={[StyleSheet.absoluteFill, { opacity: hasPhoto && item.uri === photo.uri ? 1 : 0 }]}
        />
      ))}
      {hasPhoto && (
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
      )}
      <View style={styles.trayBorder} />
    </View>
  );
}));

export function CameraCaptureOverlay({ blink, flights, onBlinkComplete, onComplete }) {
  const [shown, setShown] = useState(false);
  const [presented, setPresented] = useState(false);
  const markShown = useCallback(() => {
    setShown(true);
    setPresented(true);
  }, []);
  const markLayout = useCallback(() => setShown(true), []);
  const dismiss = useCallback(() => {
    if (blink) onBlinkComplete(blink.id);
    flights.forEach((capture) => onComplete(capture.id));
  }, [blink, flights, onBlinkComplete, onComplete]);

  return (
    <Modal
      transparent
      visible={Boolean(blink) || flights.length > 0}
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
        onLayout={markLayout}
        style={styles.overlay}>
        {blink && (
          <CaptureBlink key={blink.id} blink={blink} shown={presented} onComplete={onBlinkComplete} />
        )}
        {flights.map((capture) => (
          <CaptureFlight key={capture.id} capture={capture} shown={shown} onComplete={onComplete} />
        ))}
      </View>
    </Modal>
  );
}

function CaptureBlink({ blink, shown, onComplete }) {
  const { width, height } = useWindowDimensions();
  const preview = useMemo(() => resolveBatchCaptureCardGeometry(
    {}, blink.geometry, { width, height }
  ).preview, [blink.geometry, width, height]);
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useMemo(() => progress.interpolate({
    inputRange: [0, 0.12, 0.26, 0.36, 0.68, 1],
    outputRange: [0, 0.6, 0.96, 0.96, 0.2, 0],
    extrapolate: 'clamp',
  }), [progress]);

  useEffect(() => {
    // A failed native presentation must never leave an invisible modal open.
    const finish = () => onComplete(blink.id);
    const timeout = setTimeout(finish, 3000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') finish();
    });
    if (['background', 'inactive'].includes(AppState.currentState)) finish();
    return () => {
      clearTimeout(timeout);
      subscription.remove();
    };
  }, [blink.id, onComplete]);

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1, duration: 460, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    });
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      onComplete(blink.id);
    };
    animation.start(({ finished }) => { if (finished) finish(); });
    return () => {
      cancelled = true;
      animation.stop();
      progress.setValue(0);
    };
  }, [blink.id, shown, onComplete, progress]);

  return (
    <Animated.View
      collapsable={false}
      pointerEvents="none"
      style={[
        styles.captureBlink,
        { left: preview.x, top: preview.y, width: preview.width, height: preview.height, opacity },
      ]}
    />
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
  const entrance = useRef(new Animated.Value(0)).current;
  const visibility = useRef(new Animated.Value(0)).current;
  const playerRef = useRef(null);
  const imageDisplayedRef = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    let cancelled = false;
    progress.setValue(0);
    entrance.setValue(0);
    visibility.setValue(0);
    const player = createBatchCapturePlayer({
      onComplete: () => { if (!cancelled) onComplete(capture.id); },
      startAnimation: (done) => {
        visibility.setValue(1);
        const animation = Animated.sequence([
          Animated.timing(entrance, {
            toValue: 1, duration: 280, easing: Easing.out(Easing.cubic),
            useNativeDriver: true, isInteraction: false,
          }),
          Animated.delay(80),
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
    if (imageDisplayedRef.current) player.imageReady();
    if (shownRef.current) player.show();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') player.finish();
    });
    if (['background', 'inactive'].includes(AppState.currentState)) player.finish();

    return () => {
      cancelled = true;
      subscription.remove();
      player.dispose();
      visibility.setValue(0);
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [capture.id, entrance, onComplete, progress, visibility]);

  useEffect(() => { if (shown) playerRef.current?.show(); }, [shown]);
  const imageDisplayed = useCallback(() => {
    imageDisplayedRef.current = true;
    playerRef.current?.imageReady();
  }, []);
  const imageFailed = useCallback(() => playerRef.current?.finish(), []);
  const motion = useMemo(() => getBatchCaptureMotion(geometry), [geometry]);

  // Decode in place while the entire card, border and shadow stay transparent.
  // After onDisplay, grow from a point to the 80% frame with a gentle fade,
  // then carry that same photo into the thumbnail.
  const translationStyle = useMemo(() => ({
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, motion.translateX] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, motion.translateY] }) },
    ],
  }), [motion, progress]);
  const photoStyle = useMemo(() => ({
    transform: [{
      scale: Animated.multiply(
        entrance,
        progress.interpolate({ inputRange: [0, 1], outputRange: [1, motion.scale] })
      ),
    }],
    opacity: Animated.multiply(
      entrance.interpolate({ inputRange: [0, 1], outputRange: [1, 0.88] }),
      progress.interpolate({ inputRange: [0, 0.93, 1], outputRange: [1, 1, 0] })
    ),
  }), [entrance, motion, progress]);

  return (
    <Animated.View
      collapsable={false}
      style={[styles.flight, { left: from.x, top: from.y, opacity: visibility }, cardSize, translationStyle]}>
      <Animated.View collapsable={false} style={[styles.flightPhoto, cardSize, photoStyle]}>
        <View collapsable={false} style={[styles.photoClip, cardSize]}>
          <Image
            source={capture.photo.uri}
            recyclingKey={capture.photo.uri}
            contentFit="contain"
            transition={0}
            onDisplay={imageDisplayed}
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
  captureBlink: { position: 'absolute', backgroundColor: '#000000', borderRadius: 24 },
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
