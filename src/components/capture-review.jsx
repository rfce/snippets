import { Image } from 'expo-image';
import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { Alert, Animated, PanResponder, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { EDIT_ICONS, IconButton } from '@/components/icon-dock';
import { FinishHeader, FinishPalette } from '@/components/photo-card';
import { ThemedText } from '@/components/themed-text';
import { getCropMagnifierLayout, projectCropPointIntoMagnifier } from '@/crop-magnifier-geometry';
import {
  CROP_EDGES, copyCorners, getClosestCropHandle, getCropLineStyle, getDefaultCorners, getEdgeMidpoint,
  hasCustomCrop,
  getImageViewport, getOutsideShadeStyle, moveCropHandle, rotateCornersClockwise,
} from '@/crop-geometry';

const ACCENT = FinishPalette.accent;
const TARGET_SIZE = 48;
// Enough room for handles on the image edge to stay grabbable (most of each
// 48 pt touch target remains inside the canvas) while the image gets larger.
const REVIEW_PADDING = 18;
const IMAGE_RADIUS = 12;
const HINT_HEIGHT = 34;
const HINT_GAP = 16;
// Space between the dock's buttons and the safe-area bottom edge.
const DOCK_BOTTOM_SPACE = 20;

export const CaptureReview = memo(function CaptureReview({
  photo, initialEdits, isProcessing, onNext, onDiscard,
}) {
  const editorRef = useRef(null);
  const insets = useSafeAreaInsets();
  // Reset crop only does something once the crop differs from the full image.
  const [canReset, setCanReset] = useState(() => hasCustomCrop(initialEdits?.corners));

  return (
    <View style={styles.container}>
      {/* The bottom edge belongs to the dock, which handles its own inset. */}
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <FinishHeader title="Review capture" subtitle="Adjust the crop" />

        <CropEditor
          ref={editorRef}
          photo={photo}
          initialEdits={initialEdits}
          disabled={isProcessing}
          viewportPadding={REVIEW_PADDING}
          imageRadius={IMAGE_RADIUS}
          footerHeight={HINT_HEIGHT}
          footerGap={HINT_GAP}
          footer={(
            <ThemedText numberOfLines={2} style={styles.instruction}>
              Hold and drag a handle to magnify and fine-tune your crop
            </ThemedText>
          )}
          onCustomCropChange={setCanReset}
        />
      </SafeAreaView>

      {/* Bottom controls: all four circles centred as one row, with the
          same icons and sizes as batch Edit image. */}
      <View style={[styles.dock, { paddingBottom: insets.bottom + DOCK_BOTTOM_SPACE }]}>
        <View style={styles.dockTools}>
          <IconButton
            label="Rotate image 90 degrees clockwise"
            icon={EDIT_ICONS.rotate}
            iconSize={28}
            large
            disabled={isProcessing}
            onPress={() => editorRef.current?.rotate()}
          />
          <IconButton
            label="Reset crop to the full image"
            icon={EDIT_ICONS.reset}
            iconSize={28}
            large
            disabled={isProcessing || !canReset}
            onPress={() => editorRef.current?.reset()}
          />
          <IconButton
            label="Discard captured image"
            icon={EDIT_ICONS.delete}
            iconSize={28}
            large
            destructive
            disabled={isProcessing}
            onPress={onDiscard}
          />
        </View>
        <IconButton
          label="Next, preview this crop"
          icon={EDIT_ICONS.check}
          iconSize={28}
          large
          primary
          disabled={isProcessing}
          busy={isProcessing}
          onPress={() => {
            const edits = editorRef.current?.getEdits();
            if (edits) onNext(edits);
          }}
        />
      </View>
    </View>
  );
});

// Fits the image above a footer of `footerSpace` and centres the image and
// footer together, so the footer always sits directly under the image.
function getViewportWithFooter(frame, aspectRatio, padding, footerSpace) {
  const availableWidth = Math.max(0, frame.width - padding * 2);
  const availableHeight = Math.max(0, frame.height - padding * 2 - footerSpace);
  if (!availableWidth || !availableHeight || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: 0, height: 0, left: padding, top: padding };
  }
  const width = Math.min(availableWidth, availableHeight * aspectRatio);
  const height = width / aspectRatio;
  return {
    width,
    height,
    left: (frame.width - width) / 2,
    top: (frame.height - (height + footerSpace)) / 2,
  };
}

