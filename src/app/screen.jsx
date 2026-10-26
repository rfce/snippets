import { useFocusEffect, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Platform,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  renderMagicColorAsync,
  renderAdaptiveThresholdAsync,
  renderPerspectiveCropAsync,
} from '@/perspective-crop';
import {
  appendUniqueMediaLibraryImages,
  normalizeMediaLibraryImage,
  saveToSnippetsAlbum,
} from '@/snippets-library';

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

const FLASH_MODES = [
  {
    value: 'off',
    label: 'Flash disabled',
    icon: { ios: 'bolt.slash.fill', android: 'flash_off', web: 'flash_off' },
  },
  {
    value: 'flash',
    label: 'Flash on for capture',
    icon: { ios: 'bolt.fill', android: 'flash_on', web: 'flash_on' },
  },
  {
    value: 'torch',
    label: 'Torch on continuously',
    icon: { ios: 'flashlight.on.fill', android: 'flashlight_on', web: 'flashlight_on' },
  },
];

const GALLERY_PAGE_SIZE = 36;
const TEAL_ACCENT = '#16C7B7';
const REVIEW_DISCARD_ACCENT = '#C2415A';
const REVIEW_NEXT_ACCENT = '#3C78D8';
const PREVIEW_RETAKE_ACCENT = '#C2415A';
const PREVIEW_SAVE_ACCENT = '#2F9E72';
const PREVIEW_BACKGROUND = '#F5F7FA';
const PREVIEW_SURFACE = '#FFFFFF';
const PREVIEW_IMAGE_SURFACE = '#E9EEF5';
const PREVIEW_BORDER = '#DCE4ED';
const PREVIEW_TEXT = '#122033';
const PREVIEW_MUTED = '#667085';
const REVIEW_BACKGROUND = '#FFFFFF';
const REVIEW_SURFACE = '#F7F9FC';
const REVIEW_BORDER = '#E4EAF2';
const REVIEW_TEXT = '#0F172A';
const REVIEW_MUTED = '#64748B';
const REVIEW_SOFT_ACCENT = '#EEF4FF';

const SAVED_IMAGE_OPTIONS = [
  { label: 'Original', value: 'original' },
  { label: 'Black & White', value: 'blackAndWhite' },
  { label: 'Magic Color', value: 'magicColor' },
];

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

