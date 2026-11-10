import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  CAMERA_FOCUS_COLOR,
  CAMERA_FOCUS_SIZE,
  createCameraFocusController,
  getCameraFocusPoint,
  getCameraPreviewSize,
  getNativeFocusCamera,
} from '@/camera-focus';

const STATUS_LABELS = {
  focusing: 'Focusing…',
  focused: 'In focus',
  failed: 'Tap to focus again',
  cancelled: 'Tap to focus again',
  unsupported: 'Automatic focus',
  unavailable: 'Camera update required',
};

// Indicator state never updates camera props or restarts the native preview.
const CameraPreview = memo(function CameraPreview({
  CameraComponent, cameraRef, enableTorch, flash, onCameraReady, onMountError,
}) {
  return (
    <CameraComponent
      ref={cameraRef}
      autofocus={Platform.OS === 'ios' ? 'on' : undefined}
      enableTorch={enableTorch}
      facing="back"
      flash={flash}
      ratio={Platform.OS === 'android' ? '4:3' : undefined}
      onCameraReady={onCameraReady}
      onMountError={onMountError}
      style={StyleSheet.absoluteFill}
    />
  );
});

export const FocusableCamera = memo(forwardRef(function FocusableCamera({
  CameraComponent,
  cameraRef,
  disabled,
  enableTorch,
  flash,
  onReadyChange,
  onMountError,
  style,
}, ref) {
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [appActive, setAppActive] = useState(
    () => !['background', 'inactive'].includes(AppState.currentState)
  );
  const [indicator, setIndicator] = useState(null);
  const [displayIndicator, setDisplayIndicator] = useState(null);
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(appActive);
  const indicatorRef = useRef(indicator);
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createCameraFocusController({
      getCamera: () => getNativeFocusCamera(cameraRef.current),
      onChange: (value) => {
        indicatorRef.current = value;
        if (mountedRef.current) setIndicator(value);
      },
    });
  }
  const controller = controllerRef.current;
  const previewSize = getCameraPreviewSize(stageSize.width, stageSize.height);

  useImperativeHandle(ref, () => ({
    prepareCaptureAsync: () => controller.prepareCaptureAsync(),
    finishCapture: () => controller.setEnabled(activeRef.current && ready),
  }), [controller, ready]);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      const nextActive = state === 'active';
      if (nextActive === activeRef.current) return;
      activeRef.current = nextActive;
      controller.setEnabled(false);
      controller.reset();
      setReady(false);
      onReadyChange(false);
      setAppActive(nextActive);
    });
    return () => {
      mountedRef.current = false;
      controller.dispose();
      subscription.remove();
    };
  }, [controller, onReadyChange]);

  useEffect(() => {
    controller.setEnabled(appActive && ready && !disabled);
    if (disabled) controller.hide();
  }, [appActive, controller, disabled, ready]);

  useEffect(() => {
    opacity.stopAnimation();
    scale.stopAnimation();
    let animation;
    if (indicator) {
      setDisplayIndicator(indicator);
      opacity.setValue(1);
      if (indicator.status === 'focusing') {
        scale.setValue(1.18);
        animation = Animated.spring(scale, {
          toValue: 1, stiffness: 240, damping: 22, mass: 0.7, useNativeDriver: true,
        });
      } else if (indicator.status === 'focused') {
        animation = Animated.sequence([
          Animated.timing(scale, { toValue: 0.94, duration: 100, useNativeDriver: true }),
          Animated.spring(scale, { toValue: 1, stiffness: 260, damping: 20, useNativeDriver: true }),
        ]);
      } else {
        scale.setValue(1);
      }
    } else {
      animation = Animated.timing(opacity, {
        toValue: 0, duration: 220, useNativeDriver: true,
      });
    }
    animation?.start(({ finished }) => {
      if (finished && !indicatorRef.current && mountedRef.current) setDisplayIndicator(null);
    });
    return () => animation?.stop();
  }, [indicator, opacity, scale]);

  const handleLayout = ({ nativeEvent: { layout } }) => {
    if (layout.width === stageSize.width && layout.height === stageSize.height) return;
    controller.reset();
    setStageSize({ width: layout.width, height: layout.height });
  };

  const handleReady = useCallback(() => {
    if (!mountedRef.current || !activeRef.current) return;
    setReady(true);
    onReadyChange(true);
  }, [onReadyChange]);

  const handleMountError = useCallback((event) => {
    controller.setEnabled(false);
    controller.reset();
    setReady(false);
    onReadyChange(false);
    onMountError?.(event);
  }, [controller, onMountError, onReadyChange]);

  const handleTap = ({ nativeEvent }) => {
    const point = getCameraFocusPoint(
      nativeEvent.locationX ?? previewSize.width / 2,
      nativeEvent.locationY ?? previewSize.height / 2,
      previewSize.width,
      previewSize.height
    );
    void controller.focusAt(point);
  };

  const color = displayIndicator?.status === 'focused' ? CAMERA_FOCUS_COLOR : '#FFFFFF';

  return (
    <View onLayout={handleLayout} style={[styles.stage, style]}>
      {previewSize.width > 0 && (
        <View style={[styles.frame, previewSize]}>
          {appActive && (
            <CameraPreview
              CameraComponent={CameraComponent}
              cameraRef={cameraRef}
              enableTorch={enableTorch}
              flash={flash}
              onCameraReady={handleReady}
              onMountError={handleMountError}
            />
          )}
          <Pressable
            accessibilityLabel="Camera preview. Tap to focus on a subject."
            accessibilityRole="button"
            accessibilityHint="Focuses the camera at the position you tap."
            disabled={!appActive || !ready || disabled}
            onPress={handleTap}
            style={StyleSheet.absoluteFill}
          />
          {displayIndicator && (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Animated.View
                style={[
                  styles.focusBox,
                  {
                    left: displayIndicator.point.x * previewSize.width - CAMERA_FOCUS_SIZE / 2,
                    top: displayIndicator.point.y * previewSize.height - CAMERA_FOCUS_SIZE / 2,
                    borderColor: color,
                    shadowColor: color,
                    opacity,
                    transform: [{ scale }],
                  },
                ]}
              >
                {['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((corner) => (
                  <View key={corner} style={[styles.corner, styles[corner], { borderColor: color }]} />
                ))}
              </Animated.View>
              <Animated.View
                accessibilityLiveRegion="polite"
                style={[styles.focusStatus, { opacity }]}
              >
                <Text style={[styles.focusStatusText, { color }]}>
                  {STATUS_LABELS[displayIndicator.status]}
                </Text>
              </Animated.View>
            </View>
          )}
          <View pointerEvents="none" style={styles.frameBorder} />
        </View>
      )}
    </View>
  );
}));

