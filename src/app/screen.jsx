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
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraCaptureOverlay, BatchCaptureTray } from '@/components/batch-capture-feedback';
import { BatchEditor } from '@/components/batch-editor';
import { BatchReviewScreen } from '@/components/batch-review';
import { getBatchEditKey, renderBatchEditAsync } from '@/batch-editing';
import { getFinishRenderKey } from '@/batch-finishes';
import { backgroundSaves } from '@/background-saves';
import { isKnownFinish, renderFinishAsync } from '@/finish-render';
import { appendBatchCaptureFlight, isBatchCaptureRect, snapshotBatchCaptureGeometry } from '@/batch-capture-geometry';
import { CaptureReview } from '@/components/capture-review';
import { getBatchPhotoId, releaseTemporaryImagesAsync } from '@/batch-workflow';
import { FocusableCamera } from '@/components/focusable-camera';
import {
  FinishHeader, FinishPalette, PhotoCard, PhotoCardBadge, PhotoCardChip, finishStyles, getPhotoCardRect,
} from '@/components/photo-card';
import { PreviewFilters } from '@/components/preview-filters';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { useBatchFinishes } from '@/hooks/use-batch-finishes';
import { useTheme } from '@/hooks/use-theme';
import { getDefaultCorners, hasCustomCrop } from '@/crop-geometry';
import {
  DEFAULT_INVERT_SETTINGS,
  PREVIEW_FILTER_OPTIONS,
  getInvertSettingsKey,
  normalizeInvertSettings,
} from '@/invert-settings';
import {
  PREVIEW_OUTPUT_EDGE,
  cleanupProcessedImagesAsync,
  createPreviewSourceAsync,
  prepareImportedImageAsync,
  renderPerspectiveCropAsync,
} from '@/perspective-crop';
import {
  appendUniqueMediaLibraryImages,
  normalizeMediaLibraryImage,
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

// Edit image shows crops and rotations at preview size. Saving renders full
// size from the original capture, so these images are for display only.
const renderBatchEditPreviewAsync = (options) =>
  renderPerspectiveCropAsync({ ...options, maxOutputEdge: PREVIEW_OUTPUT_EDGE });

function CameraScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const windowSize = useWindowDimensions();
  const router = useRouter();
  const cameraRef = useRef(null);
  const focusControllerRef = useRef(null);
  const batchTrayRef = useRef(null);
  const captureBoundsRef = useRef({ preview: null, tray: null });
  const cameraViewportRef = useRef(null);
  const cameraFeedbackFocusedRef = useRef(true);
  const batchCaptureSequenceRef = useRef(0);
  const captureInFlightRef = useRef(false);
  const cameraRequestStarted = useRef(false);
  const galleryLoadingRef = useRef(false);
  const galleryOffsetRef = useRef(0);
  const galleryHasMoreRef = useRef(true);
  const galleryRequestRef = useRef(0);
  const batchSaveInFlightRef = useRef(false);
  const batchSavePromiseRef = useRef(null);
  const singleSavePromiseRef = useRef(null);
  const batchSavedAssetsRef = useRef(new Map());
  const batchPrepareInFlightRef = useRef(false);
  const batchEditPromiseRef = useRef(null);
  const batchEditImagesRef = useRef(new Map());
  const batchRenderedPhotosRef = useRef({});
  const batchRenderedVariantsRef = useRef(new Map());
  const [batchRenderedPhotos, setBatchRenderedPhotos] = useState({});
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
  const [batchCaptureFlights, setBatchCaptureFlights] = useState([]);
  // The square advances when a flight is removed at landing, not at capture.
  const landedBatchPhotos = batchPhotos.filter((photo) =>
    !batchCaptureFlights.some((capture) => capture.photo.uri === photo.uri)
  ).map((photo) => batchRenderedPhotos[getBatchPhotoId(photo)] ?? photo);
  const [captureBlink, setCaptureBlink] = useState(null);
  const captureBlinkSequenceRef = useRef(0);
  const completeCaptureBlink = useCallback((id) => {
    setCaptureBlink((current) => current?.id === id ? null : current);
  }, []);
  const completeBatchCaptureFlight = useCallback((id) => {
    setBatchCaptureFlights((current) => current.filter((capture) => capture.id !== id));
  }, []);
  const [batchReviewPhotos, setBatchReviewPhotos] = useState(null);
  const [batchEditorPhotos, setBatchEditorPhotos] = useState(null);
  const [batchEdits, setBatchEdits] = useState({});
  const [batchSelectedIndex, setBatchSelectedIndex] = useState(0);
  useEffect(() => {
    setBatchSelectedIndex((index) => Math.min(index, Math.max(0, batchPhotos.length - 1)));
  }, [batchPhotos.length]);
  const [isApplyingBatchEdit, setIsApplyingBatchEdit] = useState(false);
  const [batchSaveProgress, setBatchSaveProgress] = useState({ completed: 0, total: 0 });
  // Review state lives with the batch, not with the Review screen, so leaving
  // Review to add a page keeps the chosen finish, its settings, the image being
  // viewed, and every result processed so far.
  const [batchFinishMode, setBatchFinishMode] = useState('original');
  const [batchInvertSettings, setBatchInvertSettings] = useState(DEFAULT_INVERT_SETTINGS);
  const [batchReviewIndex, setBatchReviewIndex] = useState(0);
  const batchFinishes = useBatchFinishes({
    photos: batchReviewPhotos,
    mode: batchFinishMode,
    invertSettings: batchInvertSettings,
    priorityIndex: batchReviewIndex,
    active: Boolean(batchReviewPhotos),
    getPendingJobs: () => [batchSavePromiseRef.current],
    onError: (mode, error) => {
      const label = PREVIEW_FILTER_OPTIONS.find((option) => option.value === mode)?.label ?? 'Image enhancement';
      Alert.alert(`${label} failed`, getErrorDetails(error).message);
    },
  });
  const { prune: pruneBatchFinishes, reset: resetBatchFinishes, whenIdle: whenBatchFinishesIdle } = batchFinishes;
  const [flashMode, setFlashMode] = useState('off');
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [savedPhoto, setSavedPhoto] = useState(null);
  const [savedImageMode, setSavedImageMode] = useState('original');
  // Measured image area of Preview; the rounded card is fitted inside it.
  const [previewFrame, setPreviewFrame] = useState({ width: 0, height: 0 });
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
  const [preparingImportKey, setPreparingImportKey] = useState(null);
  const importPrepareRequestRef = useRef(0);
  const temporaryPreviewPhotosRef = useRef(new Map());
  const invertPhotoCacheRef = useRef(new Map());
  const previewRequestRef = useRef(0);
  const previewBusyRef = useRef(false);
  const previewMountedRef = useRef(true);

  // The library is already underneath this route (`/` renders it). Replacing
  // the camera with `/explore` would stack a second library screen, so leave
  // by going back, and only fall back to the root for a deep-linked camera.
  const leaveCamera = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const refreshCaptureBounds = useCallback(() => {
    // Cache idle-camera bounds before the shutter runs; feedback never awaits
    // a newly mounted overlay or a post-capture measurement.
    focusControllerRef.current?.measurePreviewInWindow((x, y, width, height) => {
      const rect = { x, y, width, height };
      if (isBatchCaptureRect(rect)) captureBoundsRef.current.preview = rect;
    });
    batchTrayRef.current?.measureInWindow((x, y, width, height) => {
      const rect = { x, y, width, height };
      if (isBatchCaptureRect(rect)) captureBoundsRef.current.tray = rect;
    });
  }, []);

  const handleCameraViewportLayout = useCallback(({ nativeEvent: { layout } }) => {
    const previous = cameraViewportRef.current;
    if (!previous || previous.width !== layout.width || previous.height !== layout.height) {
      cameraViewportRef.current = { width: layout.width, height: layout.height };
      captureBoundsRef.current = { preview: null, tray: null };
    }
    refreshCaptureBounds();
  }, [refreshCaptureBounds]);

  const handleCameraReadiness = useCallback((ready) => {
    setIsCameraReady(ready);
    if (ready) {
      setCameraError(null);
      refreshCaptureBounds();
    }
  }, [refreshCaptureBounds]);

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
    void releaseTemporaryImagesAsync(
      photos,
      [singleSavePromiseRef.current, batchSavePromiseRef.current],
      cleanupProcessedImagesAsync
    );
  }, []);

  const trackTemporaryPreviewPhoto = useCallback((photo) => {
    if (photo?.temporary && photo.uri) {
      temporaryPreviewPhotosRef.current.set(photo.uri, photo);
    }
  }, []);

  const cleanupBatchEdits = useCallback((updateState = true) => {
    const photos = [...batchEditImagesRef.current.values()];
    batchEditImagesRef.current.clear();
    batchRenderedVariantsRef.current.clear();
    batchRenderedPhotosRef.current = {};
    if (updateState) setBatchRenderedPhotos({});
    if (photos.length) {
      void releaseTemporaryImagesAsync(
        photos,
        [batchEditPromiseRef.current, batchSavePromiseRef.current, whenBatchFinishesIdle()],
        cleanupProcessedImagesAsync
      );
    }
  }, [whenBatchFinishesIdle]);

  useEffect(() => {
    if (batchPhotos.length) return;
    // The batch ended (saved, discarded, or its last image deleted).
    cleanupBatchEdits();
    resetBatchFinishes();
    setBatchFinishMode('original');
    setBatchInvertSettings(DEFAULT_INVERT_SETTINGS);
    setBatchReviewIndex(0);
  }, [batchPhotos.length, cleanupBatchEdits, resetBatchFinishes]);

  useEffect(() => {
    previewMountedRef.current = true;
    return () => {
      previewMountedRef.current = false;
      previewRequestRef.current += 1;
      previewBusyRef.current = false;
      invertPhotoCacheRef.current.clear();
      cleanupTemporaryPreviewPhotos();
      cleanupBatchEdits(false);
    };
  }, [cleanupBatchEdits, cleanupTemporaryPreviewPhotos]);

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
    // Any image still being prepared belongs to a gallery that is now closed.
    importPrepareRequestRef.current += 1;
    setPreparingImportKey(null);
    setIsImporting(false);
    setIsCameraReady(false);
  };

  const selectGalleryImage = useCallback(async (asset) => {
    if (preparingImportKey) return;
    const request = ++importPrepareRequestRef.current;
    const isCurrent = () => previewMountedRef.current && importPrepareRequestRef.current === request;
    setPreparingImportKey(asset.id || asset.uri);

    try {
      // Bake EXIF orientation into the pixels and copy non-file sources to a
      // local file before the crop editor and GL filters ever see the image.
      const prepared = await prepareImportedImageAsync({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        fileName: asset.fileName ?? null,
      });
      if (!isCurrent()) {
        if (prepared.temporary) await cleanupProcessedImagesAsync([prepared]);
        return;
      }
      invalidateGalleryLoad();
      setCapturedPhoto({
        uri: prepared.uri,
        width: prepared.width,
        height: prepared.height,
        fileName: prepared.fileName ?? null,
        temporary: Boolean(prepared.temporary),
        // Already in the photo library, so leaving with it is not data loss.
        imported: true,
      });
      reviewEditsRef.current = null;
      setIsImporting(false);
      setIsCameraReady(false);
    } catch (error) {
      if (isCurrent()) {
        reportDiagnostic('Prepare imported image', error, {
          sourceUri: asset.uri,
          sourceWidth: asset.width ?? null,
          sourceHeight: asset.height ?? null,
        });
      }
    } finally {
      if (isCurrent()) setPreparingImportKey(null);
    }
  }, [invalidateGalleryLoad, preparingImportKey, reportDiagnostic]);

  // A prepared import is a temporary copy. Release it once the capture is
  // gone, unless a background save took it over (that save deletes it when
  // it is finished, so a retry can still read it).
  const handedOffUrisRef = useRef(new Set());
  useEffect(() => {
    const photo = capturedPhoto;
    if (!photo?.temporary) return undefined;
    return () => {
      if (handedOffUrisRef.current.delete(photo.uri)) return;
      void releaseTemporaryImagesAsync([photo], [], cleanupProcessedImagesAsync);
    };
  }, [capturedPhoto]);

  // A small copy of the current capture for preview renders, made in the
  // background while Review capture is on screen. Next and every finish then
  // read a few megapixels instead of the full capture.
  const previewSourceRef = useRef(null);
  const previewRenderJobsRef = useRef(new Set());
  useEffect(() => {
    const photo = capturedPhoto;
    if (!photo?.uri) return undefined;
    const entry = { photo, promise: createPreviewSourceAsync(photo) };
    previewSourceRef.current = entry;
    return () => {
      if (previewSourceRef.current === entry) previewSourceRef.current = null;
      void entry.promise.then((preview) => releaseTemporaryImagesAsync(
        preview?.temporary ? [preview] : [],
        [...previewRenderJobsRef.current],
        cleanupProcessedImagesAsync
      ));
    };
  }, [capturedPhoto]);
  const getPreviewSourceAsync = (photo) => (previewSourceRef.current?.photo === photo
    ? previewSourceRef.current.promise
    : Promise.resolve(null));
  // Renders that read the preview copy; it is deleted only after they settle.
  const trackPreviewRender = (promise) => {
    const jobs = previewRenderJobsRef.current;
    jobs.add(promise);
    promise.then(() => jobs.delete(promise), () => jobs.delete(promise));
    return promise;
  };

  const selectCaptureMode = useCallback((mode) => {
    if (mode === captureMode || captureInFlightRef.current || batchSaveInFlightRef.current) return;

    // Retain captures so switching back to Batch resumes the existing batch.
    setBatchCaptureFlights([]);
    setCaptureBlink(null);
    setCaptureMode(mode);
  }, [captureMode]);

  const renderGalleryItem = useCallback(
    ({ item }) => (
      <GalleryImportTile
        item={item}
        onSelect={selectGalleryImage}
        preparing={preparingImportKey === (item.id || item.uri)}
        disabled={Boolean(preparingImportKey)}
      />
    ),
    [preparingImportKey, selectGalleryImage]
  );

  useFocusEffect(
    useCallback(() => {
      cameraFeedbackFocusedRef.current = true;
      setIsFocused(true);

      return () => {
        cameraFeedbackFocusedRef.current = false;
        setIsFocused(false);
        setIsCameraReady(false);
        setBatchCaptureFlights([]);
        setCaptureBlink(null);
      };
    }, [])
  );

  useEffect(() => {
    if (!cameraPermission || cameraPermission.granted || cameraRequestStarted.current) return;

    cameraRequestStarted.current = true;
    requestCameraPermission().then((permission) => {
      if (!permission.granted) leaveCamera();
    }).catch(leaveCamera);
  }, [cameraPermission, requestCameraPermission, leaveCamera]);

  useEffect(() => {
    if (cameraPermission?.granted) {
      loadRecentGalleryImage();
    }
  }, [cameraPermission?.granted, loadRecentGalleryImage]);

  const capturePhoto = async () => {
    if (!cameraRef.current || !isCameraReady || isCapturing || captureInFlightRef.current ||
      batchPrepareInFlightRef.current || batchSaveInFlightRef.current) return;

    captureInFlightRef.current = true;
    setIsCapturing(true);

    try {
      if (cameraFeedbackFocusedRef.current && previewMountedRef.current) {
        const geometry = snapshotBatchCaptureGeometry(
          {}, cameraViewportRef.current ?? windowSize, insets, captureBoundsRef.current, Spacing.three, windowSize
        );
        setCaptureBlink({ id: ++captureBlinkSequenceRef.current, geometry });
      }
      if (captureMode === 'batch') refreshCaptureBounds();
      const focusResult = await focusControllerRef.current?.prepareCaptureAsync();
      if (focusResult?.status === 'cancelled' || !cameraRef.current) return;

      const photo = await cameraRef.current.takePictureAsync({
        imageType: 'jpg',
        quality: 0.92,
        base64: false,
        exif: false,
        skipProcessing: false,
        shutterSound: false,
      });

      if (!photo?.uri) {
        throw new Error('Camera capture completed without returning a photo URI.');
      }

      if (captureMode === 'batch') {
        if (cameraFeedbackFocusedRef.current && previewMountedRef.current) {
          const geometry = snapshotBatchCaptureGeometry(
            photo, cameraViewportRef.current ?? windowSize, insets, captureBoundsRef.current, Spacing.three, windowSize
          );
          const capture = { id: ++batchCaptureSequenceRef.current, photo, geometry };
          setBatchCaptureFlights((current) => appendBatchCaptureFlight(current, capture));
        }
        setBatchPhotos((current) => [...current, photo]);
      } else {
        setCaptureBlink(null);
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

  const openBatchEditor = () => {
    if (captureMode !== 'batch' || !batchPhotos.length || isCapturing || captureInFlightRef.current ||
      batchPrepareInFlightRef.current || batchSaveInFlightRef.current || batchSavedAssetsRef.current.size) return;
    setBatchCaptureFlights([]);
    setCaptureBlink(null);
    setBatchSelectedIndex(batchPhotos.length - 1);
    setBatchEditorPhotos(batchPhotos);
    setIsCameraReady(false);
  };

  const deleteBatchPhoto = (photo) => {
    if (!photo?.uri || batchPrepareInFlightRef.current || batchSaveInFlightRef.current ||
      batchSavedAssetsRef.current.size) return;
    const id = getBatchPhotoId(photo);
    const nextRendered = { ...batchRenderedPhotosRef.current };
    delete nextRendered[id];
    for (const [key, variant] of batchRenderedVariantsRef.current) {
      if (getBatchPhotoId(variant) === id) batchRenderedVariantsRef.current.delete(key);
    }
    batchRenderedPhotosRef.current = nextRendered;
    setBatchRenderedPhotos(nextRendered);
    setBatchPhotos((current) => current.filter((item) => item.uri !== photo.uri));
    setBatchEditorPhotos((current) => {
      if (!current) return null;
      const remaining = current.filter((item) => item.uri !== photo.uri);
      return remaining.length ? remaining : null;
    });
    setBatchEdits((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setIsCameraReady(false);
  };

  const finishBatchCapture = () => {
    if (captureMode !== 'batch' || !batchPhotos.length || isCapturing || captureInFlightRef.current ||
      batchPrepareInFlightRef.current || batchSaveInFlightRef.current || batchSavedAssetsRef.current.size) return;
    setBatchCaptureFlights([]);
    setCaptureBlink(null);
    setIsCameraReady(false);
    const reviewPhotos = batchPhotos.map((photo) =>
      batchRenderedPhotosRef.current[getBatchPhotoId(photo)] ?? { ...photo, sourcePhoto: photo }
    );
    // Finished results for unchanged images are reused; only new or re-edited
    // images are processed again.
    pruneBatchFinishes(reviewPhotos);
    setBatchReviewIndex((index) => Math.min(index, reviewPhotos.length - 1));
    setBatchReviewPhotos(reviewPhotos);
    setBatchEditorPhotos(null);
  };

  const selectBatchFinishMode = useCallback((mode) => {
    // Re-selecting a finish also retries any images that failed with it.
    batchFinishes.retryFailed(getFinishRenderKey(mode, batchInvertSettings));
    setBatchFinishMode(mode);
  }, [batchFinishes, batchInvertSettings]);

  const changeBatchInvertSettings = useCallback((settings) => {
    const normalized = normalizeInvertSettings(settings);
    setBatchInvertSettings((current) =>
      getInvertSettingsKey(current) === getInvertSettingsKey(normalized) ? current : normalized
    );
  }, []);

  // The batch session ends (saved or discarded): release every finish result.
  const resetBatchReviewState = useCallback(() => {
    resetBatchFinishes();
    setBatchFinishMode('original');
    setBatchInvertSettings(DEFAULT_INVERT_SETTINGS);
    setBatchReviewIndex(0);
  }, [resetBatchFinishes]);

  const returnToBatchCamera = useCallback(() => {
    if (batchSaveInFlightRef.current || batchPrepareInFlightRef.current || batchSavedAssetsRef.current.size) return;
    setBatchReviewPhotos(null);
    setBatchEditorPhotos(null);
    cleanupTemporaryPreviewPhotos();
    setIsCameraReady(false);
  }, [cleanupTemporaryPreviewPhotos]);

  useFocusEffect(useCallback(() => {
    if (!batchReviewPhotos && !isApplyingBatchEdit) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!isApplyingBatchEdit) returnToBatchCamera();
      return true;
    });
    return () => subscription.remove();
  }, [batchReviewPhotos, isApplyingBatchEdit, returnToBatchCamera]));

  const commitBatchPhotoEdits = (photo, edits, { background = false, isCurrent = () => true } = {}) => {
    if (!isCurrent() || batchPrepareInFlightRef.current || batchSaveInFlightRef.current ||
      batchSavedAssetsRef.current.size) return Promise.resolve(false);
    const id = getBatchPhotoId(photo);
    const cached = batchRenderedPhotosRef.current[id];
    const key = getBatchEditKey(edits);
    if ((cached && getBatchEditKey(cached.edits) === key) ||
      (!cached && key === getBatchEditKey())) return Promise.resolve(true);

    const variantKey = JSON.stringify([photo.uri, key]);
    const publish = (prepared) => {
      if (!previewMountedRef.current || !isCurrent()) return false;
      const next = { ...batchRenderedPhotosRef.current, [id]: prepared };
      batchRenderedPhotosRef.current = next;
      setBatchRenderedPhotos(next);
      setBatchEdits((current) => ({ ...current, [id]: prepared.edits }));
      return true;
    };
    const variant = batchRenderedVariantsRef.current.get(variantKey);
    if (variant) return Promise.resolve(publish(variant));

    batchPrepareInFlightRef.current = true;
    if (!background) setIsApplyingBatchEdit(true);
    // Own every generated file, including superseded orientations, until the
    // batch ends. Cached orientations can then be reused without another export.
    const job = Promise.resolve().then(async () => {
      try {
        const prepared = await renderBatchEditAsync(photo, edits, renderBatchEditPreviewAsync);
        if (!previewMountedRef.current) {
          if (prepared.temporary) await cleanupProcessedImagesAsync([prepared]);
          return false;
        }
        if (prepared.temporary) batchEditImagesRef.current.set(prepared.uri, prepared);
        batchRenderedVariantsRef.current.set(variantKey, prepared);
        return publish(prepared);
      } catch (error) {
        if (!background && previewMountedRef.current) {
          Alert.alert('Could not apply edit', getErrorDetails(error).message);
        }
        return false;
      } finally {
        batchPrepareInFlightRef.current = false;
        if (!background && previewMountedRef.current) setIsApplyingBatchEdit(false);
      }
    });
    batchEditPromiseRef.current = job;
    return job;
  };

  const discardBatch = () => {
    if (batchSaveInFlightRef.current || batchPrepareInFlightRef.current) return;
    setBatchPhotos([]);
    setBatchReviewPhotos(null);
    setBatchEditorPhotos(null);
    setBatchEdits({});
    setBatchSelectedIndex(0);
    batchSavedAssetsRef.current.clear();
    setBatchSaveProgress({ completed: 0, total: 0 });
    resetBatchReviewState();
    cleanupBatchEdits();
    cleanupTemporaryPreviewPhotos();
    setCaptureMode('single');
    setIsCameraReady(false);
  };

  // Hands the batch to the background queue and ends the batch session at
  // once. The queue renders each image at full size from its original capture
  // (crop + finish in one pass), so neither the preview results nor the Edit
  // image renders need to stay around.
  const saveBatch = async () => {
    const photos = batchReviewPhotos;
    if (!photos?.length || batchSaveInFlightRef.current) return;

    // Only the permission prompt can make the person wait here.
    batchSaveInFlightRef.current = true;
    setIsSavingBatch(true);
    try {
      let permission = mediaPermission;
      if (!permission?.granted) permission = await requestMediaPermission();
      if (!permission?.granted) {
        if (previewMountedRef.current) Alert.alert('Permission needed', 'Allow photo access to save this batch.');
        return;
      }
      if (!previewMountedRef.current) return;

      const mode = batchFinishMode;
      const settings = normalizeInvertSettings(batchInvertSettings);
      backgroundSaves.enqueue({
        label: photos.length > 1 ? 'batch' : 'image',
        items: photos.map((photo) => {
          const source = photo.sourcePhoto ?? photo;
          const edits = photo.edits ? JSON.parse(JSON.stringify(photo.edits)) : null;
          return {
            id: getBatchPhotoId(photo),
            render: () => renderFinishAsync({ source, edits, mode, invertSettings: settings, size: 'full' }),
          };
        }),
        onItemSaved: (asset) => {
          normalizeMediaLibraryImage(asset)
            .then((image) => {
              if (image?.uri && previewMountedRef.current) setRecentGalleryImage(image);
            })
            .catch(() => {});
        },
      });
      console.log('[screen] Batch handed to background save', { count: photos.length, mode });

      setBatchPhotos([]);
      setBatchReviewPhotos(null);
      setBatchEdits({});
      setBatchSelectedIndex(0);
      batchSavedAssetsRef.current.clear();
      setBatchSaveProgress({ completed: 0, total: 0 });
      resetBatchReviewState();
      cleanupBatchEdits();
      cleanupTemporaryPreviewPhotos();
      setCaptureMode('single');
      setIsCameraReady(false);
    } catch (error) {
      reportDiagnostic('Save batch', error, { count: photos.length });
    } finally {
      batchSaveInFlightRef.current = false;
      if (previewMountedRef.current) setIsSavingBatch(false);
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

  // Import Image and Review capture are steps inside this route. Android Back
  // closes the gallery or returns to the camera instead of leaving the route.
  const isReviewingCapture = Boolean(capturedPhoto) && !savedPhoto && !batchEditorPhotos &&
    !batchReviewPhotos && !isImporting;
  useFocusEffect(useCallback(() => {
    if (!isImporting && !isReviewingCapture) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isImporting) {
        closeImportImage();
        return true;
      }
      if (isCapturing) return true;
      if (capturedPhoto?.imported) {
        discardPhoto();
        return true;
      }
      Alert.alert('Discard this capture?', 'This capture has not been saved.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: discardPhoto },
      ]);
      return true;
    });
    return () => subscription.remove();
  }, [isImporting, isReviewingCapture, isCapturing, capturedPhoto, closeImportImage, discardPhoto]));

  // Unsaved captures (a batch, or a single camera capture in Review/Preview)
  // must never disappear because of one tap on Close or one Android Back.
  // Imports are already in the photo library, so leaving with one is safe.
  const unsavedBatchCount = batchPhotos.length;
  const hasUnsavedCapture = Boolean(capturedPhoto) && !capturedPhoto.imported;
  const isBusyWithFiles = isSavingBatch || isSavingPreview || isApplyingBatchEdit;
  usePreventRemove(isBusyWithFiles || unsavedBatchCount > 0 || hasUnsavedCapture, ({ repeat }) => {
    if (batchSaveInFlightRef.current || singleSavePromiseRef.current || batchPrepareInFlightRef.current ||
      isBusyWithFiles) {
      Alert.alert('Saving in progress', 'Wait for the current save to finish before leaving the camera.');
      return;
    }

    const savedCount = batchSavedAssetsRef.current.size;
    const remaining = unsavedBatchCount - savedCount;
    const images = (value) => `${value} ${value === 1 ? 'image' : 'images'}`;
    let title;
    let message;
    if (unsavedBatchCount > 0 && hasUnsavedCapture) {
      title = 'Discard unsaved images?';
      message = `Your batch of ${images(remaining)} and the current capture have not been saved.`;
    } else if (unsavedBatchCount > 0) {
      title = `Discard ${images(remaining)}?`;
      message = savedCount > 0
        ? `${savedCount} of ${unsavedBatchCount} are already in Snippets. The rest of the batch has not been saved.`
        : 'This batch has not been saved.';
    } else {
      title = 'Discard this capture?';
      message = 'This capture has not been saved.';
    }

    const discardAndLeave = () => {
      // Clear the unsaved state first so removal prevention is off when the
      // blocked navigation repeats.
      discardBatch();
      closeSavedPhoto();
      repeat();
    };

    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`${title}\n\n${message}`)) discardAndLeave();
      return;
    }
    Alert.alert(title, message, [
      { text: 'Keep scanning', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discardAndLeave },
    ]);
  });

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
    if (!isKnownFinish(mode)) return;
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
      // Crop and finish in one preview-size pass, from the preview copy of the
      // capture. The saved image repeats this pass at full size.
      const sourcePhoto = capturedPhoto ?? savedPhoto;
      const edits = capturedPhoto ? reviewEditsRef.current : null;
      const previewSource = await getPreviewSourceAsync(capturedPhoto);
      const enhancedPhoto = await trackPreviewRender(renderFinishAsync({
        source: sourcePhoto,
        previewSource,
        edits,
        mode,
        invertSettings: settings,
        size: 'preview',
      }));
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
    if (!savedPhoto || !capturedPhoto?.uri || isSavingPreview || isEnhancing || previewBusyRef.current) return;

    // Only the permission prompt can make the person wait here.
    setIsSavingPreview(true);
    try {
      let permission = mediaPermission;
      if (!permission?.granted) permission = await requestMediaPermission();
      if (!permission?.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save this image.');
        return;
      }
      if (!previewMountedRef.current) return;

      // Everything the full-size render needs, captured now: Preview closes
      // right away and the queue renders crop + finish from the capture.
      const source = capturedPhoto;
      const edits = reviewEditsRef.current ? JSON.parse(JSON.stringify(reviewEditsRef.current)) : null;
      const mode = savedImageMode;
      const settings = normalizeInvertSettings(invertSettings);
      if (source.temporary) handedOffUrisRef.current.add(source.uri);

      backgroundSaves.enqueue({
        label: 'image',
        items: [{
          id: source.uri,
          render: () => renderFinishAsync({ source, edits, mode, invertSettings: settings, size: 'full' }),
        }],
        ownedFiles: source.temporary ? [source] : [],
        onItemSaved: (asset) => {
          normalizeMediaLibraryImage(asset)
            .then((image) => {
              if (image?.uri && previewMountedRef.current) setRecentGalleryImage(image);
            })
            .catch(() => {});
        },
      });
      console.log('[screen] Image handed to background save', { mode });
      closeSavedPhoto();
    } catch (error) {
      reportDiagnostic('Save final image', error, { mode: savedImageMode });
    } finally {
      if (previewMountedRef.current) setIsSavingPreview(false);
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

      // Preview size only: the crop stays metadata, and saving renders it at
      // full size from the capture together with the chosen finish.
      const previewSource = await getPreviewSourceAsync(capturedPhoto);
      const selectedPhoto = await trackPreviewRender(renderFinishAsync({
        source: capturedPhoto,
        previewSource,
        edits: { corners: cropCorners ?? getDefaultCorners(), rotation: capturedRotation },
        mode: 'original',
        size: 'preview',
      }));

      if (selectedPhoto.temporary) trackTemporaryPreviewPhoto(selectedPhoto);

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
                extraData={preparingImportKey}
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

  if (batchEditorPhotos) {
    return (
      <BatchEditor
        photos={batchEditorPhotos}
        editsById={batchEdits}
        renderedPhotosById={batchRenderedPhotos}
        onCommitEdits={commitBatchPhotoEdits}
        isApplying={isApplyingBatchEdit}
        selectedIndex={batchSelectedIndex}
        onSelect={setBatchSelectedIndex}
        onBack={returnToBatchCamera}
        onDone={returnToBatchCamera}
        onDelete={deleteBatchPhoto}
      />
    );
  }

  if (batchReviewPhotos) {
    return (
      <BatchReviewScreen
        photos={batchReviewPhotos}
        displayedPhotos={batchFinishes.displayed}
        statuses={batchFinishes.statuses}
        mode={batchFinishMode}
        onModeChange={selectBatchFinishMode}
        invertSettings={batchInvertSettings}
        onInvertSettingsChange={changeBatchInvertSettings}
        currentIndex={batchReviewIndex}
        onIndexChange={setBatchReviewIndex}
        completed={batchFinishes.completed}
        failed={batchFinishes.failed}
        total={batchFinishes.total}
        isProcessing={batchFinishes.isProcessing}
        canSave={batchReviewPhotos.length > 0}
        onRetryFailed={() => batchFinishes.retryFailed()}
        isSaving={isSavingBatch}
        saveProgress={batchSaveProgress}
        onBack={returnToBatchCamera}
        onDiscard={discardBatch}
        onSave={() => { void saveBatch(); }}
      />
    );
  }

  if (savedPhoto) {
    const previewBusy = isEnhancing || isSavingPreview;
    const canComparePreview = savedImageMode !== 'original' && !previewBusy;
    const previewFinishLabel =
      PREVIEW_FILTER_OPTIONS.find((option) => option.value === savedImageMode)?.label ?? 'Original';
    const showsFinishedPreview = displayedSavedPhoto !== savedPhoto;
    // Finishes keep the crop's shape, so the crop sizes the card and switching
    // finish never resizes it.
    const previewCardRect = getPhotoCardRect(savedPhoto, previewFrame);

    return (
      <>
        <View style={styles.savedImageContainer}>
          <SafeAreaView style={[styles.savedImageSafeArea, { paddingBottom: Spacing.three }]}>
            <FinishHeader
              title="Preview"
              subtitle="Choose your finish"
              onBack={returnToReview}
              backLabel="Back to review capture"
              backDisabled={previewBusy}
              compareActive={comparisonMode === 'toggle'}
              compareDisabled={!canComparePreview}
              onCompare={() => setComparisonMode((current) => current === 'toggle' ? null : 'toggle')}
            />

            <Pressable
              accessibilityLabel={`Preview image, ${comparisonMode ? 'original' : previewFinishLabel}`}
              accessibilityHint={canComparePreview ? 'Hold to compare with the original crop.' : undefined}
              disabled={!canComparePreview}
              delayLongPress={180}
              onLongPress={() => setComparisonMode('hold')}
              onPressOut={() => setComparisonMode((current) => current === 'hold' ? null : current)}
              onLayout={({ nativeEvent: { layout } }) => {
                setPreviewFrame((current) => (current.width === layout.width && current.height === layout.height
                  ? current : { width: layout.width, height: layout.height }));
              }}
              style={styles.savedImageFrame}>
              {previewFrame.width > 0 && previewFrame.height > 0 ? (
                <PhotoCard
                  rect={previewCardRect}
                  overlay={(
                    <>
                      {comparisonMode ? <PhotoCardBadge /> : null}
                      {isEnhancing ? <PhotoCardChip label={`Applying ${previewFinishLabel}`} /> : null}
                    </>
                  )}>
                  {/* A recyclingKey that is stable for this capture keeps the
                      current pixels until the next finish has decoded, so
                      finishes crossfade instead of blinking. */}
                  <Image
                    source={displayedSavedPhoto.uri}
                    contentFit="cover"
                    recyclingKey={`finish:${savedPhoto.uri}`}
                    transition={showsFinishedPreview ? 160 : 0}
                    accessible={false}
                    style={StyleSheet.absoluteFill}
                  />
                  {showsFinishedPreview ? (
                    // Kept mounted under the finished image so comparing is instant.
                    <Image
                      source={savedPhoto.uri}
                      contentFit="cover"
                      recyclingKey={`original:${savedPhoto.uri}`}
                      transition={0}
                      accessible={false}
                      style={[StyleSheet.absoluteFill, { opacity: comparisonMode ? 1 : 0 }]}
                    />
                  ) : null}
                </PhotoCard>
              ) : null}
            </Pressable>

            <View style={finishStyles.hintRow} accessibilityLiveRegion="polite">
              {savedImageMode !== 'original' ? (
                <ThemedText style={finishStyles.hintText}>
                  {comparisonMode === 'hold' ? 'Original · Release to return'
                    : comparisonMode === 'toggle' ? 'Original · Tap Compare to return'
                      : 'Hold image to compare with original'}
                </ThemedText>
              ) : null}
            </View>

            <PreviewFilters
              selectedMode={savedImageMode}
              onModeChange={selectSavedImageMode}
              invertSettings={invertSettings}
              onInvertSettingsChange={changeInvertSettings}
              disabled={previewBusy}
            />

            <View style={[styles.previewActionBar, { paddingBottom: insets.bottom }]}>
              <Pressable
                accessibilityLabel="Retake photo"
                accessibilityRole="button"
                disabled={previewBusy}
                onPress={closeSavedPhoto}
                style={({ pressed }) => [
                  styles.previewAction,
                  styles.previewRetakeAction,
                  pressed && styles.pressed,
                  previewBusy && styles.disabled,
                ]}>
                <SymbolView
                  name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
                  size={25}
                  tintColor={FinishPalette.discard}
                />
                <ThemedText type="smallBold" allowFontScaling={false} style={styles.previewRetakeLabel}>
                  Retake
                </ThemedText>
              </Pressable>

              <Pressable
                accessibilityLabel="Save selected image"
                accessibilityRole="button"
                accessibilityState={{ disabled: previewBusy, busy: isSavingPreview }}
                disabled={previewBusy}
                onPress={saveSavedImage}
                style={({ pressed }) => [
                  styles.previewAction,
                  styles.previewSaveAction,
                  pressed && styles.pressed,
                  previewBusy && styles.disabled,
                ]}>
                {isSavingPreview ? (
                  <ActivityIndicator color={FinishPalette.background} />
                ) : (
                  <SymbolView
                    name={{ ios: 'arrow.down.circle.fill', android: 'download', web: 'download' }}
                    size={25}
                    tintColor={FinishPalette.background}
                  />
                )}
                <ThemedText type="smallBold" allowFontScaling={false} style={styles.previewSaveLabel}>
                  {isSavingPreview ? 'Saving' : 'Save'}
                </ThemedText>
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
    <View onLayout={handleCameraViewportLayout} style={styles.container}>
      {isFocused && (
        <FocusableCamera
          ref={focusControllerRef}
          CameraComponent={CameraView}
          cameraRef={cameraRef}
          disabled={isCapturing}
          animateShutter={false}
          batchMode={captureMode === 'batch'}
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
          onPress={leaveCamera}
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
            <Pressable
              accessibilityLabel={`Edit batch images. ${batchPhotos.length} ${batchPhotos.length === 1 ? 'image' : 'images'} captured.`}
              accessibilityHint="Opens Edit image to crop, rotate, or delete captured images."
              accessibilityRole="button"
              accessibilityState={{ disabled: !batchPhotos.length || isCapturing }}
              disabled={!batchPhotos.length || isCapturing}
              onPress={openBatchEditor}
              style={({ pressed }) => [
                styles.importButtonSpacer,
                pressed && styles.pressed,
                isCapturing && styles.disabled,
              ]}>
              <BatchCaptureTray
                ref={batchTrayRef}
                onLayout={refreshCaptureBounds}
                photo={landedBatchPhotos[landedBatchPhotos.length - 1]}
                count={landedBatchPhotos.length}
                pendingPhotos={batchCaptureFlights.map((capture) => capture.photo)}
              />
            </Pressable>
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
              accessibilityState={{ disabled: !isCameraReady || isCapturing, busy: isCapturing }}
              disabled={!isCameraReady || isCapturing}
              onPress={capturePhoto}
              style={({ pressed }) => [
                styles.captureButton,
                { borderColor: '#16C7B7' },
                pressed && styles.pressed,
                (!isCameraReady || isCapturing) && styles.disabled,
              ]}>
              <View style={[
                styles.captureButtonInner,
                { backgroundColor: Colors.light.background },
              ]} />
            </Pressable>
          </View>

          {captureMode === 'batch' ? (
            <Pressable
              accessibilityLabel="Review captured batch"
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

      {isFocused && (captureBlink || batchCaptureFlights.length > 0) && (
        <CameraCaptureOverlay
          blink={captureBlink}
          flights={batchCaptureFlights}
          onBlinkComplete={completeCaptureBlink}
          onComplete={completeBatchCaptureFlight}
        />
      )}

      {cameraError && (
        <View style={styles.errorOverlay} pointerEvents="none">
          <ThemedText style={styles.statusText}>{cameraError}</ThemedText>
        </View>
      )}
      {diagnosticOverlay}
    </View>
  );
}

const GalleryImportTile = memo(function GalleryImportTile({ item, onSelect, preparing = false, disabled = false }) {
  return (
    <Pressable
      accessibilityLabel={`Import image ${item.fileName || 'from gallery'}`}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: preparing }}
      disabled={disabled}
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
      {preparing ? (
        <View pointerEvents="none" style={styles.galleryTilePreparing}>
          <ActivityIndicator color={Colors.light.background} />
        </View>
      ) : null}
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
  savedImageContainer: {
    flex: 1,
    backgroundColor: FinishPalette.background,
  },
  reviewSafeArea: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
  savedImageHeaderSpacer: {
    width: 48,
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
  // Measured area for the image; the rounded card is fitted inside it.
  savedImageFrame: {
    width: '100%',
    flex: 1,
    minHeight: 1,
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
  previewActionBar: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    marginTop: Spacing.two,
    marginHorizontal: -Spacing.four,
    marginBottom: -Spacing.three,
    backgroundColor: FinishPalette.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DCE4ED',
  },
  previewAction: {
    flex: 1,
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
  },
  previewRetakeAction: {
    backgroundColor: '#FFF5F6',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#F0C9CF',
  },
  previewSaveAction: { backgroundColor: FinishPalette.save },
  previewRetakeLabel: { color: FinishPalette.discard },
  previewSaveLabel: { color: FinishPalette.background },
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
  galleryTilePreparing: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
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