export function ErrorBoundary({ error, retry }) {
  const diagnostic = createDiagnosticDetails('Screen render', error);

  return (
    <View style={styles.diagnosticScreen}>
      <SafeAreaView style={styles.diagnosticScreenSafeArea}>
        <ThemedText type="subtitle" style={styles.diagnosticTitle}>
          Screen error
        </ThemedText>
        <ThemedText style={styles.diagnosticIntro}>
          The screen could not render. The full preview-build error is shown below.
        </ThemedText>
        <DiagnosticDetails diagnostic={diagnostic} />
        <Pressable
          accessibilityLabel="Retry screen"
          accessibilityRole="button"
          onPress={retry}
          style={({ pressed }) => [styles.diagnosticRetryButton, pressed && styles.pressed]}>
          <ThemedText type="smallBold" style={styles.saveButtonText}>
            Retry
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </View>
  );
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
  const router = useRouter();
  const cameraRef = useRef(null);
  const cameraRequestStarted = useRef(false);
  const galleryLoadingRef = useRef(false);
  const recentImageLoadStartedRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = cameraModule.useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = mediaLibraryModule.usePermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const [isFocused, setIsFocused] = useState(true);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [flashMode, setFlashMode] = useState('off');
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [savedImageMode, setSavedImageMode] = useState('original');
  const [blackAndWhitePhoto, setBlackAndWhitePhoto] = useState(null);
  const [magicColorPhoto, setMagicColorPhoto] = useState(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [capturedRotation, setCapturedRotation] = useState(0);
  const [cropCorners, setCropCorners] = useState(null);
  const [reviewFrameSize, setReviewFrameSize] = useState({ width: 0, height: 0 });
  const [cameraError, setCameraError] = useState(null);
  const [diagnosticError, setDiagnosticError] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [galleryAssets, setGalleryAssets] = useState([]);
  const [hasMoreGallery, setHasMoreGallery] = useState(true);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  const [recentGalleryImage, setRecentGalleryImage] = useState(null);
  const savedImageModeAnimation = useRef(new Animated.Value(0)).current;
  const savedImageLiquidScale = useRef(new Animated.Value(1)).current;
  const savedImageModeAnimationStarted = useRef(false);
  const [savedImageToggleRowWidth, setSavedImageToggleRowWidth] = useState(0);

  const reportDiagnostic = useCallback((operation, error, context = {}) => {
    const diagnostic = createDiagnosticDetails(operation, error, context);
    console.error('[screen] Runtime diagnostic', diagnostic);
    setDiagnosticError(diagnostic);
    return diagnostic;
  }, []);

  const diagnosticOverlay = diagnosticError ? (
    <VerboseErrorNotice
      diagnostic={diagnosticError}
      onDismiss={() => setDiagnosticError(null)}
    />
  ) : null;

  const loadRecentGalleryImage = useCallback(async () => {
    if (recentImageLoadStartedRef.current) return;

    recentImageLoadStartedRef.current = true;

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission?.granted) return;

      const page = await queryGalleryPage(0, 1);
      const [recentImage] = await Promise.all(
        page.assets.slice(0, 1).map(normalizeMediaLibraryImage)
      );

      if (recentImage?.uri) {
        setRecentGalleryImage(recentImage);
      }
    } catch {
      // The preview is optional. Keep the camera usable when photo access is
      // unavailable or the device has no recent image.
    }
  }, [mediaPermission, requestMediaPermission]);

  const loadGalleryPage = useCallback(async (reset = false) => {
    if (galleryLoadingRef.current || (!reset && !hasMoreGallery)) return;

    galleryLoadingRef.current = true;
    setIsLoadingGallery(true);

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission?.granted) {
        throw new Error('Photo-library permission was not granted.');
      }

      const offset = reset ? 0 : galleryAssets.length;
      const page = await queryGalleryPage(offset, GALLERY_PAGE_SIZE);
      const normalizedAssets = await Promise.all(page.assets.map(normalizeMediaLibraryImage));
      const usableAssets = normalizedAssets.filter((asset) => asset?.uri);

      setGalleryAssets((current) =>
        reset
          ? appendUniqueMediaLibraryImages([], usableAssets)
          : appendUniqueMediaLibraryImages(current, usableAssets)
      );
      setHasMoreGallery(page.hasNextPage ?? usableAssets.length === GALLERY_PAGE_SIZE);
    } catch (error) {
      reportDiagnostic('Load gallery images', error, {
        reset,
        requestedOffset: reset ? 0 : galleryAssets.length,
        pageSize: GALLERY_PAGE_SIZE,
      });
    } finally {
      galleryLoadingRef.current = false;
      setIsLoadingGallery(false);
    }
  }, [
    galleryAssets.length,
    hasMoreGallery,
    mediaPermission,
    requestMediaPermission,
    reportDiagnostic,
  ]);

  const openImportImage = async () => {
    setIsImporting(true);
    setGalleryAssets([]);
    setHasMoreGallery(true);
    await loadGalleryPage(true);
  };

  const closeImportImage = () => {
    setIsImporting(false);
    setIsCameraReady(false);
  };

  const selectGalleryImage = useCallback((asset) => {
    setCapturedPhoto({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      fileName: asset.fileName ?? null,
    });
    setCropCorners(null);
    setCapturedRotation(0);
    setIsImporting(false);
    setIsCameraReady(false);
  }, []);

  const renderGalleryItem = useCallback(
    ({ item }) => <GalleryImportTile item={item} onSelect={selectGalleryImage} />,
    [selectGalleryImage]
  );

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
        router.replace('/explore');
      }
    }).catch(() => router.replace('/explore'));
  }, [cameraPermission, requestCameraPermission, router]);

  useEffect(() => {
    if (cameraPermission?.granted) {
      loadRecentGalleryImage();
    }
  }, [cameraPermission?.granted, loadRecentGalleryImage]);

  const capturePhoto = async () => {
    if (!cameraRef.current || !isCameraReady || isCapturing) return;

    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        format: 'jpg',
        quality: 0.92,
        shutterSound: false,
      });

      if (!photo?.uri) {
        throw new Error('Camera capture completed without returning a photo URI.');
      }

      setCapturedPhoto(photo);
      setCropCorners(null);
      setCapturedRotation(0);
    } catch (error) {
      reportDiagnostic('Capture photo', error, {
        flashMode,
        cameraReady: isCameraReady,
      });
    } finally {
      setIsCapturing(false);
    }
  };

  const discardPhoto = () => {
    setCapturedPhoto(null);
    setCropCorners(null);
    setCapturedRotation(0);
    setIsCameraReady(false);
    setCameraError(null);
  };

  const rotateCapturedPhoto = () => {
    if (!capturedPhoto?.uri || isCapturing) return;

    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'Image rotation is available on a mobile device.');
      return;
    }

    // Keep rotation as an instant display transform. The pixels are baked once
    // on Next together with any perspective crop, avoiding a GL render per tap.
    setCapturedRotation((current) => (current + 90) % 360);
    setCropCorners(null);
  };

  const closeSavedPhoto = () => {
    setSavedPhoto(null);
    setSavedImageMode('original');
    setBlackAndWhitePhoto(null);
    setMagicColorPhoto(null);
    setIsCameraReady(false);
    setCameraError(null);
  };

  const displayedSavedPhoto =
    savedImageMode === 'blackAndWhite' && blackAndWhitePhoto
      ? blackAndWhitePhoto
      : savedImageMode === 'magicColor' && magicColorPhoto
        ? magicColorPhoto
        : savedPhoto;

  const savedImageModeIndex = Math.max(
    0,
    SAVED_IMAGE_OPTIONS.findIndex((option) => option.value === savedImageMode)
  );
  const savedImageToggleItemWidth =
    savedImageToggleRowWidth > 0
      ? (savedImageToggleRowWidth - Spacing.half * 2 - Spacing.two * 2) / 3
      : 0;
  const savedImageLiquidStep = savedImageToggleItemWidth + Spacing.two;
  const savedImageLiquidTranslateX = savedImageModeAnimation.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, savedImageLiquidStep, savedImageLiquidStep * 2],
  });

  const reviewImageAspectRatio =
    capturedPhoto?.width && capturedPhoto?.height
      ? capturedRotation % 180 === 0
        ? capturedPhoto.width / capturedPhoto.height
        : capturedPhoto.height / capturedPhoto.width
      : 4 / 3;
  const reviewImageSize = getImageViewport(reviewFrameSize, reviewImageAspectRatio);

  useEffect(() => {
    if (!savedImageModeAnimationStarted.current) {
      savedImageModeAnimation.setValue(savedImageModeIndex);
      savedImageModeAnimationStarted.current = true;
      return undefined;
    }

    Animated.parallel([
      Animated.spring(savedImageModeAnimation, {
        toValue: savedImageModeIndex,
        friction: 9,
        tension: 120,
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(savedImageLiquidScale, {
          toValue: 1.1,
          duration: 120,
          useNativeDriver: true,
        }),
        Animated.spring(savedImageLiquidScale, {
          toValue: 1,
          friction: 5,
          tension: 90,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    return undefined;
  }, [
    savedImageLiquidScale,
    savedImageModeAnimation,
    savedImageModeIndex,
  ]);

  const selectSavedImageMode = async (mode) => {
    setSavedImageMode(mode);

    const hasCachedPreview =
      (mode === 'blackAndWhite' && blackAndWhitePhoto) ||
      (mode === 'magicColor' && magicColorPhoto);

    if (
      (mode !== 'blackAndWhite' && mode !== 'magicColor') ||
      hasCachedPreview ||
      isEnhancing ||
      !savedPhoto
    ) {
      return;
    }

    setIsEnhancing(true);

    try {
      const enhancedPhoto = mode === 'blackAndWhite'
        ? await renderAdaptiveThresholdAsync({
            uri: savedPhoto.uri,
            sourceWidth: savedPhoto.width,
            sourceHeight: savedPhoto.height,
          })
        : await renderMagicColorAsync({
            uri: savedPhoto.uri,
            sourceWidth: savedPhoto.width,
            sourceHeight: savedPhoto.height,
          });

      if (mode === 'blackAndWhite') {
        setBlackAndWhitePhoto(enhancedPhoto);
      } else {
        setMagicColorPhoto(enhancedPhoto);
      }
    } catch (error) {
      const details = getErrorDetails(error);
      console.error(`[screen] ${mode} enhancement failed`, details);
      setSavedImageMode('original');
      reportDiagnostic(`${mode} enhancement`, error, {
        mode,
        sourceUri: savedPhoto?.uri ?? null,
        sourceWidth: savedPhoto?.width ?? null,
        sourceHeight: savedPhoto?.height ?? null,
      });
    } finally {
      setIsEnhancing(false);
    }
  };

  const saveSavedImage = async () => {
    if (!displayedSavedPhoto?.uri || isSavingPreview || isEnhancing) return;

    setIsSavingPreview(true);

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission?.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save this image.');
        return;
      }

      await saveToSnippetsAlbum(mediaLibraryModule, displayedSavedPhoto.uri);
      setRecentGalleryImage({
        uri: displayedSavedPhoto.uri,
        width: displayedSavedPhoto.width,
        height: displayedSavedPhoto.height,
        fileName: displayedSavedPhoto.fileName ?? null,
      });
      console.log('[screen] Final image saved', {
        mode: savedImageMode,
        uri: displayedSavedPhoto.uri,
      });
      closeSavedPhoto();
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Final image save failed', details);
      reportDiagnostic('Save final image', error, {
        mode: savedImageMode,
        sourceUri: displayedSavedPhoto?.uri ?? null,
      });
    } finally {
      setIsSavingPreview(false);
    }
  };

  const continueToSavedImage = async () => {
    if (!capturedPhoto?.uri || isCapturing) return;

    setIsCapturing(true);
    const customCrop = hasCustomCrop(cropCorners);
    const needsProcessing = customCrop || capturedRotation !== 0;

    console.log('[screen] Next requested', {
      hasCapturedPhoto: Boolean(capturedPhoto.uri),
      sourceWidth: capturedPhoto.width ?? null,
      sourceHeight: capturedPhoto.height ?? null,
      customCrop,
      rotation: capturedRotation,
      corners: cropCorners ?? 'default',
    });

    try {
      if (needsProcessing && Platform.OS === 'web') {
        console.warn('[screen] Perspective crop skipped on web.');
        Alert.alert('Not available', 'Image rotation and cropping are available on a mobile device.');
        return;
      }

      const selectedPhoto = needsProcessing
        ? await renderPerspectiveCropAsync({
            uri: capturedPhoto.uri,
            corners: cropCorners ?? getDefaultCorners(),
            sourceWidth: capturedPhoto.width,
            sourceHeight: capturedPhoto.height,
            rotation: capturedRotation,
          })
        : capturedPhoto;

      console.log('[screen] Image ready for enhancement', {
        uriAvailable: Boolean(selectedPhoto?.uri),
        width: selectedPhoto?.width ?? null,
        height: selectedPhoto?.height ?? null,
        customCrop,
        rotation: capturedRotation,
      });

      setSavedPhoto(selectedPhoto);
      setSavedImageMode('original');
      setBlackAndWhitePhoto(null);
      setMagicColorPhoto(null);
      setCapturedPhoto(null);
      setCropCorners(null);
      setCapturedRotation(0);
      setIsCameraReady(false);
      console.log('[screen] Image prepared for final save.');
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Preparing image failed', details);
      if (details.stack) {
        console.error('[screen] Save failed stack\n' + details.stack);
      }
      reportDiagnostic('Prepare captured image', error, {
        sourceUri: capturedPhoto?.uri ?? null,
        sourceWidth: capturedPhoto?.width ?? null,
        sourceHeight: capturedPhoto?.height ?? null,
        customCrop,
        cropCorners,
      });
    } finally {
      setIsCapturing(false);
    }
  };

  if (isImporting) {
    return (
      <>
        <View style={styles.importContainer}>
          <SafeAreaView style={styles.importSafeArea}>
            <View style={styles.importHeader}>
              <Pressable
                accessibilityLabel="Close import image gallery"
                accessibilityRole="button"
                onPress={closeImportImage}
                style={({ pressed }) => [styles.importBackButton, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                  size={22}
                  tintColor={Colors.light.background}
                />
              </Pressable>
              <ThemedText type="subtitle" style={styles.importTitle}>
                Import Image
              </ThemedText>
              <View style={styles.importHeaderSpacer} />
            </View>

            {galleryAssets.length === 0 && isLoadingGallery ? (
              <View style={styles.importEmptyState}>
                <ActivityIndicator color={Colors.light.background} />
                <ThemedText style={styles.importEmptyText}>
                  Loading gallery images…
                </ThemedText>
              </View>
            ) : galleryAssets.length === 0 ? (
              <View style={styles.importEmptyState}>
                <SymbolView
                  name={{ ios: 'photo.on.rectangle.angled', android: 'photo_library', web: 'photo_library' }}
                  size={48}
                  tintColor="#b9b9b9"
                />
                <ThemedText style={styles.importEmptyText}>
                  No gallery images were found.
                </ThemedText>
                <Pressable
                  accessibilityLabel="Retry loading gallery images"
                  accessibilityRole="button"
                  onPress={() => loadGalleryPage(true)}
                  style={({ pressed }) => [styles.importRetryButton, pressed && styles.pressed]}>
                  <ThemedText type="smallBold" style={styles.saveButtonText}>
                    Retry
                  </ThemedText>
                </Pressable>
              </View>
            ) : (
              <FlatList
                data={galleryAssets}
                keyExtractor={(item) => item.id || item.uri}
                numColumns={3}
                contentContainerStyle={styles.galleryGrid}
                columnWrapperStyle={styles.galleryRow}
                renderItem={renderGalleryItem}
                initialNumToRender={12}
                maxToRenderPerBatch={9}
                windowSize={5}
                updateCellsBatchingPeriod={50}
                removeClippedSubviews={Platform.OS === 'android'}
                onEndReached={() => loadGalleryPage(false)}
                onEndReachedThreshold={0.6}
                ListFooterComponent={
                  isLoadingGallery ? (
                    <View style={styles.galleryLoadingFooter}>
                      <ActivityIndicator color={Colors.light.background} />
                    </View>
                  ) : null
                }
              />
            )}
          </SafeAreaView>
        </View>
        {diagnosticOverlay}
      </>
    );
  }

  if (savedPhoto) {
    return (
      <>
        <View style={styles.savedImageContainer}>
          <SafeAreaView
            style={[
              styles.savedImageSafeArea,
              { paddingBottom: Spacing.three },
            ]}>
             <ThemedText type="default" style={styles.savedImageTitle}>
               Preview
            </ThemedText>

            <View style={styles.savedImageFrame}>
              <Image
                contentFit="contain"
                source={{ uri: displayedSavedPhoto?.uri ?? savedPhoto.uri }}
                style={styles.savedImage}
              />
              {isEnhancing && (
                <View style={styles.savedImageLoadingOverlay}>
                  <ActivityIndicator color={TEAL_ACCENT} />
                </View>
              )}
            </View>

            <View
              style={styles.savedImageToggleRow}
              onLayout={({ nativeEvent }) => {
                setSavedImageToggleRowWidth(nativeEvent.layout.width);
              }}>
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.savedImageLiquid,
                  {
                    width: savedImageToggleItemWidth,
                    transform: [
                      { translateX: savedImageLiquidTranslateX },
                      { scaleX: savedImageLiquidScale },
                    ],
                  },
                ]}
              />
              {SAVED_IMAGE_OPTIONS.map((option) => {
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
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText
                      type="default"
                      allowFontScaling={false}
                      numberOfLines={1}
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

              <View
                style={[
                  styles.savedImageActions,
                  styles.previewActions,
                  { paddingBottom: insets.bottom + Spacing.two },
                ]}>
                <Pressable
                 accessibilityLabel="Retake photo"
                 accessibilityRole="button"
                 disabled={isEnhancing || isSavingPreview}
                 onPress={closeSavedPhoto}
                   style={({ pressed }) => [
                     styles.savedImageActionButton,
                     styles.previewActionButton,
                     styles.previewRetakeButton,
                     pressed && styles.pressed,
                     (isEnhancing || isSavingPreview) && styles.disabled,
                  ]}>
                  <SymbolView
                    name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
                    size={30}
                    tintColor={PREVIEW_RETAKE_ACCENT}
                  />
                  <ThemedText
                    type="smallBold"
                    allowFontScaling={false}
                    style={styles.previewRetakeText}>
                    Retake
                  </ThemedText>
              </Pressable>

              <Pressable
                accessibilityLabel="Save selected image"
                accessibilityRole="button"
                disabled={isEnhancing || isSavingPreview}
                onPress={saveSavedImage}
                   style={({ pressed }) => [
                     styles.savedImageActionButton,
                     styles.previewActionButton,
                     styles.previewSaveButton,
                     pressed && styles.pressed,
                     (isEnhancing || isSavingPreview) && styles.disabled,
                 ]}>
                 {isSavingPreview ? (
                    <ActivityIndicator color={PREVIEW_SAVE_ACCENT} />
                   ) : (
                     <SymbolView
                       name={{ ios: 'arrow.down.circle.fill', android: 'download', web: 'download' }}
                       size={30}
                       tintColor={PREVIEW_SAVE_ACCENT}
                    />
                  )}
                  {!isSavingPreview && (
                    <ThemedText
                      type="smallBold"
                      allowFontScaling={false}
                      style={styles.previewSaveText}>
                      Save
                    </ThemedText>
                 )}
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
        {diagnosticOverlay}
      </>
    );
  }

  if (capturedPhoto) {
    return (
      <>
        <View style={styles.reviewContainer}>
          <SafeAreaView
            style={[
              styles.reviewSafeArea,
              { paddingBottom: Spacing.three },
            ]}>
            <View style={styles.reviewHeader}>
              <ThemedText type="default" style={styles.reviewTitle}>
                Review capture
              </ThemedText>
              <View style={styles.reviewReadyBadge}>
                <SymbolView
                  name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                  size={17}
                  tintColor={REVIEW_NEXT_ACCENT}
                />
                <ThemedText type="smallBold" style={styles.reviewReadyText}>
                  Ready
                </ThemedText>
              </View>
            </View>

            <View
              style={styles.imageFrame}
              onLayout={({ nativeEvent }) => {
                const { width, height } = nativeEvent.layout;
                setReviewFrameSize({ width, height });
              }}>
              {reviewImageSize.width > 0 && reviewImageSize.height > 0 && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.reviewImageViewport,
                    {
                      width: reviewImageSize.width,
                      height: reviewImageSize.height,
                      left: reviewImageSize.left,
                      top: reviewImageSize.top,
                    },
                  ]}>
                  <Image
                    contentFit="contain"
                    source={{ uri: capturedPhoto.uri }}
                    style={[
                      styles.reviewImage,
                      {
                        width:
                          capturedRotation % 180 !== 0
                            ? reviewImageSize.height
                            : reviewImageSize.width,
                        height:
                          capturedRotation % 180 !== 0
                            ? reviewImageSize.width
                            : reviewImageSize.height,
                        left:
                          capturedRotation % 180 !== 0
                            ? (reviewImageSize.width - reviewImageSize.height) / 2
                            : 0,
                        top:
                          capturedRotation % 180 !== 0
                            ? (reviewImageSize.height - reviewImageSize.width) / 2
                            : 0,
                        ...(capturedRotation !== 0 && {
                          transform: [{ rotate: `${capturedRotation}deg` }],
                        }),
                      },
                    ]}
                  />
                </View>
              )}
              <CropOverlay
                aspectRatio={reviewImageAspectRatio}
                corners={cropCorners}
                onCornersChange={setCropCorners}
              />
            </View>

            <View style={styles.reviewInstruction}>
              <SymbolView
                name={{ ios: 'hand.draw.fill', android: 'pan_tool', web: 'pan_tool' }}
                size={17}
                tintColor={REVIEW_NEXT_ACCENT}
              />
              <ThemedText style={styles.reviewInstructionText}>
                Drag the handles to fine-tune your crop
              </ThemedText>
            </View>

            <Pressable
              accessibilityLabel="Rotate image 90 degrees clockwise"
              accessibilityRole="button"
              disabled={isCapturing}
              onPress={rotateCapturedPhoto}
              style={({ pressed }) => [
                styles.reviewRotateButton,
                pressed && styles.pressed,
                isCapturing && styles.disabled,
              ]}>
              <SymbolView
                name={{ ios: 'arrow.clockwise', android: 'rotate_right', web: 'rotate_right' }}
                size={22}
                tintColor={REVIEW_NEXT_ACCENT}
              />
              <ThemedText type="smallBold" style={styles.reviewRotateText}>
                Rotate
              </ThemedText>
            </Pressable>

            <View style={[styles.savedImageActions, styles.reviewActions]}>
              <Pressable
                accessibilityLabel="Discard captured image"
                accessibilityRole="button"
                disabled={isCapturing}
                onPress={discardPhoto}
                style={({ pressed }) => [
                  styles.savedImageActionButton,
                  styles.reviewActionButton,
                  styles.reviewDiscardAction,
                  pressed && styles.pressed,
                  isCapturing && styles.disabled,
                ]}>
                <SymbolView
                  name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
                  size={30}
                  tintColor={REVIEW_DISCARD_ACCENT}
                />
                <ThemedText
                  type="smallBold"
                  allowFontScaling={false}
                  style={styles.reviewDiscardText}>
                  Discard
                </ThemedText>
              </Pressable>

              <Pressable
                accessibilityLabel="Next"
                accessibilityRole="button"
                disabled={isCapturing}
                onPress={continueToSavedImage}
                style={({ pressed }) => [
                  styles.savedImageActionButton,
                  styles.reviewActionButton,
                  styles.reviewNextAction,
                  pressed && styles.pressed,
                  isCapturing && styles.disabled,
                ]}>
                <ThemedText
                  type="smallBold"
                  allowFontScaling={false}
                  style={[styles.reviewNextText, styles.reviewNextTextOnAccent]}>
                  Next
                </ThemedText>
                {isCapturing ? (
                  <ActivityIndicator color={REVIEW_BACKGROUND} />
                ) : (
                  <SymbolView
                    name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                    size={30}
                    tintColor={REVIEW_BACKGROUND}
                  />
                )}
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
        {diagnosticOverlay}
      </>
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
          enableTorch={flashMode === 'torch'}
          facing="back"
          flash={flashMode === 'flash' ? 'on' : 'off'}
          ratio={Platform.OS === 'android' ? '4:3' : undefined}
          onCameraReady={() => setIsCameraReady(true)}
          onMountError={(event) => {
            const message = event?.nativeEvent?.message ?? 'The camera preview could not start.';
            setCameraError(message);
            reportDiagnostic('Camera startup', event?.nativeEvent ?? new Error(message), {
              nativeEvent: event?.nativeEvent ?? null,
            });
          }}
          style={styles.camera}
        />
      )}

      {isFocused && (
        <Pressable
          accessibilityLabel="Close camera"
          accessibilityRole="button"
          onPress={() => router.replace('/explore')}
          style={({ pressed }) => [
            styles.cameraCloseButton,
            { top: insets.top + Spacing.three },
            pressed && styles.pressed,
          ]}>
          <SymbolView
            name={{ ios: 'xmark', android: 'close', web: 'close' }}
            size={22}
            tintColor="#dedede"
          />
        </Pressable>
      )}

      {isFocused && (
        <Pressable
          accessibilityLabel={`Flash mode: ${getFlashModeLabel(flashMode)}. Tap to change.`}
          accessibilityRole="button"
          accessibilityState={{ selected: flashMode !== 'off' }}
           onPress={() => setFlashMode(getNextFlashMode(flashMode))}
           style={({ pressed }) => [
             styles.flashModeButton,
             { top: insets.top + Spacing.three },
             pressed && styles.pressed,
           ]}>
          <SymbolView
            name={getFlashModeIcon(flashMode)}
            size={22}
            tintColor={flashMode === 'off' ? '#dedede' : Colors.light.background}
          />
        </Pressable>
      )}

      <View
        pointerEvents="box-none"
        style={[styles.controls, { paddingBottom: insets.bottom + Spacing.three }]}> 
        <View style={styles.captureControlsRow}>
          <Pressable
            accessibilityLabel="Import images. Shows the most recent image."
            accessibilityRole="button"
            disabled={isCapturing}
            onPress={openImportImage}
            style={({ pressed }) => [
              styles.importButton,
              pressed && styles.pressed,
              isCapturing && styles.disabled,
            ]}>
            <View style={styles.importImageFrame}>
              {recentGalleryImage?.uri ? (
                <Image
                  contentFit="cover"
                  source={recentGalleryImage.uri}
                  style={styles.importImagePreview}
                  transition={180}
                />
              ) : null}
            </View>
          </Pressable>

          <Pressable
            accessibilityLabel="Capture photo"
            accessibilityRole="button"
            disabled={!isCameraReady || isCapturing}
            onPress={capturePhoto}
            style={({ pressed }) => [
              styles.captureButton,
              { borderColor: '#16C7B7' },
              pressed && styles.pressed,
              (!isCameraReady || isCapturing) && styles.disabled,
            ]}>
            {isCapturing ? (
              <ActivityIndicator color={Colors.light.text} />
            ) : (
              <View style={[styles.captureButtonInner, { backgroundColor: Colors.light.background }]} />
            )}
          </Pressable>

          <View
            accessible={false}
            pointerEvents="none"
            style={styles.importButtonSpacer}
          />
        </View>
      </View>

      {cameraError && (
        <View style={styles.errorOverlay} pointerEvents="none">
          <ThemedText style={styles.statusText}>{cameraError}</ThemedText>
        </View>
      )}
      {diagnosticOverlay}
    </View>
  );
}

const edgeConnections = {
  top: ['topLeft', 'topRight'],
  right: ['topRight', 'bottomRight'],
  bottom: ['bottomRight', 'bottomLeft'],
  left: ['bottomLeft', 'topLeft'],
};

const GalleryImportTile = memo(function GalleryImportTile({ item, onSelect }) {
  return (
    <Pressable
      accessibilityLabel={`Import image ${item.fileName || 'from gallery'}`}
      accessibilityRole="button"
      onPress={() => onSelect(item)}
      style={({ pressed }) => [styles.galleryTile, pressed && styles.pressed]}>
      <Image
        contentFit="cover"
        priority="low"
        recyclingKey={item.id || item.uri}
        source={item.uri}
        style={styles.galleryTileImage}
        transition={0}
      />
    </Pressable>
  );
});

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

function getNextFlashMode(currentMode) {
  const currentIndex = FLASH_MODES.findIndex((mode) => mode.value === currentMode);
  return FLASH_MODES[(currentIndex + 1) % FLASH_MODES.length].value;
}

function getFlashModeLabel(mode) {
  return FLASH_MODES.find((item) => item.value === mode)?.label ?? FLASH_MODES[0].label;
}

function getFlashModeIcon(mode) {
  return FLASH_MODES.find((item) => item.value === mode)?.icon ?? FLASH_MODES[0].icon;
}

async function queryGalleryPage(offset, limit) {
  const module = getMediaLibraryModule();
  if (!module?.Query || !module?.AssetField || !module?.MediaType) {
    throw new Error('The media-library gallery API is unavailable in this build.');
  }

  const assets = await new module.Query()
    .eq(module.AssetField.MEDIA_TYPE, module.MediaType.IMAGE)
    .limit(limit)
    .offset(offset)
    .orderBy({
      key: module.AssetField.MODIFICATION_TIME,
      ascending: false,
    })
    .exe();

  return {
    assets: assets ?? [],
    hasNextPage: (assets?.length ?? 0) === limit,
  };
}

function createDiagnosticDetails(operation, error, context = {}) {
  const details = getErrorDetails(error);
  const runtime = {
    operation,
    message: details.message,
    stack: details.stack,
    platform: Platform.OS,
    isDevelopment: typeof __DEV__ === 'boolean' ? __DEV__ : null,
    timestamp: new Date().toISOString(),
    context,
  };

  return {
    ...runtime,
    text: safeStringify(runtime),
  };
}

function safeStringify(value) {
  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (key, nextValue) => {
      if (nextValue && typeof nextValue === 'object') {
        if (seen.has(nextValue)) return '[Circular]';
        seen.add(nextValue);
      }

      return safeSerializeReplacer(key, nextValue);
    }, 2);
  } catch (serializationError) {
    return `Unable to serialize diagnostic details: ${getErrorDetails(serializationError).message}`;
  }
}