// Only this canvas re-renders during a drag. The camera controller, review
// controls, and source image do not receive a state update for every move.
export const CropEditor = forwardRef(function CropEditor({
  photo, initialEdits, disabled, showCropHandles = true, renderImage = true, viewportPadding = 28,
  imageRadius = 0, footer = null, footerHeight = 0, footerGap = 12, onCustomCropChange,
}, ref) {
  const [edits, setEdits] = useState(() => ({
    rotation: initialEdits?.rotation ?? 0,
    corners: copyCorners(initialEdits?.corners ?? getDefaultCorners()),
  }));
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [activeHandle, setActiveHandle] = useState(null);
  const activeHandleRef = useRef(null);
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
    if (disabled) return null;
    const corners = editsRef.current.corners;
    dragStartCornersRef.current = copyCorners(corners);
    // Enlarged targets can overlap on a small crop. Route the gesture to the
    // nearest visible handle, even if a neighboring target received the touch.
    const selected = touch ? getClosestCropHandle(corners, touch, viewport) : {
      handle,
      position: CROP_EDGES[handle] ? getEdgeMidpoint(corners, handle) : corners[handle],
    };
    activeHandleRef.current = selected.handle;
    setActiveHandle(selected.handle);
    return selected;
  }, [disabled]);

  const dragHandle = useCallback((handle, position, viewport) => {
    if (disabled || activeHandleRef.current !== handle || !dragStartCornersRef.current) return;
    const start = dragStartCornersRef.current;
    publishEdits({
      ...editsRef.current,
      corners: moveCropHandle(start, handle, position, viewport),
    });
  }, [disabled, publishEdits]);

  const endDrag = useCallback(() => {
    dragStartCornersRef.current = null;
    activeHandleRef.current = null;
    setActiveHandle(null);
    publishEdits(editsRef.current, true);
  }, [publishEdits]);

  useEffect(() => {
    if (disabled || !showCropHandles) endDrag();
  }, [disabled, showCropHandles, endDrag]);

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
      activeHandleRef.current = null;
      setActiveHandle(null);
      publishEdits({
        rotation: (editsRef.current.rotation + 90) % 360,
        corners: rotateCornersClockwise(editsRef.current.corners),
      }, true);
    },
    reset: () => {
      if (disabled) return;
      dragStartCornersRef.current = null;
      activeHandleRef.current = null;
      setActiveHandle(null);
      publishEdits({ ...editsRef.current, corners: getDefaultCorners() }, true);
    },
  }), [disabled, publishEdits]);

  const sourceRatio = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 4 / 3;
  const aspectRatio = edits.rotation % 180 === 0 ? sourceRatio : 1 / sourceRatio;
  const viewport = footer
    ? getViewportWithFooter(frame, aspectRatio, viewportPadding, footerHeight + footerGap)
    : getImageViewport(frame, aspectRatio, viewportPadding);
  const edges = Object.entries(CROP_EDGES);
  const handles = [
    ...edges.map(([name, [first, second]]) => ({
      name,
      position: getEdgeMidpoint(edits.corners, name),
      isEdge: true,
      // Edge capsules follow the edge, including under perspective tilt.
      angle: Math.atan2(
        (edits.corners[second].y - edits.corners[first].y) * viewport.height,
        (edits.corners[second].x - edits.corners[first].x) * viewport.width
      ) * 180 / Math.PI,
    })),
    ...Object.entries(edits.corners).map(([name, position]) => ({ name, position, isEdge: false })),
  ];

  // Reported only when the answer changes, not on every drag frame.
  const customCrop = hasCustomCrop(edits.corners);
  const customCropChangeRef = useRef(onCustomCropChange);
  customCropChangeRef.current = onCustomCropChange;
  useEffect(() => { customCropChangeRef.current?.(customCrop); }, [customCrop]);

  return (
    <View
      style={styles.canvas}
      onLayout={({ nativeEvent: { layout } }) => {
        if (frame.width === layout.width && frame.height === layout.height) return;
        endDrag();
        setFrame({ width: layout.width, height: layout.height });
      }}>
      {renderImage && viewport.width > 0 && viewport.height > 0 ? (
        <>
          <ReviewImage uri={photo.uri} rotation={edits.rotation} radius={imageRadius} {...viewport} />
          {(showCropHandles || customCrop) && (
            <View pointerEvents="none" style={[styles.imageOverlay, viewport]}>
              <View
                needsOffscreenAlphaCompositing
                style={[styles.shadeClip, imageRadius ? { borderRadius: imageRadius } : null]}>
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
          )}
          {footer ? (
            <View
              pointerEvents="none"
              style={[styles.footer, { top: viewport.top + viewport.height + footerGap, height: footerHeight }]}>
              {footer}
            </View>
          ) : null}
          {showCropHandles && handles.map(({ name, position, isEdge, angle }) => (
            <DraggableHandle
              key={name}
              handle={name}
              position={position}
              viewport={viewport}
              isEdge={isEdge}
              angle={angle}
              active={activeHandle === name}
              disabled={disabled}
              onStart={beginDrag}
              onMove={dragHandle}
              onEnd={endDrag}
            />
          ))}
          {showCropHandles && activeHandle && !disabled ? (
            <CropMagnifier
              uri={photo.uri}
              rotation={edits.rotation}
              frame={frame}
              viewport={viewport}
              corners={edits.corners}
              handles={handles}
              activeHandle={activeHandle}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
});

const ReviewImage = memo(function ReviewImage({
  uri, rotation, width, height, left, top, onDisplay, radius = 0,
}) {
  const sideways = rotation % 180 !== 0;
  return (
    <View pointerEvents="none" style={[styles.imageViewport, { width, height, left, top, borderRadius: radius }]}>
      <Image
        contentFit="contain"
        cachePolicy="disk"
        enforceEarlyResizing
        source={{ uri }}
        transition={0}
        onDisplay={onDisplay}
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

const CropMagnifier = memo(function CropMagnifier({
  uri, rotation, frame, viewport, corners, handles, activeHandle,
}) {
  const [preferredSide, setPreferredSide] = useState(null);
  const [imageReady, setImageReady] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(true);
  const handleImageDisplay = useCallback(() => {
    if (mountedRef.current) setImageReady(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!imageReady) return undefined;
    const animation = Animated.timing(opacity, {
      toValue: 1, duration: 180, useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [imageReady, opacity]);

  const active = handles.find((handle) => handle.name === activeHandle);
  const layout = getCropMagnifierLayout(frame, viewport, active?.position, preferredSide);
  const nextSide = layout?.side ?? null;
  useEffect(() => {
    if (nextSide !== preferredSide) setPreferredSide(nextSide);
  }, [nextSide, preferredSide]);
  if (!layout) return null;
  const center = layout.innerSize / 2;
  const pointer = projectCropPointIntoMagnifier(active.position, layout);
  const scaledViewport = { width: layout.source.width, height: layout.source.height };

  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.magnifier,
        !imageReady && styles.magnifierLoading,
        {
          opacity,
          left: layout.left, top: layout.top,
          width: layout.size, height: layout.size, borderRadius: layout.size / 2,
        },
      ]}>
      <View style={[
        styles.magnifierClip,
        { width: layout.innerSize, height: layout.innerSize, borderRadius: center },
      ]}>
        <View style={[styles.magnifierSource, layout.source]}>
          <ReviewImage
            uri={uri}
            rotation={rotation}
            width={layout.source.width}
            height={layout.source.height}
            left={0}
            top={0}
            onDisplay={handleImageDisplay}
          />
          {Object.entries(CROP_EDGES).map(([name, [first, second]]) => {
            const line = getCropLineStyle(corners[first], corners[second], scaledViewport);
            return (
              <View key={name} style={styles.magnifierLineGroup}>
                <View style={[styles.cropLine, line, styles.magnifierLineHalo]} />
                <View style={[styles.cropLine, line]} />
              </View>
            );
          })}
          {handles.filter((handle) => handle.name !== activeHandle).map((handle) => {
            const size = handle.isEdge ? 8 : 10;
            return (
              <View key={handle.name} style={[
                styles.magnifierHandle,
                {
                  left: handle.position.x * layout.source.width - size / 2,
                  top: handle.position.y * layout.source.height - size / 2,
                  width: size, height: size, borderRadius: size / 2,
                },
              ]} />
            );
          })}
        </View>
        <View style={[
          styles.magnifierPointerHalo,
          { left: pointer.x - 9, top: pointer.y - 9 },
        ]}>
          <View style={styles.magnifierPointerRing}>
            <View style={styles.magnifierPointerDot} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
});

function DraggableHandle({
  handle, position, viewport, isEdge, angle = 0, active = false, disabled, onStart, onMove, onEnd,
}) {
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
        if (inputs.disabled) return;
        const { locationX, locationY } = event.nativeEvent;
        const touch = {
          x: inputs.position.x + ((locationX ?? TARGET_SIZE / 2) - TARGET_SIZE / 2) / inputs.viewport.width,
          y: inputs.position.y + ((locationY ?? TARGET_SIZE / 2) - TARGET_SIZE / 2) / inputs.viewport.height,
        };
        const selected = inputs.onStart(inputs.handle, touch, inputs.viewport);
        if (!selected) return;
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
      <View
        pointerEvents="none"
        style={[
          isEdge ? styles.edgeHandle : styles.handle,
          active && styles.activeHandle,
          { transform: [...(isEdge ? [{ rotate: `${angle}deg` }] : []), { scale: active ? 1.18 : 1 }] },
        ]}
      />
    </View>
  );
}

const handleLift = {
  shadowColor: '#0F172A',
  shadowOpacity: 0.22,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 1 },
  elevation: 3,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: FinishPalette.background },
  safeArea: { flex: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  canvas: { width: '100%', flex: 1, minHeight: 1, position: 'relative' },
  imageViewport: { position: 'absolute', overflow: 'hidden' },
  imageOverlay: { position: 'absolute' },
  shadeClip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden', opacity: 0.42 },
  shade: { position: 'absolute', backgroundColor: '#0F172A' },
  cropLine: { position: 'absolute', height: 2, backgroundColor: ACCENT },
  handleTarget: { position: 'absolute', width: TARGET_SIZE, height: TARGET_SIZE,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  handle: { width: 22, height: 22, borderRadius: 11, backgroundColor: ACCENT,
    borderWidth: 3, borderColor: '#FFFFFF', ...handleLift },
  // A slim capsule reads as "drag this edge" and hides less of the page.
  edgeHandle: { width: 30, height: 10, borderRadius: 5, backgroundColor: '#FFFFFF',
    borderWidth: 2, borderColor: ACCENT, ...handleLift },
  activeHandle: { shadowOpacity: 0.32, shadowRadius: 6, elevation: 6 },
  footer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'flex-start' },
  magnifier: {
    position: 'absolute', zIndex: 10, elevation: 12, padding: 2,
    borderWidth: 2, borderColor: '#FFFFFF', backgroundColor: ACCENT,
    shadowColor: '#0F172A', shadowOpacity: 0.24, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  magnifierClip: { overflow: 'hidden', backgroundColor: '#E8EDF3' },
  magnifierLoading: { elevation: 0, shadowOpacity: 0, borderColor: 'transparent', backgroundColor: 'transparent' },
  magnifierSource: { position: 'absolute' },
  magnifierLineGroup: { ...StyleSheet.absoluteFillObject },
  magnifierLineHalo: { height: 4, marginTop: -1, backgroundColor: '#FFFFFF' },
  magnifierHandle: {
    position: 'absolute', backgroundColor: '#FFFFFF',
    borderWidth: 1.5, borderColor: ACCENT,
  },
  magnifierPointerHalo: {
    position: 'absolute', width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center',
  },
  magnifierPointerRing: {
    width: 14, height: 14, borderRadius: 7, borderWidth: 1.5,
    borderColor: ACCENT, alignItems: 'center', justifyContent: 'center',
  },
  magnifierPointerDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: ACCENT },
  instruction: { color: FinishPalette.muted, fontSize: 12, lineHeight: 16, textAlign: 'center',
    paddingHorizontal: 24 },
  // Just the circles: no panel, so the buttons sit directly on the page.
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 8,
    paddingHorizontal: 24,
  },
  dockTools: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
