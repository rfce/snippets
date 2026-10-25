import { useFocusEffect, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
  const [cropCorners, setCropCorners] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [diagnosticError, setDiagnosticError] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [galleryAssets, setGalleryAssets] = useState([]);
  const [hasMoreGallery, setHasMoreGallery] = useState(true);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);

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

  const capturePhoto = async () => {
    if (!cameraRef.current || !isCameraReady || isCapturing) return;

    setIsCapturing(true);

    try {
       const photo = await cameraRef.current.takePictureAsync({ format: 'jpg', quality: 0.92 });

      if (!photo?.uri) {
        throw new Error('Camera capture completed without returning a photo URI.');
      }

      setCapturedPhoto(photo);
      setCropCorners(null);
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
    setIsCameraReady(false);
    setCameraError(null);
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

    console.log('[screen] Next requested', {
      hasCapturedPhoto: Boolean(capturedPhoto.uri),
      sourceWidth: capturedPhoto.width ?? null,
      sourceHeight: capturedPhoto.height ?? null,
      customCrop,
      corners: cropCorners ?? 'default',
    });

    try {
      if (customCrop && Platform.OS === 'web') {
        console.warn('[screen] Perspective crop skipped on web.');
        Alert.alert('Not available', 'Perspective cropping is available on a mobile device.');
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

      console.log('[screen] Image ready for enhancement', {
        uriAvailable: Boolean(selectedPhoto?.uri),
        width: selectedPhoto?.width ?? null,
        height: selectedPhoto?.height ?? null,
        customCrop,
      });

      setSavedPhoto(selectedPhoto);
      setSavedImageMode('original');
      setBlackAndWhitePhoto(null);
      setMagicColorPhoto(null);
      setCapturedPhoto(null);
      setCropCorners(null);
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
                accessibilityLabel="Next"
                accessibilityRole="button"
                disabled={isCapturing}
                onPress={continueToSavedImage}
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
                    Next
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
          <View
            accessible={false}
            pointerEvents="none"
            style={styles.importButtonSpacer}
          />

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

          <Pressable
            accessibilityLabel="Import images"
            accessibilityRole="button"
            disabled={isCapturing}
            onPress={openImportImage}
            style={({ pressed }) => [
              styles.importButton,
              pressed && styles.pressed,
              isCapturing && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'photo.badge.arrow.down', android: 'photo_library', web: 'photo_library' }}
              size={34}
              tintColor={Colors.light.background}
            />
            <ThemedText
              type="smallBold"
              numberOfLines={2}
              allowFontScaling={false}
              style={styles.importButtonText}>
              {'Import\nImages'}
            </ThemedText>
          </Pressable>
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
    width: 116,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  importButtonText: {
    color: Colors.light.background,
    fontSize: 16,
    lineHeight: 21,
    textAlign: 'center',
  },
  importButtonSpacer: {
    width: 116,
    height: 96,
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