function safeSerializeReplacer(key, value) {
  if (key.toLowerCase().includes('uri') && typeof value === 'string') {
    return value;
  }

  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack || null,
    };
  }

  return value;
}

function DiagnosticDetails({ diagnostic }) {
  return (
    <ScrollView
      horizontal
      contentContainerStyle={styles.diagnosticCodeContent}
      style={styles.diagnosticCodeScroll}
      showsHorizontalScrollIndicator
      showsVerticalScrollIndicator>
      <ThemedText type="code" style={styles.diagnosticCode}>
        {diagnostic.text}
      </ThemedText>
    </ScrollView>
  );
}

function VerboseErrorNotice({ diagnostic, onDismiss }) {
  return (
    <View style={styles.diagnosticNotice}>
      <ThemedText type="subtitle" style={styles.diagnosticNoticeTitle}>
        Preview build error
      </ThemedText>
      <ThemedText style={styles.diagnosticNoticeIntro}>
        The operation failed without closing the app. Send this diagnostic output with the preview
        build report.
      </ThemedText>
      <DiagnosticDetails diagnostic={diagnostic} />
      <Pressable
        accessibilityLabel="Dismiss diagnostic error"
        accessibilityRole="button"
        onPress={onDismiss}
        style={({ pressed }) => [styles.diagnosticDismissButton, pressed && styles.pressed]}>
        <ThemedText type="smallBold" style={styles.saveButtonText}>
          Dismiss
        </ThemedText>
      </Pressable>
    </View>
  );
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
    backgroundColor: REVIEW_NEXT_ACCENT,
    opacity: 0.9,
    transform: [{ rotate: `${angle}deg` }],
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  diagnosticScreen: {
    flex: 1,
    backgroundColor: '#111111',
  },
  diagnosticScreenSafeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  diagnosticTitle: {
    color: Colors.light.background,
  },
  diagnosticIntro: {
    color: '#dedede',
  },
  diagnosticRetryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    backgroundColor: '#3c87f7',
    paddingHorizontal: Spacing.three,
  },
  diagnosticNotice: {
    position: 'absolute',
    top: Spacing.three,
    right: Spacing.three,
    bottom: Spacing.three,
    left: Spacing.three,
    zIndex: 20,
    elevation: 20,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    backgroundColor: '#1b1b1b',
    borderWidth: 1,
    borderColor: '#ff6b6b',
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  diagnosticNoticeTitle: {
    color: '#ffb3b3',
    marginBottom: Spacing.one,
  },
  diagnosticNoticeIntro: {
    color: '#dedede',
    marginBottom: Spacing.two,
  },
  diagnosticCodeScroll: {
    flex: 1,
    minHeight: 120,
    borderRadius: Spacing.two,
    backgroundColor: '#050505',
  },
  diagnosticCodeContent: {
    padding: Spacing.two,
  },
  diagnosticCode: {
    color: '#f2f2f2',
    fontSize: 11,
    lineHeight: 16,
  },
  diagnosticDismissButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    backgroundColor: '#3c87f7',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.two,
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
    backgroundColor: REVIEW_BACKGROUND,
  },
  savedImageContainer: {
    flex: 1,
    backgroundColor: PREVIEW_BACKGROUND,
  },
  reviewSafeArea: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
  savedImageSafeArea: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  reviewTitle: {
    color: REVIEW_TEXT,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  reviewHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  reviewReadyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: 999,
    backgroundColor: REVIEW_SOFT_ACCENT,
    borderWidth: 1,
    borderColor: '#D6E3FF',
  },
  reviewReadyText: {
    color: REVIEW_NEXT_ACCENT,
    fontSize: 12,
  },
  reviewInstruction: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  reviewInstructionText: {
    color: REVIEW_MUTED,
    fontSize: 13,
    lineHeight: 18,
  },
  reviewRotateButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    width: '100%',
    minHeight: 46,
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 16,
    backgroundColor: REVIEW_SURFACE,
    borderWidth: 1,
    borderColor: REVIEW_BORDER,
  },
  reviewRotateText: {
    color: REVIEW_NEXT_ACCENT,
  },
  saveButtonText: {
    color: Colors.light.background,
  },
  savedImageTitle: {
    color: PREVIEW_TEXT,
    textAlign: 'center',
    marginBottom: Spacing.two,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '600',
    letterSpacing: 0.35,
  },
  imageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    position: 'relative',
    borderRadius: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    overflow: 'visible',
    shadowOpacity: 0,
    elevation: 0,
  },
  reviewImage: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 0,
  },
  reviewImageViewport: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 0,
    backgroundColor: 'transparent',
  },
  savedImageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    position: 'relative',
    borderRadius: 28,
    padding: Spacing.one,
    backgroundColor: PREVIEW_IMAGE_SURFACE,
    borderWidth: 1,
    borderColor: PREVIEW_BORDER,
    overflow: 'hidden',
    shadowColor: '#8C9AAF',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  savedImage: {
    flex: 1,
    width: '100%',
    borderRadius: 22,
  },
  savedImageLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245, 247, 250, 0.78)',
  },
  savedImageToggleRow: {
    width: '100%',
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
    padding: Spacing.half,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: '#E8EDF3',
    borderWidth: 1,
    borderColor: PREVIEW_BORDER,
    shadowColor: '#A9B5C4',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  savedImageLiquid: {
    position: 'absolute',
    top: Spacing.half,
    bottom: Spacing.half,
    left: Spacing.half,
    borderRadius: 14,
    backgroundColor: PREVIEW_SURFACE,
    shadowColor: '#A9B5C4',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
    zIndex: 0,
  },
  savedImageToggleButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: 'transparent',
    paddingHorizontal: Spacing.two,
    zIndex: 1,
  },
  savedImageToggleText: {
    color: PREVIEW_MUTED,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    textAlign: 'center',
  },
  savedImageToggleTextActive: {
    color: PREVIEW_TEXT,
    fontWeight: '600',
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
  savedImageActions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 0,
    marginTop: Spacing.two,
    marginHorizontal: -Spacing.four,
    marginBottom: -Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    paddingHorizontal: 0,
    backgroundColor: PREVIEW_BACKGROUND,
  },
  previewActions: {
    marginTop: Spacing.three,
    backgroundColor: PREVIEW_BACKGROUND,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PREVIEW_BORDER,
  },
  savedImageActionButton: {
    flex: 1,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
  reviewActionButton: {
    flexDirection: 'row',
  },
  reviewActions: {
    backgroundColor: REVIEW_BACKGROUND,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: REVIEW_BORDER,
  },
  reviewDiscardAction: {
    marginRight: Spacing.one,
    borderRadius: 16,
    backgroundColor: '#FFF5F6',
    borderWidth: 1,
    borderColor: '#F6D3D8',
  },
  reviewNextAction: {
    marginLeft: Spacing.one,
    borderRadius: 16,
    backgroundColor: REVIEW_NEXT_ACCENT,
    shadowColor: REVIEW_NEXT_ACCENT,
    shadowOpacity: 0.24,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  previewActionButton: {
    flexDirection: 'row',
    minHeight: 46,
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  previewRetakeButton: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: PREVIEW_BORDER,
  },
  previewSaveButton: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: PREVIEW_BORDER,
  },
  previewRetakeText: {
    color: PREVIEW_RETAKE_ACCENT,
  },
  previewSaveText: {
    color: PREVIEW_SAVE_ACCENT,
  },
  reviewDiscardText: {
    color: REVIEW_DISCARD_ACCENT,
  },
  reviewNextText: {
    color: REVIEW_NEXT_ACCENT,
  },
  reviewNextTextOnAccent: {
    color: REVIEW_BACKGROUND,
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
  flashModeButton: {
    position: 'absolute',
    right: Spacing.three,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    zIndex: 2,
  },
  cameraCloseButton: {
    position: 'absolute',
    left: Spacing.three,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    zIndex: 2,
  },
  captureControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: Spacing.three,
  },
  importButton: {
    width: 112,
    height: 93,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importImageFrame: {
    width: 72,
    height: 72,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 2,
    borderColor: '#16C7B7',
    shadowColor: '#16C7B7',
    shadowOpacity: 0.34,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  importImagePreview: {
    width: '100%',
    height: '100%',
  },
  importButtonSpacer: {
    width: 112,
    height: 93,
  },
  importContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  importSafeArea: {
    flex: 1,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.three,
  },
  importHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  importBackButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#2b2b2b',
  },
  importTitle: {
    color: Colors.light.background,
  },
  importHeaderSpacer: {
    width: 44,
  },
  galleryGrid: {
    paddingBottom: Spacing.three,
  },
  galleryRow: {
    gap: Spacing.one,
    marginBottom: Spacing.one,
  },
  galleryTile: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: '33.333%',
    backgroundColor: '#1b1b1b',
    overflow: 'hidden',
    borderRadius: Spacing.one,
  },
  galleryTileImage: {
    width: '100%',
    height: '100%',
  },
  galleryLoadingFooter: {
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importEmptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  importEmptyText: {
    color: '#dedede',
    textAlign: 'center',
  },
  importRetryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
    backgroundColor: '#3c87f7',
    paddingHorizontal: Spacing.three,
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
    width: 82,
    height: 82,
    borderRadius: 41,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#16C7B7',
    shadowOpacity: 0.38,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  captureButtonInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.12)',
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
