import { router, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  renderAdaptiveThresholdAsync,
  renderPerspectiveCropAsync,
} from '@/perspective-crop';

const cameraModule = getCameraModule();
const mediaLibraryModule = getMediaLibraryModule();
const CameraView = cameraModule?.CameraView;

function getCameraModule() {
  try {
    return require('expo-camera');
  } catch {
    return null;
  }
}

function getMediaLibraryModule() {
  try {
    return require('expo-media-library');
  } catch {
    return null;
  }
}

export default function ScreenTab() {
  if (
    !cameraModule?.CameraView ||
    !cameraModule?.useCameraPermissions ||
    !mediaLibraryModule?.usePermissions ||
    !mediaLibraryModule?.Asset?.create
  ) {
    return <CameraModuleUnavailable />;
  }

  return <CameraScreen />;
}

function CameraModuleUnavailable() {
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.centeredContent}>
        <ThemedText type="subtitle" style={styles.statusText}>
          Camera unavailable
        </ThemedText>
        <ThemedText style={styles.statusText} themeColor="textSecondary">
          This development build does not include the camera native module. Rebuild the development
          build after installing expo-camera and expo-media-library, then reload the app.
        </ThemedText>
        <ActivityIndicator color={theme.text} />
      </SafeAreaView>
    </ThemedView>
  );
}

function CameraScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef(null);
  const cameraRequestStarted = useRef(false);
  const [cameraPermission, requestCameraPermission] = cameraModule.useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = mediaLibraryModule.usePermissions({
    writeOnly: true,
  });
  const [isFocused, setIsFocused] = useState(true);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [savedImageMode, setSavedImageMode] = useState('original');
  const [blackAndWhitePhoto, setBlackAndWhitePhoto] = useState(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [cropCorners, setCropCorners] = useState(null);
  const [cameraError, setCameraError] = useState(null);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);

      return () => setIsFocused(false);
    }, [])
  );

  useEffect(() => {
    if (!cameraPermission || cameraPermission.granted || cameraRequestStarted.current) return;

    cameraRequestStarted.current = true;
    requestCameraPermission().then((permission) => {
      if (!permission.granted) {
        router.replace('/');
      }
    }).catch(() => router.replace('/'));
  }, [cameraPermission, requestCameraPermission]);

  const capturePhoto = async () => {
    if (!cameraRef.current || !isCameraReady || isCapturing) return;

    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({ format: 'png' });

      if (!photo?.uri) return;

      setCapturedPhoto(photo);
      setCropCorners(null);
    } catch {
      Alert.alert('Capture failed', 'We could not capture the image. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  };

  const discardPhoto = () => {
    setCapturedPhoto(null);
    setCropCorners(null);
    setIsCameraReady(false);
    setCameraError(null);
  };

  const closeSavedPhoto = () => {
    setSavedPhoto(null);
    setSavedImageMode('original');
    setBlackAndWhitePhoto(null);
    setIsCameraReady(false);
    setCameraError(null);
  };

  const displayedSavedPhoto =
    savedImageMode === 'blackAndWhite' && blackAndWhitePhoto ? blackAndWhitePhoto : savedPhoto;

  const selectSavedImageMode = async (mode) => {
    setSavedImageMode(mode);

    if (mode !== 'blackAndWhite' || blackAndWhitePhoto || isEnhancing || !savedPhoto) return;

    setIsEnhancing(true);

    try {
      const enhancedPhoto = await renderAdaptiveThresholdAsync({
        uri: savedPhoto.uri,
        sourceWidth: savedPhoto.width,
        sourceHeight: savedPhoto.height,
      });
      setBlackAndWhitePhoto(enhancedPhoto);
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Black & white enhancement failed', details);
      setSavedImageMode('original');
      Alert.alert(
        'Enhancement failed',
        __DEV__
          ? `We could not create the black-and-white preview.\n\n${details.message}`
          : 'We could not create the black-and-white preview. Please try again.'
      );
    } finally {
      setIsEnhancing(false);
    }
  };

  const saveSavedImage = async () => {
    if (!displayedSavedPhoto?.uri || isSavingPreview || isEnhancing) return;

    if (savedImageMode === 'original') {
      closeSavedPhoto();
      return;
    }

    setIsSavingPreview(true);

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save this image.');
        return;
      }

      await mediaLibraryModule.Asset.create(displayedSavedPhoto.uri);
      console.log('[screen] Selected image preview saved', {
        mode: savedImageMode,
        uri: displayedSavedPhoto.uri,
      });
      closeSavedPhoto();
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Selected image save failed', details);
      Alert.alert(
        'Save failed',
        __DEV__ ? `We could not save this image.\n\n${details.message}` : 'We could not save this image.'
      );
    } finally {
      setIsSavingPreview(false);
    }
  };

  const savePhoto = async () => {
    if (!capturedPhoto?.uri || isCapturing) return;

    setIsCapturing(true);
    const customCrop = hasCustomCrop(cropCorners);

    console.log('[screen] Save requested', {
      hasCapturedPhoto: Boolean(capturedPhoto.uri),
      sourceWidth: capturedPhoto.width ?? null,
      sourceHeight: capturedPhoto.height ?? null,
      customCrop,
      corners: cropCorners ?? 'default',
    });

    try {
      if (Platform.OS === 'web') {
        console.warn('[screen] Perspective crop save skipped on web.');
        Alert.alert('Not available', 'Saving photos is available on a mobile device.');
        return;
      }

      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission.granted) {
        console.warn('[screen] Media-library permission was not granted.');
        Alert.alert('Permission needed', 'Allow photo access to save captured images.');
        return;
      }

      const selectedPhoto = customCrop
        ? await renderPerspectiveCropAsync({
            uri: capturedPhoto.uri,
            corners: cropCorners,
            sourceWidth: capturedPhoto.width,
            sourceHeight: capturedPhoto.height,
          })
        : capturedPhoto;

      console.log('[screen] Image ready for media-library save', {
        uriAvailable: Boolean(selectedPhoto?.uri),
        width: selectedPhoto?.width ?? null,
        height: selectedPhoto?.height ?? null,
        customCrop,
      });

      const savedAsset = await mediaLibraryModule.Asset.create(selectedPhoto.uri);
      const savedWidth = typeof savedAsset?.getWidth === 'function'
        ? await savedAsset.getWidth()
        : savedAsset?.width ?? selectedPhoto.width ?? null;
      const savedHeight = typeof savedAsset?.getHeight === 'function'
        ? await savedAsset.getHeight()
        : savedAsset?.height ?? selectedPhoto.height ?? null;
      console.log('[screen] Media-library asset created', {
        id: savedAsset?.id ?? null,
        uri: savedAsset?.uri ?? selectedPhoto.uri,
        width: savedWidth,
        height: savedHeight,
      });
      setSavedPhoto(selectedPhoto);
      setSavedImageMode('original');
      setBlackAndWhitePhoto(null);
      setCapturedPhoto(null);
      setCropCorners(null);
      setIsCameraReady(false);
      console.log('[screen] Image saved successfully.');
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Save failed', details);
      if (details.stack) {
        console.error('[screen] Save failed stack\n' + details.stack);
      }
      Alert.alert(
        'Capture failed',
        __DEV__
          ? `We could not save the captured image.\n\n${details.message}`
          : 'We could not save the captured image. Please try again.'
      );
    } finally {
      setIsCapturing(false);
    }
  };

  if (savedPhoto) {
    return (
      <View style={styles.savedImageContainer}>
        <SafeAreaView style={styles.savedImageSafeArea}>
          <ThemedText type="subtitle" style={styles.savedImageTitle}>
            Saved image
          </ThemedText>

          <View style={styles.savedImageFrame}>
            <Image
              contentFit="contain"
              source={{ uri: displayedSavedPhoto?.uri ?? savedPhoto.uri }}
              style={styles.savedImage}
            />
            {isEnhancing && (
              <View style={styles.savedImageLoadingOverlay}>
                <ActivityIndicator color={Colors.light.background} />
              </View>
            )}
          </View>

          <View style={styles.savedImageToggleRow}>
            {[
              { label: 'Original', value: 'original' },
              { label: 'Black & White', value: 'blackAndWhite' },
              { label: 'Magic Color', value: 'magicColor' },
            ].map((option) => {
              const isActive = savedImageMode === option.value;

              return (
                <Pressable
                  key={option.value}
                  accessibilityLabel={`Show ${option.label.toLowerCase()} image`}
                  accessibilityRole="button"
                  disabled={isEnhancing || isSavingPreview}
                  onPress={() => selectSavedImageMode(option.value)}
                  style={({ pressed }) => [
                    styles.savedImageToggleButton,
                    isActive && styles.savedImageToggleButtonActive,
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText
                    type="smallBold"
                    style={[
                      styles.savedImageToggleText,
                      isActive && styles.savedImageToggleTextActive,
                    ]}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.savedImageActions}>
            <Pressable
              accessibilityLabel="Retake photo"
              accessibilityRole="button"
              disabled={isEnhancing || isSavingPreview}
              onPress={closeSavedPhoto}
              style={({ pressed }) => [
                styles.savedImageActionButton,
                styles.retakeButton,
                pressed && styles.pressed,
                (isEnhancing || isSavingPreview) && styles.disabled,
              ]}>
              <ThemedText type="smallBold">Retake</ThemedText>
            </Pressable>

            <Pressable
              accessibilityLabel="Save selected image"
              accessibilityRole="button"
              disabled={isEnhancing || isSavingPreview}
              onPress={saveSavedImage}
              style={({ pressed }) => [
                styles.savedImageActionButton,
                styles.saveButton,
                pressed && styles.pressed,
                (isEnhancing || isSavingPreview) && styles.disabled,
              ]}>
              {isSavingPreview ? (
                <ActivityIndicator color={Colors.light.background} />
              ) : (
                <ThemedText type="smallBold" style={styles.saveButtonText}>
                  Save
                </ThemedText>
              )}
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  if (capturedPhoto) {
    return (
      <View style={styles.reviewContainer}>
        <SafeAreaView style={styles.reviewSafeArea}>
          <ThemedText type="subtitle" style={styles.reviewTitle}>
            Review capture
          </ThemedText>

          <View style={styles.imageFrame}>
            <Image
              contentFit="contain"
              source={{ uri: capturedPhoto.uri }}
              style={styles.reviewImage}
            />
            <CropOverlay
              aspectRatio={
                capturedPhoto.width && capturedPhoto.height
                  ? capturedPhoto.width / capturedPhoto.height
                  : 4 / 3
              }
              corners={cropCorners}
              onCornersChange={setCropCorners}
            />
          </View>

          <View style={styles.reviewActions}>
            <Pressable
              accessibilityLabel="Discard captured image"
              accessibilityRole="button"
              disabled={isCapturing}
              onPress={discardPhoto}
              style={({ pressed }) => [
                styles.actionButton,
                styles.discardButton,
                pressed && styles.pressed,
                isCapturing && styles.disabled,
              ]}>
              <ThemedText type="smallBold">Discard</ThemedText>
            </Pressable>

            <Pressable
              accessibilityLabel="Save captured image"
              accessibilityRole="button"
              disabled={isCapturing}
              onPress={savePhoto}
              style={({ pressed }) => [
                styles.actionButton,
                styles.saveButton,
                pressed && styles.pressed,
                isCapturing && styles.disabled,
              ]}>
              {isCapturing ? (
                <ActivityIndicator color={Colors.light.background} />
              ) : (
                <ThemedText type="smallBold" style={styles.saveButtonText}>
                  Save
                </ThemedText>
              )}
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  if (!cameraPermission || !cameraPermission.granted) {
    return (
      <ThemedView style={styles.container}>
        <SafeAreaView style={styles.centeredContent}>
          <ActivityIndicator color={theme.text} />
          <ThemedText style={styles.statusText}>Requesting camera access…</ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <View style={styles.container}>
      {isFocused && (
        <CameraView
          ref={cameraRef}
          facing="back"
          ratio={Platform.OS === 'android' ? '4:3' : undefined}
          onCameraReady={() => setIsCameraReady(true)}
          onMountError={(event) => {
            setCameraError(event?.nativeEvent?.message ?? 'The camera preview could not start.');
          }}
          style={styles.camera}
        />
      )}

      <View
        pointerEvents="box-none"
        style={[styles.controls, { paddingBottom: insets.bottom + BottomTabInset + Spacing.three }]}>
        <Pressable
          accessibilityLabel="Capture photo"
          accessibilityRole="button"
          disabled={!isCameraReady || isCapturing}
          onPress={capturePhoto}
          style={({ pressed }) => [
            styles.captureButton,
            { borderColor: Colors.light.background },
            pressed && styles.pressed,
            (!isCameraReady || isCapturing) && styles.disabled,
          ]}>
          {isCapturing ? (
            <ActivityIndicator color={Colors.light.text} />
          ) : (
            <View style={[styles.captureButtonInner, { backgroundColor: Colors.light.background }]} />
          )}
        </Pressable>
      </View>

      {cameraError && (
        <View style={styles.errorOverlay} pointerEvents="none">
          <ThemedText style={styles.statusText}>{cameraError}</ThemedText>
        </View>
      )}
    </View>
  );
}

const edgeConnections = {
  top: ['topLeft', 'topRight'],
  right: ['topRight', 'bottomRight'],
  bottom: ['bottomRight', 'bottomLeft'],
  left: ['bottomLeft', 'topLeft'],
};

function CropOverlay({ aspectRatio, corners, onCornersChange }) {
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });

  const imageSize = getImageViewport(frameSize, aspectRatio);
  const visibleCorners = corners ?? getDefaultCorners();

  const edgePositions = Object.fromEntries(
    Object.entries(edgeConnections).map(([edge, [firstCorner, secondCorner]]) => {
      const first = visibleCorners[firstCorner];
      const second = visibleCorners[secondCorner];
      const midpoint = {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      };

      return [edge, midpoint];
    })
  );

  const updateCorner = (corner, position) => {
    onCornersChange((current) => ({
      ...(current ?? getDefaultCorners()),
      [corner]: clampPoint(position),
    }));
  };

  const updateEdge = (edge, position) => {
    const [firstCorner, secondCorner] = edgeConnections[edge];
    onCornersChange((current) => {
      const next = current ?? getDefaultCorners();
      const currentFirst = next[firstCorner];
      const currentSecond = next[secondCorner];
      const midpoint = {
        x: (currentFirst.x + currentSecond.x) / 2,
        y: (currentFirst.y + currentSecond.y) / 2,
      };
      const requestedDelta = {
        x: position.x - midpoint.x,
        y: position.y - midpoint.y,
      };
      const minX = Math.min(currentFirst.x, currentSecond.x);
      const maxX = Math.max(currentFirst.x, currentSecond.x);
      const minY = Math.min(currentFirst.y, currentSecond.y);
      const maxY = Math.max(currentFirst.y, currentSecond.y);
      const delta = {
        x: clamp(requestedDelta.x, -minX, 1 - maxX),
        y: clamp(requestedDelta.y, -minY, 1 - maxY),
      };

      return {
        ...next,
        [firstCorner]: {
          x: next[firstCorner].x + delta.x,
          y: next[firstCorner].y + delta.y,
        },
        [secondCorner]: {
          x: next[secondCorner].x + delta.x,
          y: next[secondCorner].y + delta.y,
        },
      };
    });
  };

  const lineSegments = Object.entries(edgeConnections).flatMap(([edge, [firstCorner, secondCorner]]) => [
    [visibleCorners[firstCorner], edgePositions[edge]],
    [edgePositions[edge], visibleCorners[secondCorner]],
  ]);

  return (
    <View
      pointerEvents="box-none"
      style={styles.cropOverlay}
      onLayout={({ nativeEvent }) => {
        const { width, height } = nativeEvent.layout;
        setFrameSize({ width, height });
      }}>
      {imageSize.width > 0 && imageSize.height > 0 && (
        <View
          pointerEvents="box-none"
          style={[
            styles.cropViewport,
            {
              width: imageSize.width,
              height: imageSize.height,
              left: imageSize.left,
              top: imageSize.top,
            },
          ]}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {lineSegments.map(([start, end], index) => (
              <View key={index} style={getLineStyle(start, end, imageSize)} />
            ))}
          </View>

          {Object.entries(visibleCorners).map(([corner, position]) => (
            <DraggableHandle
              key={corner}
              label={`Move ${corner} crop corner`}
              position={position}
              size={imageSize}
              onDrag={(nextPosition) => updateCorner(corner, nextPosition)}
            />
          ))}

          {Object.entries(edgePositions).map(([edge, position]) => (
            <DraggableHandle
              key={edge}
              label={`Move ${edge} crop edge`}
              position={position}
              size={imageSize}
              isEdge
              onDrag={(nextPosition) => updateEdge(edge, nextPosition)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function DraggableHandle({ label, position, size, isEdge = false, onDrag }) {
  const positionRef = useRef(position);
  const startPositionRef = useRef(position);
  const onDragRef = useRef(onDrag);

  positionRef.current = position;
  onDragRef.current = onDrag;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startPositionRef.current = positionRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        onDragRef.current({
          x: startPositionRef.current.x + gestureState.dx / size.width,
          y: startPositionRef.current.y + gestureState.dy / size.height,
        });
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  const handleSize = isEdge ? 18 : 22;

  return (
    <View
      accessible
      accessibilityLabel={label}
      {...panResponder.panHandlers}
      style={[
        styles.cropHandle,
        isEdge && styles.edgeHandle,
        {
          left: position.x * size.width - handleSize / 2,
          top: position.y * size.height - handleSize / 2,
          width: handleSize,
          height: handleSize,
          borderRadius: handleSize / 2,
        },
      ]}
    />
  );
}

function clampPoint(point) {
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function hasCustomCrop(corners) {
  if (!corners) return false;

  const defaults = getDefaultCorners();
  return Object.keys(defaults).some((corner) => {
    if (!corners[corner]) return true;

    return (
      Math.abs(corners[corner].x - defaults[corner].x) > 0.0001 ||
      Math.abs(corners[corner].y - defaults[corner].y) > 0.0001
    );
  });
}

function getErrorDetails(error) {
  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown error',
      stack: error.stack || null,
    };
  }

  return {
    message: String(error || 'Unknown error'),
    stack: null,
  };
}

function getDefaultCorners() {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  };
}

function getImageViewport(frameSize, aspectRatio) {
  if (!frameSize.width || !frameSize.height || !aspectRatio) {
    return { width: 0, height: 0, left: 0, top: 0 };
  }

  const frameRatio = frameSize.width / frameSize.height;

  if (frameRatio > aspectRatio) {
    const height = frameSize.height;
    const width = height * aspectRatio;
    return {
      width,
      height,
      left: (frameSize.width - width) / 2,
      top: 0,
    };
  }

  const width = frameSize.width;
  const height = width / aspectRatio;
  return {
    width,
    height,
    left: 0,
    top: (frameSize.height - height) / 2,
  };
}

function getLineStyle(start, end, size) {
  const startX = start.x * size.width;
  const startY = start.y * size.height;
  const endX = end.x * size.width;
  const endY = end.y * size.height;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const length = Math.sqrt(deltaX ** 2 + deltaY ** 2);
  const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;

  return {
    position: 'absolute',
    left: (startX + endX) / 2 - length / 2,
    top: (startY + endY) / 2 - 1,
    width: length,
    height: 2,
    backgroundColor: '#ffffff',
    opacity: 0.9,
    transform: [{ rotate: `${angle}deg` }],
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  camera: {
    flex: 1,
  },
  centeredContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  statusText: {
    textAlign: 'center',
  },
  reviewContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  savedImageContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  reviewSafeArea: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  savedImageSafeArea: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  reviewTitle: {
    color: Colors.light.background,
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  savedImageTitle: {
    color: Colors.light.background,
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  imageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    position: 'relative',
    borderRadius: Spacing.two,
    backgroundColor: '#111111',
    overflow: 'hidden',
  },
  reviewImage: {
    flex: 1,
    width: '100%',
  },
  savedImageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    position: 'relative',
    borderRadius: Spacing.two,
    backgroundColor: '#111111',
    overflow: 'hidden',
  },
  savedImage: {
    flex: 1,
    width: '100%',
  },
  savedImageLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  savedImageToggleRow: {
    width: '100%',
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  savedImageToggleButton: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    borderWidth: 1,
    borderColor: '#5c5c5c',
    paddingHorizontal: Spacing.two,
  },
  savedImageToggleButtonActive: {
    borderWidth: 2,
    borderColor: '#3c87f7',
  },
  savedImageToggleText: {
    color: '#b9b9b9',
  },
  savedImageToggleTextActive: {
    color: Colors.light.background,
  },
  cropOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
  },
  cropViewport: {
    position: 'absolute',
  },
  cropHandle: {
    position: 'absolute',
    zIndex: 3,
    backgroundColor: '#3c87f7',
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  edgeHandle: {
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#3c87f7',
  },
  reviewActions: {
    width: '100%',
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
  },
  actionButton: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  discardButton: {
    backgroundColor: '#2b2b2b',
  },
  saveButton: {
    backgroundColor: '#3c87f7',
  },
  saveButtonText: {
    color: Colors.light.background,
  },
  savedImageActions: {
    width: '100%',
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  savedImageActionButton: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  retakeButton: {
    backgroundColor: '#2b2b2b',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  errorOverlay: {
    position: 'absolute',
    top: Spacing.four,
    left: Spacing.four,
    right: Spacing.four,
    alignItems: 'center',
    padding: Spacing.two,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  captureButton: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