const styles = StyleSheet.create({
  stage: { alignItems: 'center', justifyContent: 'center' },
  frame: { overflow: 'hidden', borderRadius: 24, backgroundColor: '#05090E' },
  frameBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
  },
  focusBox: {
    position: 'absolute', width: CAMERA_FOCUS_SIZE, height: CAMERA_FOCUS_SIZE,
    borderWidth: 1, borderRadius: 8,
    shadowOpacity: 0.5, shadowRadius: 5, shadowOffset: { width: 0, height: 0 },
  },
  corner: { position: 'absolute', width: 17, height: 17, borderWidth: 0 },
  topLeft: { left: -1, top: -1, borderLeftWidth: 2.5, borderTopWidth: 2.5, borderTopLeftRadius: 8 },
  topRight: { right: -1, top: -1, borderRightWidth: 2.5, borderTopWidth: 2.5, borderTopRightRadius: 8 },
  bottomLeft: { left: -1, bottom: -1, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderBottomLeftRadius: 8 },
  bottomRight: { right: -1, bottom: -1, borderRightWidth: 2.5, borderBottomWidth: 2.5, borderBottomRightRadius: 8 },
  focusStatus: {
    position: 'absolute', alignSelf: 'center', top: 14, paddingHorizontal: 14,
    paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(5,12,20,0.66)',
  },
  focusStatusText: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.3 },
});

