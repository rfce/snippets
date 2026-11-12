import { useFocusEffect, usePreventRemove, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Platform,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CaptureReview } from '@/components/capture-review';
import { FocusableCamera } from '@/components/focusable-camera';
import { InvertAdjustments, PreviewFilters } from '@/components/preview-filters';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getDefaultCorners, hasCustomCrop } from '@/crop-geometry';
import {
  DEFAULT_INVERT_SETTINGS,
  PREVIEW_FILTER_OPTIONS,
  getInvertSettingsKey,
  normalizeInvertSettings,
} from '@/invert-settings';
import {
  cleanupProcessedImagesAsync,
  renderMagicColorAsync,
  renderAdaptiveThresholdAsync,
  renderInvertAsync,
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

const CAPTURE_MODES = [
  { value: 'single', label: 'Single' },
  { value: 'batch', label: 'Batch' },
];

const GALLERY_PAGE_SIZE = 36;
const TEAL_ACCENT = '#16C7B7';
const REVIEW_DISCARD_ACCENT = '#C2415A';
const REVIEW_NEXT_ACCENT = '#3C78D8';
const PREVIEW_RETAKE_ACCENT = '#C2415A';
const PREVIEW_SAVE_ACCENT = '#2F9E72';
const PREVIEW_BACKGROUND = '#F5F7FA';
const PREVIEW_SURFACE = '#FFFFFF';
const PREVIEW_BORDER = '#DCE4ED';
const PREVIEW_TEXT = '#122033';
const PREVIEW_MUTED = '#667085';
const REVIEW_BACKGROUND = '#FFFFFF';
const REVIEW_SURFACE = '#F7F9FC';
const REVIEW_BORDER = '#E4EAF2';
const REVIEW_TEXT = '#0F172A';
const REVIEW_MUTED = '#64748B';
const REVIEW_SOFT_ACCENT = '#EEF4FF';

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

function BatchReviewScreen({ photos, onBack, onDiscard, onSave, isSaving }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedMode, setSelectedMode] = useState('original');
  const [invertSettings, setInvertSettings] = useState(DEFAULT_INVERT_SETTINGS);
  const [processedPhotosByMode, setProcessedPhotosByMode] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const temporaryPhotosRef = useRef(new Map());
  const savingPromiseRef = useRef(null);
  const processingQueueRef = useRef(Promise.resolve());
  const renderKey = selectedMode === 'invert'
    ? `invert:${getInvertSettingsKey(invertSettings)}`
    : selectedMode;
  const batchImageOptions = PREVIEW_FILTER_OPTIONS;
  const activePhotos = selectedMode === 'original'
    ? photos
    : processedPhotosByMode[renderKey] ?? photos;
  const currentPhoto = activePhotos[currentIndex] ?? activePhotos[0];
  const selectedPhotos = selectedMode === 'original'
    ? photos
    : processedPhotosByMode[renderKey] ?? null;

  const changeInvertSettings = useCallback((settings) => {
    const normalized = normalizeInvertSettings(settings);
    setInvertSettings((current) =>
      getInvertSettingsKey(current) === getInvertSettingsKey(normalized) ? current : normalized
    );
  }, []);

  const trackTemporaryPhoto = useCallback((photo) => {
    if (photo?.temporary && photo.uri) {
      temporaryPhotosRef.current.set(photo.uri, photo);
    }
  }, []);

  useEffect(() => {
    return () => {
      const temporaryPhotos = [...temporaryPhotosRef.current.values()];
      temporaryPhotosRef.current.clear();
      const cleanup = () => cleanupProcessedImagesAsync(temporaryPhotos);
      // A save owns these files until every native save operation has settled.
      if (savingPromiseRef.current) {
        void savingPromiseRef.current.then(cleanup, cleanup);
      } else {
        void cleanup();
      }
    };
  }, []);

  useEffect(() => {
    if (selectedMode === 'original') {
      setIsProcessing(false);
      setProcessingProgress(0);
      return undefined;
    }

    if (processedPhotosByMode[renderKey]) {
      setIsProcessing(false);
      setProcessingProgress(photos.length);
      return undefined;
    }

    let cancelled = false;
    const renderers = {
      blackAndWhite: renderAdaptiveThresholdAsync,
      magicColor: renderMagicColorAsync,
      invert: renderInvertAsync,
    };
    const renderPhoto = renderers[selectedMode];
    const enhancementLabel = PREVIEW_FILTER_OPTIONS.find((option) => option.value === selectedMode)?.label
      ?? 'Image enhancement';

    setIsProcessing(true);
    setProcessingProgress(0);

    const processBatch = async () => {
      if (cancelled) return;
      const processedPhotos = [];
      let cached = false;

      try {
        for (let index = 0; index < photos.length; index += 1) {
          if (cancelled) return;

          const photo = photos[index];
          const enhancedPhoto = await renderPhoto({
            uri: photo.uri,
            sourceWidth: photo.width,
            sourceHeight: photo.height,
            ...(selectedMode === 'invert' ? { settings: invertSettings } : {}),
          });
          if (cancelled) {
            await cleanupProcessedImagesAsync([enhancedPhoto]);
            return;
          }
          trackTemporaryPhoto(enhancedPhoto);
          processedPhotos.push({ ...photo, ...enhancedPhoto });
          setProcessingProgress(index + 1);
        }

        if (!cancelled) {
          cached = true;
          setProcessedPhotosByMode((current) => ({
            ...current,
            [renderKey]: processedPhotos,
          }));
          setIsProcessing(false);
        }
      } catch (error) {
        if (!cancelled) {
          setIsProcessing(false);
          Alert.alert(
            `${enhancementLabel} failed`,
            getErrorDetails(error).message
          );
        }
      } finally {
        if (!cached) {
          const unusedPhotos = processedPhotos.filter((photo) => temporaryPhotosRef.current.has(photo.uri));
          unusedPhotos.forEach((photo) => temporaryPhotosRef.current.delete(photo.uri));
          await cleanupProcessedImagesAsync(unusedPhotos);
        }
      }
    };

    // Finish at most one in-flight image before applying the latest settings.
    // Cancelled queued requests exit before allocating another GL context.
    processingQueueRef.current = processingQueueRef.current.catch(() => {}).then(processBatch);

    return () => {
      cancelled = true;
    };
  }, [photos, processedPhotosByMode, renderKey, selectedMode, invertSettings, trackTemporaryPhoto]);

  const saveSelectedPhotos = () => {
    if (savingPromiseRef.current || isSaving || isProcessing || !selectedPhotos) return;

    const save = Promise.resolve().then(() => onSave(selectedPhotos));
    savingPromiseRef.current = save;
    const finish = () => {
      if (savingPromiseRef.current === save) savingPromiseRef.current = null;
    };
    void save.then(finish, finish);
  };

  const moveToAdjacentPhoto = (direction) => {
    setCurrentIndex((index) => Math.max(0, Math.min(photos.length - 1, index + direction)));
  };

  const swipeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.15 && Math.abs(gestureState.dx) > 12,
      onPanResponderRelease: (_, gestureState) => {
        if (Math.abs(gestureState.dx) >= 48) {
          moveToAdjacentPhoto(gestureState.dx < 0 ? 1 : -1);
        }
      },
    })
  ).current;

  return (
    <View style={styles.batchReviewContainer}>
      <SafeAreaView style={styles.batchReviewSafeArea}>
        <View style={styles.batchReviewHeader}>
          <Pressable
            accessibilityLabel="Return to batch camera"
            accessibilityRole="button"
            disabled={isSaving}
            onPress={onBack}
            style={({ pressed }) => [
              styles.batchReviewBackButton,
              pressed && styles.pressed,
              isSaving && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
              size={22}
              tintColor={REVIEW_TEXT}
            />
          </Pressable>
          <View style={styles.batchReviewHeading}>
            <ThemedText type="title" style={styles.batchReviewTitle}>
              Review
            </ThemedText>
            <ThemedText style={styles.batchReviewSubtitle}>
              {photos.length} {photos.length === 1 ? 'image' : 'images'} captured
            </ThemedText>
          </View>
          <View style={styles.batchReviewHeaderSpacer} />
        </View>

        <View style={styles.batchReviewImageFrame} {...swipeResponder.panHandlers}>
          <Pressable
            accessibilityLabel="Previous batch image"
            accessibilityRole="button"
            disabled={currentIndex === 0}
            onPress={() => moveToAdjacentPhoto(-1)}
            style={({ pressed }) => [
              styles.batchReviewArrow,
              styles.batchReviewPreviousArrow,
              pressed && styles.pressed,
              currentIndex === 0 && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }}
              size={24}
              tintColor={REVIEW_BACKGROUND}
            />
          </Pressable>

          {currentPhoto ? (
            <Image
              key={currentPhoto.uri}
              contentFit="contain"
              recyclingKey={currentPhoto.uri}
              source={currentPhoto.uri}
              style={styles.batchReviewImage}
              transition={0}
            />
          ) : null}
          {isProcessing ? (
            <View style={styles.batchReviewProcessingOverlay} pointerEvents="none">
              <ActivityIndicator color={REVIEW_BACKGROUND} />
              <ThemedText style={styles.batchReviewProcessingText}>
                {processingProgress} / {photos.length}
              </ThemedText>
            </View>
          ) : null}

          <Pressable
            accessibilityLabel="Next batch image"
            accessibilityRole="button"
            disabled={currentIndex >= photos.length - 1}
            onPress={() => moveToAdjacentPhoto(1)}
            style={({ pressed }) => [
              styles.batchReviewArrow,
              styles.batchReviewNextArrow,
              pressed && styles.pressed,
              currentIndex >= photos.length - 1 && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
              size={24}
              tintColor={REVIEW_BACKGROUND}
            />
          </Pressable>
        </View>

        <View accessibilityRole="none" style={styles.batchReviewPagination}>
          {photos.map((photo, index) => (
            <View
              key={photo.uri || String(index)}
              style={[
                styles.batchReviewDot,
                index === currentIndex && styles.batchReviewDotActive,
              ]}
            />
          ))}
        </View>

        <View style={styles.batchReviewToggleRow}>
          {batchImageOptions.map((option) => {
            const isActive = selectedMode === option.value;

            return (
              <Pressable
                key={option.value}
                accessibilityLabel={`Show ${option.label.toLowerCase()} image`}
                accessibilityRole="button"
                disabled={isSaving}
                onPress={() => setSelectedMode(option.value)}
                style={({ pressed }) => [
                  styles.batchReviewToggle,
                  isSaving && styles.disabled,
                  isActive && styles.batchReviewToggleActive,
                  pressed && styles.pressed,
                ]}>
                <ThemedText
                  type="smallBold"
                  allowFontScaling={false}
                  style={[
                    styles.batchReviewToggleText,
                    isActive && styles.batchReviewToggleTextActive,
                  ]}>
                  {option.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>

        <InvertAdjustments
          visible={selectedMode === 'invert'}
          invertSettings={invertSettings}
          onInvertSettingsChange={changeInvertSettings}
          disabled={isSaving}
        />

        <View style={styles.batchReviewActions}>
          <Pressable
            accessibilityLabel="Discard batch"
            accessibilityRole="button"
            disabled={isSaving}
            onPress={onDiscard}
            style={({ pressed }) => [
              styles.batchReviewAction,
              styles.batchReviewDiscardAction,
              pressed && styles.pressed,
              isSaving && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
              size={25}
              tintColor={REVIEW_DISCARD_ACCENT}
            />
            <ThemedText type="smallBold" style={styles.batchReviewDiscardText}>
              Discard
            </ThemedText>
          </Pressable>

          <Pressable
            accessibilityLabel="Save batch"
            accessibilityRole="button"
            disabled={isSaving || isProcessing || !selectedPhotos}
            onPress={saveSelectedPhotos}
            style={({ pressed }) => [
              styles.batchReviewAction,
              styles.batchReviewSaveAction,
              pressed && styles.pressed,
              (isSaving || isProcessing || !selectedPhotos) && styles.disabled,
            ]}>
            {isSaving ? (
              <ActivityIndicator color={REVIEW_BACKGROUND} />
            ) : (
              <SymbolView
                name={{ ios: 'arrow.down.circle.fill', android: 'download', web: 'download' }}
                size={25}
                tintColor={REVIEW_BACKGROUND}
              />
            )}
            <ThemedText type="smallBold" style={styles.batchReviewSaveText}>
              Save
            </ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function CameraScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cameraRef = useRef(null);
  const focusControllerRef = useRef(null);
  const captureInFlightRef = useRef(false);
  const cameraRequestStarted = useRef(false);
  const galleryLoadingRef = useRef(false);
  const galleryOffsetRef = useRef(0);
  const galleryHasMoreRef = useRef(true);
  const galleryRequestRef = useRef(0);
  const batchSaveInFlightRef = useRef(false);
  const recentImageLoadStartedRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = cameraModule.useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = mediaLibraryModule.usePermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const [isFocused, setIsFocused] = useState(true);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureMode, setCaptureMode] = useState('single');
  const [batchPhotos, setBatchPhotos] = useState([]);
  const [batchReviewPhotos, setBatchReviewPhotos] = useState(null);
  const [flashMode, setFlashMode] = useState('off');
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [savedImageMode, setSavedImageMode] = useState('original');
  const [blackAndWhitePhoto, setBlackAndWhitePhoto] = useState(null);
  const [magicColorPhoto, setMagicColorPhoto] = useState(null);
  const [invertPhoto, setInvertPhoto] = useState(null);
  const [invertSettings, setInvertSettings] = useState(DEFAULT_INVERT_SETTINGS);
  const [comparisonMode, setComparisonMode] = useState(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const reviewEditsRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);
  const [diagnosticError, setDiagnosticError] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [galleryAssets, setGalleryAssets] = useState([]);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  const [recentGalleryImage, setRecentGalleryImage] = useState(null);
  const temporaryPreviewPhotosRef = useRef(new Map());
  const invertPhotoCacheRef = useRef(new Map());
  const previewRequestRef = useRef(0);
  const previewBusyRef = useRef(false);
  const previewMountedRef = useRef(true);

  // Cover stack actions and native back gestures while saved files are in use.
  usePreventRemove(isSavingBatch);

  const handleCameraReadiness = useCallback((ready) => {
    setIsCameraReady(ready);
    if (ready) setCameraError(null);
  }, []);

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

  const cleanupTemporaryPreviewPhotos = useCallback(() => {
    const photos = [...temporaryPreviewPhotosRef.current.values()];
    temporaryPreviewPhotosRef.current.clear();
    void cleanupProcessedImagesAsync(photos);
  }, []);

  const trackTemporaryPreviewPhoto = useCallback((photo) => {
    if (photo?.temporary && photo.uri) {
      temporaryPreviewPhotosRef.current.set(photo.uri, photo);
    }
  }, []);

  useEffect(() => {
    previewMountedRef.current = true;
    return () => {
      previewMountedRef.current = false;
      previewRequestRef.current += 1;
      previewBusyRef.current = false;
      invertPhotoCacheRef.current.clear();
      cleanupTemporaryPreviewPhotos();
    };
  }, [cleanupTemporaryPreviewPhotos]);

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

  const invalidateGalleryLoad = useCallback(() => {
    galleryRequestRef.current += 1;
    galleryLoadingRef.current = false;
    setIsLoadingGallery(false);
  }, []);

  const loadGalleryPage = useCallback(async (reset = false) => {
    if (!reset && (galleryLoadingRef.current || !galleryHasMoreRef.current)) return;

    const request = ++galleryRequestRef.current;
    const isCurrent = () => previewMountedRef.current && galleryRequestRef.current === request;
    const offset = reset ? 0 : galleryOffsetRef.current;
    if (reset) {
      galleryOffsetRef.current = 0;
      galleryHasMoreRef.current = true;
    }
    galleryLoadingRef.current = true;
    setIsLoadingGallery(true);

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }
      if (!isCurrent()) return;

      if (!permission?.granted) {
        throw new Error('Photo-library permission was not granted.');
      }

      const page = await queryGalleryPage(offset, GALLERY_PAGE_SIZE);
      if (!isCurrent()) return;
      const normalizedAssets = await Promise.all(page.assets.map(normalizeMediaLibraryImage));
      if (!isCurrent()) return;
      const usableAssets = normalizedAssets.filter((asset) => asset?.uri);

      // Native offsets count all fetched records, including unusable duplicates.
      galleryOffsetRef.current = offset + page.assets.length;
      galleryHasMoreRef.current = page.hasNextPage ?? page.assets.length === GALLERY_PAGE_SIZE;
      setGalleryAssets((current) =>
        reset
          ? appendUniqueMediaLibraryImages([], usableAssets)
          : appendUniqueMediaLibraryImages(current, usableAssets)
      );
    } catch (error) {
      if (isCurrent()) {
        reportDiagnostic('Load gallery images', error, {
          reset,
          requestedOffset: offset,
          pageSize: GALLERY_PAGE_SIZE,
        });
      }
    } finally {
      if (isCurrent()) {
        galleryLoadingRef.current = false;
        setIsLoadingGallery(false);
      }
    }
  }, [mediaPermission, requestMediaPermission, reportDiagnostic]);

  const openImportImage = async () => {
    setIsImporting(true);
    setGalleryAssets([]);
    await loadGalleryPage(true);
  };

  const closeImportImage = () => {
    invalidateGalleryLoad();
    setIsImporting(false);
    setIsCameraReady(false);
  };

  const selectGalleryImage = useCallback((asset) => {
    invalidateGalleryLoad();
    setCapturedPhoto({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      fileName: asset.fileName ?? null,
    });
    reviewEditsRef.current = null;
    setIsImporting(false);
    setIsCameraReady(false);
  }, [invalidateGalleryLoad]);

  const selectCaptureMode = useCallback((mode) => {
    if (mode === captureMode || captureInFlightRef.current || batchSaveInFlightRef.current) return;

    // Retain captures so switching back to Batch resumes the existing batch.
    setCaptureMode(mode);
  }, [captureMode]);

  const renderGalleryItem = useCallback(
    ({ item }) => <GalleryImportTile item={item} onSelect={selectGalleryImage} />,
    [selectGalleryImage]
  );

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);

      return () => {
        setIsFocused(false);
        setIsCameraReady(false);
      };
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
    if (!cameraRef.current || !isCameraReady || isCapturing || captureInFlightRef.current) return;

    captureInFlightRef.current = true;
    setIsCapturing(true);

    try {
      const focusResult = await focusControllerRef.current?.prepareCaptureAsync();
      if (focusResult?.status === 'cancelled' || !cameraRef.current) return;

      const photo = await cameraRef.current.takePictureAsync({
        format: 'jpg',
        quality: 0.92,
        shutterSound: false,
      });

      if (!photo?.uri) {
        throw new Error('Camera capture completed without returning a photo URI.');
      }

      if (captureMode === 'batch') {
        setBatchPhotos((current) => [...current, photo]);
      } else {
        setCapturedPhoto(photo);
        reviewEditsRef.current = null;
      }
    } catch (error) {
      reportDiagnostic('Capture photo', error, {
        captureMode,
        flashMode,
        cameraReady: isCameraReady,
      });
    } finally {
      captureInFlightRef.current = false;
      focusControllerRef.current?.finishCapture?.();
      setIsCapturing(false);
    }
  };

  const finishBatchCapture = () => {
    if (captureMode !== 'batch' || !batchPhotos.length || isCapturing) return;

    setBatchReviewPhotos(batchPhotos);
    setIsCameraReady(false);
  };

  const returnToBatchCamera = useCallback(() => {
    if (batchSaveInFlightRef.current) return;
    setBatchReviewPhotos(null);
    setIsCameraReady(false);
  }, []);

  useFocusEffect(useCallback(() => {
    if (!batchReviewPhotos) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      returnToBatchCamera();
      return true;
    });
    return () => subscription.remove();
  }, [batchReviewPhotos, returnToBatchCamera]));

  const discardBatch = () => {
    if (batchSaveInFlightRef.current) return;
    setBatchPhotos([]);
    setBatchReviewPhotos(null);
    setCaptureMode('single');
    setIsCameraReady(false);
  };

  const saveBatch = async (photosToSave = batchPhotos) => {
    if (!photosToSave.length || batchSaveInFlightRef.current) return;

    batchSaveInFlightRef.current = true;
    setIsSavingBatch(true);

    try {
      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission?.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save this batch.');
        return;
      }

      for (const photo of photosToSave) {
        await saveToSnippetsAlbum(mediaLibraryModule, photo.uri);
      }

      setBatchPhotos([]);
      setBatchReviewPhotos(null);
      setCaptureMode('single');
      setIsCameraReady(false);
    } catch (error) {
      const details = getErrorDetails(error);
      console.error('[screen] Batch save failed', details);
      Alert.alert('Could not save batch', details.message);
    } finally {
      batchSaveInFlightRef.current = false;
      setIsSavingBatch(false);
    }
  };

  const discardPhoto = () => {
    setCapturedPhoto(null);
    reviewEditsRef.current = null;
    setIsCameraReady(false);
    setCameraError(null);
  };

  const returnToReview = useCallback(() => {
    previewRequestRef.current += 1;
    previewBusyRef.current = false;
    cleanupTemporaryPreviewPhotos();
    invertPhotoCacheRef.current.clear();
    setSavedPhoto(null);
    setSavedImageMode('original');
    setBlackAndWhitePhoto(null);
    setMagicColorPhoto(null);
    setInvertPhoto(null);
    setComparisonMode(null);
    setIsEnhancing(false);
    setIsCameraReady(false);
    setCameraError(null);
  }, [cleanupTemporaryPreviewPhotos]);

  const closeSavedPhoto = useCallback(() => {
    returnToReview();
    setCapturedPhoto(null);
    reviewEditsRef.current = null;
    setInvertSettings(DEFAULT_INVERT_SETTINGS);
  }, [returnToReview]);

  // Preview is an editing step inside this route. Android Back returns to the
  // retained capture, and waits for an active render/save to finish.
  useFocusEffect(useCallback(() => {
    if (!savedPhoto) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!isEnhancing && !isSavingPreview) returnToReview();
      return true;
    });
    return () => subscription.remove();
  }, [savedPhoto, isEnhancing, isSavingPreview, returnToReview]));

  const displayedSavedPhoto =
    savedImageMode === 'blackAndWhite' && blackAndWhitePhoto
      ? blackAndWhitePhoto
      : savedImageMode === 'magicColor' && magicColorPhoto
        ? magicColorPhoto
        : savedImageMode === 'invert' && invertPhoto
          ? invertPhoto
          : savedPhoto;
  const comparisonPhoto = comparisonMode ? savedPhoto : displayedSavedPhoto;

  const selectSavedImageMode = async (mode, nextSettings = invertSettings) => {
    if (previewBusyRef.current || isSavingPreview || !savedPhoto) return;
    const renderers = {
      blackAndWhite: renderAdaptiveThresholdAsync,
      magicColor: renderMagicColorAsync,
      invert: renderInvertAsync,
    };
    if (mode !== 'original' && !renderers[mode]) return;
    const settings = normalizeInvertSettings(nextSettings);
    const settingsKey = getInvertSettingsKey(settings);
    setComparisonMode(null);
    setSavedImageMode(mode);
    if (mode === 'invert') setInvertSettings(settings);

    const cached = mode === 'blackAndWhite' ? blackAndWhitePhoto
      : mode === 'magicColor' ? magicColorPhoto
        : mode === 'invert' ? invertPhotoCacheRef.current.get(settingsKey) : null;
    if (cached) {
      if (mode === 'invert') setInvertPhoto(cached);
      return;
    }
    if (mode === 'original') return;

    const request = ++previewRequestRef.current;
    const isCurrent = () => previewMountedRef.current && previewRequestRef.current === request;
    const produced = [];
    previewBusyRef.current = true;
    setIsEnhancing(true);

    try {
      // Analyze the full capture and render the selected crop in one pass.
      const sourcePhoto = capturedPhoto ?? savedPhoto;
      const edits = capturedPhoto ? reviewEditsRef.current : null;
      const enhancedPhoto = await renderers[mode]({
        uri: sourcePhoto.uri,
        sourceWidth: sourcePhoto.width,
        sourceHeight: sourcePhoto.height,
        ...(edits ? { corners: edits.corners, rotation: edits.rotation } : {}),
        ...(mode === 'invert' ? { settings } : {}),
      });
      produced.push(enhancedPhoto);
      if (!isCurrent()) {
        await cleanupProcessedImagesAsync(produced);
        return;
      }
      trackTemporaryPreviewPhoto(enhancedPhoto);
      if (mode === 'blackAndWhite') setBlackAndWhitePhoto(enhancedPhoto);
      else if (mode === 'magicColor') setMagicColorPhoto(enhancedPhoto);
      else {
        invertPhotoCacheRef.current.set(settingsKey, enhancedPhoto);
        setInvertPhoto(enhancedPhoto);
      }
    } catch (error) {
      await cleanupProcessedImagesAsync(produced);
      if (isCurrent()) {
        setSavedImageMode('original');
        reportDiagnostic(mode + ' enhancement', error, { mode, settings: mode === 'invert' ? settings : undefined });
      }
    } finally {
      if (isCurrent()) {
        previewBusyRef.current = false;
        setIsEnhancing(false);
      }
    }
  };

  const changeInvertSettings = (settings) => {
    return selectSavedImageMode('invert', normalizeInvertSettings(settings));
  };

  const saveSavedImage = async () => {
    if (!displayedSavedPhoto?.uri || isSavingPreview || isEnhancing || previewBusyRef.current) return;

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

      const savedAsset = await saveToSnippetsAlbum(mediaLibraryModule, displayedSavedPhoto.uri);
      const savedImage = await normalizeMediaLibraryImage(savedAsset);

      if (savedImage?.uri) {
        setRecentGalleryImage(savedImage);
      } else if (!displayedSavedPhoto.temporary) {
        setRecentGalleryImage({
          uri: displayedSavedPhoto.uri,
          width: displayedSavedPhoto.width,
          height: displayedSavedPhoto.height,
          fileName: displayedSavedPhoto.fileName ?? null,
        });
      }
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

  const continueToSavedImage = async ({ corners, rotation }) => {
    if (!capturedPhoto?.uri || isCapturing) return;

    const cropCorners = corners;
    const capturedRotation = rotation;
    reviewEditsRef.current = { corners, rotation };
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

      trackTemporaryPreviewPhoto(selectedPhoto);

      console.log('[screen] Image ready for enhancement', {
        uriAvailable: Boolean(selectedPhoto?.uri),
        width: selectedPhoto?.width ?? null,
        height: selectedPhoto?.height ?? null,
        customCrop,
        rotation: capturedRotation,
      });

      previewRequestRef.current += 1;
      invertPhotoCacheRef.current.clear();
      setSavedPhoto(selectedPhoto);
      setSavedImageMode('original');
      setBlackAndWhitePhoto(null);
      setMagicColorPhoto(null);
      setInvertPhoto(null);
      setComparisonMode(null);
      // Keep the source capture and edit snapshot for Back to review. Each
      // preview is rendered from that source rather than from a previous crop.
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
              <ThemedText type="default" style={styles.importTitle}>
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

  if (batchReviewPhotos) {
    return (
      <BatchReviewScreen
        photos={batchReviewPhotos}
        isSaving={isSavingBatch}
        onBack={returnToBatchCamera}
        onDiscard={discardBatch}
        onSave={saveBatch}
      />
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
            <View style={styles.savedImageHeader}>
              <Pressable
                accessibilityLabel="Back to review capture"
                accessibilityRole="button"
                disabled={isEnhancing || isSavingPreview}
                onPress={returnToReview}
                style={({ pressed }) => [
                  styles.savedImageBackButton,
                  pressed && styles.pressed,
                  (isEnhancing || isSavingPreview) && styles.disabled,
                ]}>
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                  size={24}
                  tintColor={PREVIEW_TEXT}
                />
              </Pressable>
              <ThemedText type="default" style={styles.savedImageTitle}>
                Preview
              </ThemedText>
              <Pressable
                accessibilityLabel={comparisonMode ? 'Show filtered image' : 'Compare with original'}
                accessibilityRole="button"
                accessibilityState={{ selected: Boolean(comparisonMode) }}
                disabled={savedImageMode === 'original' || isEnhancing || isSavingPreview}
                onPress={() => setComparisonMode((current) => current === 'toggle' ? null : 'toggle')}
                style={({ pressed }) => [
                  styles.savedImageBackButton, pressed && styles.pressed,
                  (savedImageMode === 'original' || isEnhancing || isSavingPreview) && styles.disabled,
                ]}>
                <SymbolView
                  name={{ ios: 'square.on.square', android: 'compare', web: 'compare' }}
                  size={23}
                  tintColor={PREVIEW_TEXT}
                />
              </Pressable>
            </View>

            <Pressable
              accessibilityLabel="Preview image"
              accessibilityHint="Hold to compare with the original crop. Release to return to the filter."
              disabled={savedImageMode === 'original' || isEnhancing || isSavingPreview}
              delayLongPress={180}
              onLongPress={() => setComparisonMode('hold')}
              onPressOut={() => setComparisonMode((current) => current === 'hold' ? null : current)}
              style={styles.savedImageFrame}>
              <Image
                contentFit="contain"
                source={{ uri: comparisonPhoto?.uri ?? savedPhoto.uri }}
                recyclingKey={comparisonPhoto?.uri ?? savedPhoto.uri}
                transition={0}
                style={styles.savedImage}
              />
              {comparisonMode ? (
                <View pointerEvents="none" style={styles.comparisonBadge}>
                  <ThemedText type="smallBold" style={styles.comparisonBadgeText}>Original</ThemedText>
                </View>
              ) : null}
              {isEnhancing && (
                <View style={styles.savedImageLoadingOverlay}>
                  <ActivityIndicator color={TEAL_ACCENT} />
                </View>
              )}
            </Pressable>
            <ThemedText style={styles.comparisonHint}>
              {savedImageMode === 'original' ? 'Choose a filter below'
                : comparisonMode === 'hold' ? 'Original · Release to return'
                  : comparisonMode === 'toggle' ? 'Original · Tap Compare to return'
                    : 'Hold image to compare with original'}
            </ThemedText>
            <PreviewFilters
              selectedMode={savedImageMode}
              onModeChange={selectSavedImageMode}
              invertSettings={invertSettings}
              onInvertSettingsChange={changeInvertSettings}
              disabled={isEnhancing || isSavingPreview}
            />

              <View
                style={[
                  styles.savedImageActions,
                  styles.previewActions,
                  { paddingBottom: insets.bottom },
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
                     <ActivityIndicator color={PREVIEW_BACKGROUND} />
                   ) : (
                   <SymbolView
                     name={{ ios: 'arrow.down.circle.fill', android: 'download', web: 'download' }}
                     size={30}
                     tintColor={PREVIEW_BACKGROUND}
                   />
                   )}
                   {!isSavingPreview && (
                     <ThemedText
                       type="smallBold"
                       allowFontScaling={false}
                       style={[styles.previewSaveText, styles.previewSaveTextOnAccent]}>
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
        <CaptureReview
          key={capturedPhoto.uri}
          photo={capturedPhoto}
          initialEdits={reviewEditsRef.current}
          isProcessing={isCapturing}
          onNext={continueToSavedImage}
          onDiscard={discardPhoto}
        />
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
        <FocusableCamera
          ref={focusControllerRef}
          CameraComponent={CameraView}
          cameraRef={cameraRef}
          disabled={isCapturing}
          enableTorch={flashMode === 'torch'}
          flash={flashMode === 'flash' ? 'on' : 'off'}
          onReadyChange={handleCameraReadiness}
          onMountError={(event) => {
            const message = event?.nativeEvent?.message ?? event?.message ?? 'The camera preview could not start.';
            setCameraError(message);
            reportDiagnostic('Camera startup', event?.nativeEvent ?? new Error(message), {
              nativeEvent: event?.nativeEvent ?? null,
            });
          }}
          style={[styles.cameraStage, { top: insets.top + 88, bottom: insets.bottom + 174 }]}
        />
      )}

      {isFocused && (
        <View pointerEvents="none" style={[styles.cameraHeading, { top: insets.top + 18 }]}>
          <ThemedText style={styles.cameraBrand}>SNIPPETS</ThemedText>
          <ThemedText style={styles.cameraHint}>Tap to focus</ThemedText>
        </View>
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
          {captureMode === 'batch' ? (
            <View
              accessible={false}
              pointerEvents="none"
              style={styles.importButtonSpacer}
            >
              {batchPhotos.length > 0 ? (
                <ThemedText type="title" style={styles.batchCaptureCountText}>
                  {batchPhotos.length}
                </ThemedText>
              ) : null}
            </View>
          ) : (
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
          )}

          <View style={styles.captureControlCenter}>
            <View
              accessibilityRole="tablist"
              style={styles.captureModeSwitch}>
              {CAPTURE_MODES.map((mode) => {
                const isActive = captureMode === mode.value;

                return (
                  <Pressable
                    key={mode.value}
                    accessibilityLabel={`Select ${mode.label.toLowerCase()} capture mode`}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: isActive }}
                    disabled={isCapturing}
                    onPress={() => selectCaptureMode(mode.value)}
                    style={({ pressed }) => [
                      styles.captureModeOption,
                      isActive && styles.captureModeOptionActive,
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText
                      type="smallBold"
                      allowFontScaling={false}
                      style={[
                        styles.captureModeOptionText,
                        isActive && styles.captureModeOptionTextActive,
                      ]}>
                      {mode.label}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>

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
          </View>

          {captureMode === 'batch' ? (
            <Pressable
              accessibilityLabel="Finish batch capture"
              accessibilityRole="button"
              disabled={!batchPhotos.length || isCapturing}
              onPress={finishBatchCapture}
              style={({ pressed }) => [
                styles.batchDoneButton,
                pressed && styles.pressed,
                (!batchPhotos.length || isCapturing) && styles.disabled,
              ]}>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={32}
                tintColor={Colors.light.background}
              />
            </Pressable>
          ) : (
            <View
              accessible={false}
              pointerEvents="none"
              style={styles.importButtonSpacer}
            />
          )}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080D14',
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
  cameraStage: {
    position: 'absolute',
    left: 16,
    right: 16,
  },
  cameraHeading: {
    position: 'absolute',
    alignSelf: 'center',
    alignItems: 'center',
    gap: 2,
  },
  cameraBrand: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    letterSpacing: 3,
    color: '#F5F7FA',
  },
  cameraHint: {
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.4,
    color: '#9AA9B8',
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
  batchReviewContainer: {
    flex: 1,
    backgroundColor: REVIEW_BACKGROUND,
  },
  batchReviewSafeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
  batchReviewHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  batchReviewBackButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  batchReviewHeading: {
    flex: 1,
  },
  batchReviewTitle: {
    color: PREVIEW_TEXT,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '600',
    letterSpacing: 0.35,
    textAlign: 'center',
  },
  batchReviewSubtitle: {
    color: PREVIEW_MUTED,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  batchReviewHeaderSpacer: {
    width: 44,
  },
  batchReviewImageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 20,
    backgroundColor: PREVIEW_SURFACE,
  },
  batchReviewArrow: {
    position: 'absolute',
    top: '50%',
    zIndex: 2,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
  },
  batchReviewPreviousArrow: {
    left: Spacing.two,
  },
  batchReviewNextArrow: {
    right: Spacing.two,
  },
  batchReviewProcessingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    backgroundColor: 'rgba(0, 0, 0, 0.38)',
  },
  batchReviewProcessingText: {
    color: REVIEW_BACKGROUND,
  },
  batchReviewPagination: {
    minHeight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  batchReviewDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#B9C2CF',
  },
  batchReviewDotActive: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: REVIEW_NEXT_ACCENT,
  },
  batchReviewToggleRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  batchReviewToggle: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.one,
    borderRadius: 14,
    backgroundColor: REVIEW_SURFACE,
    borderWidth: 1,
    borderColor: REVIEW_BORDER,
  },
  batchReviewToggleActive: {
    backgroundColor: REVIEW_NEXT_ACCENT,
    borderColor: REVIEW_NEXT_ACCENT,
  },
  batchReviewToggleText: {
    color: REVIEW_TEXT,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    flexShrink: 1,
  },
  batchReviewToggleTextActive: {
    color: REVIEW_BACKGROUND,
  },
  batchReviewActions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    marginTop: Spacing.two,
    marginHorizontal: -Spacing.four,
    marginBottom: -Spacing.three,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: PREVIEW_BACKGROUND,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PREVIEW_BORDER,
  },
  batchReviewAction: {
    flex: 1,
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
  },
  batchReviewDiscardAction: {
    backgroundColor: '#FFF5F6',
    borderRadius: 0,
    borderWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#F0C9CF',
  },
  batchReviewSaveAction: {
    backgroundColor: PREVIEW_SAVE_ACCENT,
    borderRadius: 0,
    borderWidth: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  batchReviewDiscardText: {
    color: REVIEW_DISCARD_ACCENT,
  },
  batchReviewSaveText: {
    color: REVIEW_BACKGROUND,
  },
  batchReviewGrid: {
    paddingBottom: Spacing.four,
  },
  batchReviewRow: {
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  batchReviewTile: {
    flex: 1,
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: Spacing.two,
    backgroundColor: REVIEW_SURFACE,
    borderWidth: 1,
    borderColor: REVIEW_BORDER,
  },
  batchReviewImage: {
    width: '100%',
    height: '100%',
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
  savedImageHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  savedImageBackButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedImageHeaderSpacer: {
    width: 48,
  },
  comparisonHint: {
    minHeight: 18, marginTop: 6, textAlign: 'center', fontSize: 12,
    lineHeight: 18, color: PREVIEW_MUTED,
  },
  comparisonBadge: {
    position: 'absolute', top: 12, left: 12, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#282E42',
  },
  comparisonBadgeText: { color: '#F5F5F5', fontSize: 12 },
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
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    overflow: 'hidden',
    shadowOpacity: 0,
    elevation: 0,
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
    marginBottom: Spacing.two,
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
    marginTop: 0,
    marginBottom: -Spacing.three,
    paddingTop: 0,
    paddingBottom: 0,
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
    minHeight: 60,
  },
  reviewActions: {
    marginTop: 0,
    marginBottom: -Spacing.three,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: REVIEW_BACKGROUND,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: REVIEW_BORDER,
  },
  reviewDiscardAction: {
    marginRight: 0,
    borderRadius: 0,
    backgroundColor: '#FFF5F6',
    borderWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#F0C9CF',
  },
  reviewNextAction: {
    marginLeft: 0,
    borderRadius: 0,
    backgroundColor: REVIEW_NEXT_ACCENT,
    shadowOpacity: 0,
    elevation: 0,
  },
  previewActionButton: {
    flexDirection: 'row',
    minHeight: 60,
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  previewRetakeButton: {
    borderRadius: 0,
    backgroundColor: '#FFF5F6',
    borderWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#F0C9CF',
  },
  previewSaveButton: {
    borderRadius: 0,
    backgroundColor: PREVIEW_SAVE_ACCENT,
    borderWidth: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  previewRetakeText: {
    color: PREVIEW_RETAKE_ACCENT,
  },
  previewSaveText: {
    color: PREVIEW_SAVE_ACCENT,
  },
  previewSaveTextOnAccent: {
    color: PREVIEW_BACKGROUND,
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
    backgroundColor: '#17202B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
    backgroundColor: '#17202B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    zIndex: 2,
  },
  captureControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: Spacing.three,
  },
  captureControlCenter: {
    position: 'relative',
    width: 112,
    height: 93,
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchDoneButton: {
    width: 112,
    height: 93,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureModeSwitch: {
    position: 'absolute',
    top: -36,
    zIndex: 3,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 2,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  captureModeOption: {
    minWidth: 58,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderRadius: 14,
  },
  captureModeOptionActive: {
    backgroundColor: TEAL_ACCENT,
  },
  captureModeOptionText: {
    color: '#dedede',
  },
  captureModeOptionTextActive: {
    color: '#062b29',
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
    backgroundColor: 'transparent',
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchCaptureCountText: {
    color: '#dedede',
    fontSize: 28,
    lineHeight: 34,
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

