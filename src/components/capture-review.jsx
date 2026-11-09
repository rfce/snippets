import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { ActivityIndicator, Alert, PanResponder, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import {
  CROP_EDGES, copyCorners, getClosestCropHandle, getCropLineStyle, getDefaultCorners, getEdgeMidpoint,
  getImageViewport, getOutsideShadeStyle, moveCropHandle, rotateCornersClockwise,
} from '@/crop-geometry';

const ACCENT = '#3C78D8';
const DISCARD = '#C2415A';
const TARGET_SIZE = 48;

export const CaptureReview = memo(function CaptureReview({
  photo, initialEdits, isProcessing, onNext, onDiscard,
}) {
  const editorRef = useRef(null);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <ThemedText style={styles.title}>Review capture</ThemedText>
          <View style={styles.badge}>
            <SymbolView
              name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
              size={17}
              tintColor={ACCENT}
            />
            <ThemedText type="smallBold" style={styles.badgeText}>Ready</ThemedText>
          </View>
        </View>

        <CropEditor ref={editorRef} photo={photo} initialEdits={initialEdits} disabled={isProcessing} />

        <ThemedText style={styles.instruction}>
          Drag the corners or edge handles to adjust your crop
        </ThemedText>
        <View style={styles.tools}>
          <Pressable
            accessibilityLabel="Rotate image 90 degrees clockwise"
            accessibilityRole="button"
            disabled={isProcessing}
            onPress={() => editorRef.current?.rotate()}
            style={({ pressed }) => [styles.tool, pressed && styles.pressed, isProcessing && styles.disabled]}>
            <SymbolView
              name={{ ios: 'arrow.clockwise', android: 'rotate_right', web: 'rotate_right' }}
              size={22}
              tintColor={ACCENT}
            />
            <ThemedText type="smallBold" style={styles.toolText}>Rotate</ThemedText>
          </Pressable>
          <Pressable
            accessibilityLabel="Reset crop to the full image"
            accessibilityRole="button"
            disabled={isProcessing}
            onPress={() => editorRef.current?.reset()}
            style={({ pressed }) => [styles.tool, pressed && styles.pressed, isProcessing && styles.disabled]}>
            <SymbolView
              name={{ ios: 'arrow.counterclockwise', android: 'restart_alt', web: 'restart_alt' }}
              size={22}
              tintColor={ACCENT}
            />
            <ThemedText type="smallBold" style={styles.toolText}>Reset crop</ThemedText>
          </Pressable>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Discard captured image"
            accessibilityRole="button"
            disabled={isProcessing}
            onPress={onDiscard}
            style={({ pressed }) => [styles.action, styles.discard, pressed && styles.pressed, isProcessing && styles.disabled]}>
            <SymbolView
              name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
              size={26}
              tintColor={DISCARD}
            />
            <ThemedText type="smallBold" style={styles.discardText}>Discard</ThemedText>
          </Pressable>
          <Pressable
            accessibilityLabel="Next, preview this crop"
            accessibilityRole="button"
            disabled={isProcessing}
            onPress={() => {
              const edits = editorRef.current?.getEdits();
              if (edits) onNext(edits);
            }}
            style={({ pressed }) => [styles.action, styles.next, pressed && styles.pressed, isProcessing && styles.disabled]}>
            <ThemedText type="smallBold" style={styles.nextText}>Next</ThemedText>
            {isProcessing ? <ActivityIndicator color="#FFFFFF" /> : (
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={26}
                tintColor="#FFFFFF"
              />
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
});

// Only this canvas re-renders during a drag. The camera controller, review
// controls, and source image do not receive a state update for every move.
const CropEditor = forwardRef(function CropEditor({ photo, initialEdits, disabled }, ref) {
  const [edits, setEdits] = useState(() => ({
    rotation: initialEdits?.rotation ?? 0,
    corners: copyCorners(initialEdits?.corners ?? getDefaultCorners()),
  }));
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const editsRef = useRef(edits);
  const pendingFrameRef = useRef(null);
  const dragStartCornersRef = useRef(null);

  const publishEdits = useCallback((next, immediately = false) => {
    // Keep the authoritative value synchronous: Next and release must include
    // the final movement even when its animation-frame render is still queued.
    editsRef.current = next;
    if (immediately) {
      if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
      setEdits(next);
    } else if (pendingFrameRef.current === null) {
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        setEdits(editsRef.current);
      });
    }
  }, []);

  useEffect(() => () => {
    if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
  }, []);

  const beginDrag = useCallback((handle, touch, viewport) => {
    const corners = editsRef.current.corners;
    dragStartCornersRef.current = copyCorners(corners);
    // Enlarged targets can overlap on a small crop. Route the gesture to the
    // nearest visible handle, even if a neighboring target received the touch.
    return touch ? getClosestCropHandle(corners, touch, viewport) : {
      handle,
      position: CROP_EDGES[handle] ? getEdgeMidpoint(corners, handle) : corners[handle],
    };
  }, []);

  const dragHandle = useCallback((handle, position, viewport) => {
    const start = dragStartCornersRef.current ?? editsRef.current.corners;
    publishEdits({
      ...editsRef.current,
      corners: moveCropHandle(start, handle, position, viewport),
    });
  }, [publishEdits]);

  const endDrag = useCallback(() => {
    dragStartCornersRef.current = null;
    publishEdits(editsRef.current, true);
  }, [publishEdits]);

  useImperativeHandle(ref, () => ({
    getEdits: () => ({
      rotation: editsRef.current.rotation,
      corners: copyCorners(editsRef.current.corners),
    }),
    rotate: () => {
      if (disabled) return;
      if (Platform.OS === 'web') {
        Alert.alert('Not available', 'Image rotation is available on a mobile device.');
        return;
      }
      dragStartCornersRef.current = null;
      publishEdits({
        rotation: (editsRef.current.rotation + 90) % 360,
        corners: rotateCornersClockwise(editsRef.current.corners),
      }, true);
    },
    reset: () => {
      if (disabled) return;
      dragStartCornersRef.current = null;
      publishEdits({ ...editsRef.current, corners: getDefaultCorners() }, true);
    },
  }), [disabled, publishEdits]);

  const sourceRatio = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 4 / 3;
  const aspectRatio = edits.rotation % 180 === 0 ? sourceRatio : 1 / sourceRatio;
  const viewport = getImageViewport(frame, aspectRatio);
  const edges = Object.entries(CROP_EDGES);
  const handles = [
    ...edges.map(([name]) => ({ name, position: getEdgeMidpoint(edits.corners, name), isEdge: true })),
    ...Object.entries(edits.corners).map(([name, position]) => ({ name, position, isEdge: false })),
  ];

  return (
    <View
      style={styles.canvas}
      onLayout={({ nativeEvent: { layout } }) => {
        setFrame((current) => current.width === layout.width && current.height === layout.height
          ? current : { width: layout.width, height: layout.height });
      }}>
      {viewport.width > 0 && viewport.height > 0 ? (
        <>
          <ReviewImage uri={photo.uri} rotation={edits.rotation} {...viewport} />
          <View pointerEvents="none" style={[styles.imageOverlay, viewport]}>
            <View needsOffscreenAlphaCompositing style={styles.shadeClip}>
              {edges.map(([name, [first, second]]) => (
                <View key={name} style={[
                  styles.shade,
                  getOutsideShadeStyle(edits.corners[first], edits.corners[second], viewport),
                ]} />
              ))}
            </View>
            {edges.map(([name, [first, second]]) => (
              <View key={name} style={[
                styles.cropLine,
                getCropLineStyle(edits.corners[first], edits.corners[second], viewport),
              ]} />
            ))}
          </View>
          {handles.map(({ name, position, isEdge }) => (
            <DraggableHandle
              key={name}
              handle={name}
              position={position}
              viewport={viewport}
              isEdge={isEdge}
              disabled={disabled}
              onStart={beginDrag}
              onMove={dragHandle}
              onEnd={endDrag}
            />
          ))}
        </>
      ) : null}
    </View>
  );
});

const ReviewImage = memo(function ReviewImage({ uri, rotation, width, height, left, top }) {
  const sideways = rotation % 180 !== 0;
  return (
    <View pointerEvents="none" style={[styles.imageViewport, { width, height, left, top }]}>
      <Image
        contentFit="contain"
        source={{ uri }}
        transition={0}
        style={{
          position: 'absolute',
          width: sideways ? height : width,
          height: sideways ? width : height,
          left: sideways ? (width - height) / 2 : 0,
          top: sideways ? (height - width) / 2 : 0,
          transform: [{ rotate: `${rotation}deg` }],
        }}
      />
    </View>
  );
});

function DraggableHandle({ handle, position, viewport, isEdge, disabled, onStart, onMove, onEnd }) {
  const inputsRef = useRef(null);
  const gestureRef = useRef(null);
  inputsRef.current = { handle, position, viewport, disabled, onStart, onMove, onEnd };

  const responder = useMemo(() => {
    const move = (gesture) => {
      const inputs = inputsRef.current;
      const start = gestureRef.current;
      if (inputs.disabled || !start) return;
      inputs.onMove(start.handle, {
        x: start.position.x + gesture.dx / start.viewport.width,
        y: start.position.y + gesture.dy / start.viewport.height,
      }, start.viewport);
    };
    const finish = () => {
      gestureRef.current = null;
      inputsRef.current.onEnd();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !inputsRef.current.disabled,
      onMoveShouldSetPanResponder: () => !inputsRef.current.disabled,
      onPanResponderGrant: (event) => {
        const inputs = inputsRef.current;
        const { locationX, locationY } = event.nativeEvent;
        const touch = {
          x: inputs.position.x + ((locationX ?? TARGET_SIZE / 2) - TARGET_SIZE / 2) / inputs.viewport.width,
          y: inputs.position.y + ((locationY ?? TARGET_SIZE / 2) - TARGET_SIZE / 2) / inputs.viewport.height,
        };
        const selected = inputs.onStart(inputs.handle, touch, inputs.viewport);
        // Read the current viewport at the start of each gesture, including
        // after rotation. Never retain the dimensions from the first render.
        gestureRef.current = {
          handle: selected.handle,
          position: { ...selected.position },
          viewport: { width: inputs.viewport.width, height: inputs.viewport.height },
        };
      },
      onPanResponderMove: (_, gesture) => move(gesture),
      onPanResponderRelease: (_, gesture) => { move(gesture); finish(); },
      onPanResponderTerminate: finish,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    });
  }, []);

  return (
    <View
      accessible
      accessibilityLabel={`Move ${handle.replace(/([A-Z])/g, ' $1').toLowerCase()} crop ${isEdge ? 'edge' : 'corner'}`}
      accessibilityRole="adjustable"
      accessibilityState={{ disabled }}
      accessibilityActions={[
        { name: 'moveLeft', label: 'Move left' },
        { name: 'moveRight', label: 'Move right' },
        { name: 'moveUp', label: 'Move up' },
        { name: 'moveDown', label: 'Move down' },
      ]}
      onAccessibilityAction={({ nativeEvent: { actionName } }) => {
        if (disabled) return;
        const directions = { moveLeft: [-1, 0], moveRight: [1, 0], moveUp: [0, -1], moveDown: [0, 1] };
        const direction = directions[actionName];
        if (!direction) return;
        onStart(handle);
        onMove(handle, {
          x: position.x + direction[0] * 4 / viewport.width,
          y: position.y + direction[1] * 4 / viewport.height,
        }, viewport);
        onEnd();
      }}
      collapsable={false}
      pointerEvents={disabled ? 'none' : 'auto'}
      {...responder.panHandlers}
      style={[
        styles.handleTarget,
        { left: viewport.left + position.x * viewport.width - TARGET_SIZE / 2,
          top: viewport.top + position.y * viewport.height - TARGET_SIZE / 2,
          zIndex: isEdge ? 2 : 3 },
      ]}>
      <View pointerEvents="none" style={[styles.handle, isEdge && styles.edgeHandle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  safeArea: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: '#0F172A', fontSize: 28, lineHeight: 34, fontWeight: '700', flexShrink: 1 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10,
    paddingVertical: 7, borderRadius: 20, backgroundColor: '#EEF4FF' },
  badgeText: { color: ACCENT },
  canvas: { width: '100%', flex: 1, minHeight: 1, position: 'relative' },
  imageViewport: { position: 'absolute', overflow: 'hidden' },
  imageOverlay: { position: 'absolute' },
  shadeClip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden', opacity: 0.42 },
  shade: { position: 'absolute', backgroundColor: '#0F172A' },
  cropLine: { position: 'absolute', height: 2, backgroundColor: ACCENT },
  handleTarget: { position: 'absolute', width: TARGET_SIZE, height: TARGET_SIZE,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  handle: { width: 22, height: 22, borderRadius: 11, backgroundColor: ACCENT,
    borderWidth: 3, borderColor: '#FFFFFF' },
  edgeHandle: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF',
    borderWidth: 2, borderColor: ACCENT },
  instruction: { color: '#64748B', fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  tools: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 10 },
  tool: { minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, borderRadius: 14, backgroundColor: '#EEF4FF' },
  toolText: { color: ACCENT },
  actions: { flexDirection: 'row', gap: 12 },
  action: { flex: 1, minHeight: 60, paddingHorizontal: 16, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 18 },
  discard: { backgroundColor: '#FFF1F3' },
  discardText: { color: DISCARD },
  next: { backgroundColor: ACCENT },
  nextText: { color: '#FFFFFF' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
