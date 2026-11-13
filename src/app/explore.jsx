import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { SymbolView } from 'expo-symbols';
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  I18nManager,
  PanResponder,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { SelectionActionBar } from '@/components/selection-actions';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  appendUniqueMediaLibraryImages,
  getSnippetsAlbum,
  normalizeMediaLibraryImage,
} from '@/snippets-library';

import { createSnippetDateSections, sortSnippetsNewestFirst } from '@/snippet-date-sections';
import { createGalleryDragSelection, getGalleryGesturePoint } from '@/snippet-drag-selection';
import { createSnippetsPdfAsync } from '@/snippets-pdf';
import { shareImagesAsync } from '@/multi-image-sharing';

const GALLERY_COLUMNS = 3;
const GALLERY_PAGE_SIZE = 36;
const GalleryDragContext = createContext(null);
const mediaLibraryModule = getMediaLibraryModule();
const useMediaPermissions = mediaLibraryModule?.usePermissions ?? (() => [null, null]);

function getMediaLibraryModule() {
  try {
    return require('expo-media-library');
  } catch {
    return null;
  }
}

export default function ExploreScreen() {
  const theme = useTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const router = useRouter();
  const [selectionStore] = useState(createSnippetSelectionStore);
  const setSelectedImageIds = selectionStore.setSelectedImageIds;
  const loadingRef = useRef(false);
  const assetsRef = useRef([]);
  const paginationOffsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const permissionRef = useRef(null);
  const mediaPermissionRef = useRef(null);
  const openedImageRef = useRef(null);
  const pdfExportBusyRef = useRef(false);
  const pdfExportRequestRef = useRef(0);
  const pdfExportMountedRef = useRef(true);
  const pdfShareSheetOpenRef = useRef(false);
  const imageShareSheetOpenRef = useRef(false);
  const shareBusyRef = useRef(false);
  const shareRequestRef = useRef(0);
  const galleryListRef = useRef(null);
  const galleryViewportRef = useRef(null);
  const gestureCallbacksRef = useRef({ disabled: false });
  const [mediaPermission, requestMediaPermission] = useMediaPermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const requestMediaPermissionRef = useRef(requestMediaPermission);
  requestMediaPermissionRef.current = requestMediaPermission;
  const [savedImages, setSavedImages] = useState([]);
  const [calendarNow, setCalendarNow] = useState(() => Date.now());
  const dateSections = useMemo(
    () => createSnippetDateSections(savedImages, { now: calendarNow, columns: GALLERY_COLUMNS }),
    [savedImages, calendarNow]
  );
  const [hasMoreImages, setHasMoreImages] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [openedImage, setOpenedImage] = useState(null);
  const [pdfProgress, setPdfProgress] = useState(null);

  useEffect(() => {
    pdfExportMountedRef.current = true;
    return () => {
      pdfExportMountedRef.current = false;
      pdfExportRequestRef.current += 1;
      shareRequestRef.current += 1;
    };
  }, []);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const [dragSelection] = useState(() => createGalleryDragSelection({
    getImages: () => assetsRef.current,
    getSelection: selectionStore.getSnapshot,
    setSelection: setSelectedImageIds,
    columns: GALLERY_COLUMNS,
    gap: Spacing.one,
    rtl: I18nManager.isRTL,
    isEnabled: () => !gestureCallbacksRef.current.disabled,
    onActiveChange: setIsDragSelecting,
    scrollTo: (y) => galleryListRef.current?.getScrollResponder()?.scrollTo({ y, animated: false }),
  }));
  gestureCallbacksRef.current.disabled = isDeleting || isSharing || Boolean(pdfProgress);

  const measureGalleryViewport = useCallback(() => {
    galleryViewportRef.current?.measureInWindow((x, y, width, height) => {
      dragSelection.setViewport({ x, y, width, height, bottomInset: 96 });
    });
  }, [dragSelection]);

  useEffect(() => {
    measureGalleryViewport();
    return () => dragSelection.dispose();
  }, [dragSelection, measureGalleryViewport]);

  const gallerySwipeResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: (event) =>
      dragSelection.prepare(getGalleryGesturePoint(event)),
    onMoveShouldSetPanResponderCapture: (event) =>
      dragSelection.canClaimMove(getGalleryGesturePoint(event)),
    onPanResponderGrant: (event) => dragSelection.begin(getGalleryGesturePoint(event)),
    onPanResponderStart: (event) => {
      if (getGalleryGesturePoint(event)?.touchCount !== 1) dragSelection.cancel();
    },
    onPanResponderMove: (event) => dragSelection.move(getGalleryGesturePoint(event)),
    onPanResponderRelease: (event) => dragSelection.finish(getGalleryGesturePoint(event)),
    onPanResponderReject: () => dragSelection.cancel(),
    onPanResponderTerminate: () => dragSelection.cancel(),
    onPanResponderTerminationRequest: () => !dragSelection.isActive(),
    onShouldBlockNativeResponder: () => dragSelection.isActive(),
  }), [dragSelection]);

  useEffect(() => {
    mediaPermissionRef.current = mediaPermission;
  }, [mediaPermission]);

  useEffect(() => {
    openedImageRef.current = openedImage;
  }, [openedImage]);

  useEffect(() => {
    let midnightTimer;

    const refreshCalendar = () => {
      clearTimeout(midnightTimer);
      const now = new Date();
      setCalendarNow(now.getTime());
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      midnightTimer = setTimeout(refreshCalendar, Math.max(1000, nextMidnight.getTime() - now.getTime() + 100));
    };

    refreshCalendar();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshCalendar();
      } else {
        dragSelection.cancel();
        if (!pdfShareSheetOpenRef.current) pdfExportRequestRef.current += 1;
        if (!imageShareSheetOpenRef.current) shareRequestRef.current += 1;
        clearTimeout(midnightTimer);
      }
    });

    return () => {
      clearTimeout(midnightTimer);
      subscription.remove();
    };
  }, [dragSelection]);

  const closeOpenedImage = useCallback(() => {
    shareRequestRef.current += 1;
    openedImageRef.current = null;
    setActionError(null);
    setOpenedImage(null);
  }, []);

  const clearSelection = useCallback(() => {
    pdfExportRequestRef.current += 1;
    shareRequestRef.current += 1;
    dragSelection.cancel();
    setSelectedImageIds(new Set());
  }, [dragSelection, setSelectedImageIds]);

  const loadSavedImages = useCallback(async (reset = false) => {
    if (loadingRef.current || (!reset && !hasMoreRef.current)) return false;
    if (reset) dragSelection.cancel();

    loadingRef.current = true;
    setIsLoading(true);

    try {
      if (
        !mediaLibraryModule?.Query ||
        !mediaLibraryModule?.AssetField ||
        !mediaLibraryModule?.MediaType ||
        !mediaLibraryModule?.Album
      ) {
        throw new Error('The media-library gallery API is unavailable in this build.');
      }

      let permission = permissionRef.current ?? mediaPermissionRef.current;
      if (!permission?.granted) {
        permission = await requestMediaPermissionRef.current?.();
        permissionRef.current = permission;
      }

      if (!permission?.granted) {
        throw new Error('Photo-library permission was not granted.');
      }

      const snippetsAlbum = await getSnippetsAlbum(mediaLibraryModule);
      if (!snippetsAlbum) {
        clearSelection();
        assetsRef.current = [];
        paginationOffsetRef.current = 0;
        hasMoreRef.current = false;
        setSavedImages([]);
        setHasMoreImages(false);
        setLoadError(null);
        return true;
      }

      const offset = reset ? 0 : paginationOffsetRef.current;
      const assets = await querySavedImagePage(snippetsAlbum, offset, GALLERY_PAGE_SIZE);
      const normalizedAssets = await Promise.all(assets.map(normalizeMediaLibraryImage));
      const usableAssets = normalizedAssets.filter((asset) => asset?.uri);
      const nextImages = sortSnippetsNewestFirst(appendUniqueMediaLibraryImages(
        reset ? [] : assetsRef.current,
        usableAssets
      ));
      // Advance by the native page size, including duplicates or unusable
      // records, so pagination cannot skip or repeatedly fetch the same page.
      const nextHasMore = assets.length === GALLERY_PAGE_SIZE;

      // A full refresh replaces the loaded pages. Clear selection at commit
      // so selections made while the request was pending cannot become stale.
      if (reset) clearSelection();
      assetsRef.current = nextImages;
      paginationOffsetRef.current = offset + assets.length;
      hasMoreRef.current = nextHasMore;
      setSavedImages(nextImages);
      setHasMoreImages(nextHasMore);
      setLoadError(null);
      return true;
    } catch (error) {
      setLoadError(getErrorMessage(error));
      return false;
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [clearSelection, dragSelection]);

  useFocusEffect(
    useCallback(() => {
      loadSavedImages(true);

      return () => {
        dragSelection.cancel();
        pdfExportRequestRef.current += 1;
        shareRequestRef.current += 1;
      };
    }, [dragSelection, loadSavedImages])
  );

  useFocusEffect(
    useCallback(() => {
      if (!BackHandler?.addEventListener) return undefined;

      const handleBackPress = () => {
        if (selectionStore.getSnapshot().size > 0) {
          clearSelection();
          return true;
        }
        if (!openedImageRef.current) return false;

        closeOpenedImage();
        return true;
      };

      const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);

      return () => subscription.remove();
    }, [clearSelection, closeOpenedImage, selectionStore])
  );

  const toggleSelection = useCallback((image) => {
    setSelectedImageIds((current) => {
      const next = new Set(current);
      const key = getAssetKey(image);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }, [setSelectedImageIds]);

  const openImage = useCallback((image) => {
    openedImageRef.current = image;
    setActionError(null);
    setOpenedImage(image);
  }, []);

  const navigateOpenedImage = useCallback((image) => {
    if (!image) return;

    openedImageRef.current = image;
    setActionError(null);
    setOpenedImage(image);
  }, []);

  const handleTilePress = useCallback((image) => {
    if (pdfExportBusyRef.current || shareBusyRef.current) return;
    if (selectionStore.getSnapshot().size > 0) {
      toggleSelection(image);
    } else {
      openImage(image);
    }
  }, [openImage, selectionStore, toggleSelection]);

  const handleTileLongPress = useCallback((image, event) => {
    if (gestureCallbacksRef.current.disabled || pdfExportBusyRef.current) return;
    const imageId = getAssetKey(image);
    const armed = dragSelection.armFromLongPress(imageId);
    // Accessibility can select a tile without a touch-driven drag.
    if (!armed && getGalleryGesturePoint(event)) return;
    const current = selectionStore.getSnapshot();
    if (!current.has(imageId)) {
      setSelectedImageIds(new Set([...current, imageId]));
    }
  }, [dragSelection, selectionStore, setSelectedImageIds]);

  const selectAllImages = useCallback(async () => {
    if (loadingRef.current || isDeleting || pdfExportBusyRef.current || shareBusyRef.current) return;
    dragSelection.cancel();

    const initialSelection = selectionStore.getSnapshot();
    while (hasMoreRef.current) {
      const previousOffset = paginationOffsetRef.current;
      const loaded = await loadSavedImages(false);
      // Closing or changing selection cancels an unfinished Select all.
      if (selectionStore.getSnapshot() !== initialSelection) return;
      if (!loaded || (hasMoreRef.current && paginationOffsetRef.current <= previousOffset)) return;
    }

    if (selectionStore.getSnapshot() === initialSelection) {
      setSelectedImageIds(new Set(assetsRef.current.map(getAssetKey)));
    }
  }, [dragSelection, isDeleting, loadSavedImages, selectionStore, setSelectedImageIds]);

  const toggleSelectAll = useCallback(() => {
    const selected = selectionStore.getSnapshot();
    const images = assetsRef.current;
    const allSelected = images.length > 0 && !hasMoreRef.current &&
      selected.size === images.length && images.every((image) => selected.has(getAssetKey(image)));
    if (allSelected) {
      clearSelection();
    } else {
      void selectAllImages();
    }
  }, [clearSelection, selectAllImages, selectionStore]);

  const getSelectedImages = () => {
    const selected = selectionStore.getSnapshot();
    return assetsRef.current.filter((image) => selected.has(getAssetKey(image)));
  };

  const deleteImages = async (images) => {
    if (!images.length || isDeleting || pdfExportBusyRef.current || shareBusyRef.current) return false;
    dragSelection.cancel();

    setIsDeleting(true);
    setActionError(null);

    try {
      if (!mediaLibraryModule?.Asset?.delete || !mediaLibraryModule?.Asset) {
        throw new Error('The media-library delete API is unavailable in this build.');
      }

      let permission = permissionRef.current ?? mediaPermissionRef.current;
      if (!permission?.granted) {
        permission = await requestMediaPermission?.();
        permissionRef.current = permission;
        mediaPermissionRef.current = permission;
      }

      if (!permission?.granted) {
        throw new Error('Photo-library permission is required to delete snippets.');
      }

      const assetsToDelete = images.map((image) => new mediaLibraryModule.Asset(image.id));
      await mediaLibraryModule.Asset.delete(assetsToDelete);

      const deletedIds = new Set(images.map(getAssetKey));
      const remainingImages = assetsRef.current.filter((image) => !deletedIds.has(getAssetKey(image)));
      assetsRef.current = remainingImages;
      paginationOffsetRef.current = Math.max(0, paginationOffsetRef.current - images.length);
      setSavedImages(remainingImages);
      clearSelection();
      setActionError(null);
      setLoadError(null);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      setActionError(message);
      Alert.alert('Could not delete image', message);
      return false;
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmDeleteSelectedImages = () => {
    // Keep the confirmation and its action tied to the same assets, even if
    // Select all finishes or a refresh replaces the gallery while it is open.
    const imagesToDelete = getSelectedImages();
    const selectedCount = imagesToDelete.length;
    if (!selectedCount || isDeleting || shareBusyRef.current) return;

    Alert.alert(
      'Delete snippets?',
      `This will permanently delete ${selectedCount} ${selectedCount === 1 ? 'image' : 'images'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteImages(imagesToDelete) },
      ]
    );
  };

  const performShare = async (images) => {
    if (!images.length || isDeleting || pdfExportBusyRef.current || shareBusyRef.current) return;
    shareBusyRef.current = true;
    const request = ++shareRequestRef.current;
    const isCancelled = () => !pdfExportMountedRef.current || request !== shareRequestRef.current;
    dragSelection.cancel();
    setIsSharing(true);
    setActionError(null);

    try {
      await shareImagesAsync(images, {
        isCancelled,
        onHandoff: () => { imageShareSheetOpenRef.current = true; },
      });
    } catch (error) {
      if (!isCancelled() && error.name !== 'AbortError') {
        const message = getErrorMessage(error);
        setActionError(message);
        Alert.alert('Could not share images', message);
      }
    } finally {
      imageShareSheetOpenRef.current = false;
      shareBusyRef.current = false;
      if (pdfExportMountedRef.current) setIsSharing(false);
    }
  };

  const shareSelectedImages = async () => {
    if (loadingRef.current) return;
    await performShare(getSelectedImages());
  };

  const saveSelectedImagesAsPdf = async () => {
    const images = getSelectedImages();
    if (!images.length || isDeleting || loadingRef.current || pdfExportBusyRef.current || shareBusyRef.current) return;
    if (Platform.OS === 'web') {
      Alert.alert('Save as PDF', 'PDF export is available in the Android and iOS app.');
      return;
    }

    pdfExportBusyRef.current = true;
    const request = ++pdfExportRequestRef.current;
    const isCancelled = () => !pdfExportMountedRef.current || request !== pdfExportRequestRef.current;
    dragSelection.cancel();
    setPdfProgress({ completed: 0, total: images.length });
    let document;
    let handedToSystem = false;

    try {
      if (!await Sharing.isAvailableAsync()) {
        throw new Error('Saving PDF files is not available on this device.');
      }
      if (isCancelled()) return;
      document = await createSnippetsPdfAsync(images, {
        isCancelled,
        onProgress: (progress) => {
          if (!isCancelled()) setPdfProgress(progress);
        },
      });
      if (isCancelled()) return;
      pdfShareSheetOpenRef.current = true;
      handedToSystem = true;
      await Sharing.shareAsync(document.uri, {
        dialogTitle: 'Save PDF',
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
      });
      // Retain the cache file: a receiving app may read it after the sheet closes.
    } catch (error) {
      if (!isCancelled() && error.name !== 'AbortError') {
        const message = getErrorMessage(error);
        setActionError(message);
        Alert.alert('Could not create PDF', message);
      }
    } finally {
      pdfShareSheetOpenRef.current = false;
      if (document && !handedToSystem) {
        try { await document.remove(); } catch {}
      }
      pdfExportBusyRef.current = false;
      if (pdfExportMountedRef.current) setPdfProgress(null);
    }
  };

  const confirmDeleteOpenedImage = () => {
    if (!openedImage || isDeleting || shareBusyRef.current) return;

    Alert.alert(
      'Delete snippet?',
      'This will permanently delete this image.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const deleted = await deleteImages([openedImage]);
            if (deleted) closeOpenedImage();
          },
        },
      ]
    );
  };

  const shareOpenedImage = async () => {
    if (!openedImage) return;
    await performShare([openedImage]);
  };

  const renderSnippetRow = useCallback(
    ({ item }) => (
      <View style={styles.galleryRow}>
        {Array.from({ length: GALLERY_COLUMNS }, (_, column) => {
          const image = item.images[column];
          return image ? (
            <SnippetTile
              key={getAssetKey(image)}
              item={image}
              selectionStore={selectionStore}
              onLongPress={handleTileLongPress}
              onPress={handleTilePress}
            />
          ) : (
            <View key={`empty-${column}`} style={styles.galleryPlaceholder} pointerEvents="none" />
          );
        })}
      </View>
    ),
    [handleTileLongPress, handleTilePress, selectionStore]
  );

  if (openedImage) {
    return (
      <OpenedImageView
        image={openedImage}
        images={savedImages}
        disabled={isDeleting || isSharing}
        onBack={closeOpenedImage}
        onDelete={confirmDeleteOpenedImage}
        onNavigate={navigateOpenedImage}
        onShare={shareOpenedImage}
        error={actionError}
      />
    );
  }

  // Keep bottom padding stable while selection controls change.
  const bottomInset = safeAreaInsets.bottom + 112;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <GalleryHeader
          selectionStore={selectionStore}
          images={savedImages}
          hasMoreImages={hasMoreImages}
          isLoading={isLoading || isSharing || Boolean(pdfProgress)}
          onClose={clearSelection}
          onToggleSelectAll={toggleSelectAll}
          textColor={theme.text}
        />
        <View
          ref={galleryViewportRef}
          collapsable={false}
          onLayout={measureGalleryViewport}
          onTouchEnd={() => dragSelection.endTouch()}
          onTouchCancel={() => dragSelection.cancel()}
          style={styles.galleryViewport}
          {...gallerySwipeResponder.panHandlers}>
          <GalleryDragContext.Provider value={dragSelection}>
            <SectionList
              ref={galleryListRef}
              CellRendererComponent={GalleryCellRenderer}
              scrollEnabled={!isDragSelecting}
              scrollEventThrottle={16}
              onScrollBeginDrag={() => dragSelection.cancel({ preserveRange: true })}
              onMomentumScrollBegin={() => dragSelection.cancel({ preserveRange: true })}
              onScroll={(event) => dragSelection.setScrollOffset(event.nativeEvent.contentOffset.y)}
              onContentSizeChange={(_, height) => dragSelection.setContentHeight(height)}
              sections={dateSections}
              keyExtractor={(item) => item.key}
              stickySectionHeadersEnabled={false}
              initialNumToRender={6}
              maxToRenderPerBatch={4}
              windowSize={5}
              updateCellsBatchingPeriod={50}
              removeClippedSubviews={Platform.OS === 'android'}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: bottomInset },
                savedImages.length === 0 && styles.emptyListContent,
              ]}
              renderItem={renderSnippetRow}
              renderSectionHeader={({ section }) => (
                <View style={styles.dateSectionHeader}>
                  <ThemedText type="defaultSemiBold" style={styles.dateSectionTitle} accessibilityRole="header">
                    {section.title}
                  </ThemedText>
                </View>
              )}
              ListEmptyComponent={
                <ExploreEmptyState
                  isLoading={isLoading}
                  error={loadError}
                  onRetry={() => loadSavedImages(true)}
                  textColor={theme.text}
                />
              }
              ListFooterComponent={
                savedImages.length > 0 ? (
                  <GalleryFooter
                    isLoading={isLoading}
                    hasMore={hasMoreImages}
                    error={loadError}
                    onRetry={() => loadSavedImages(false)}
                  />
                ) : null
              }
              onEndReached={() => loadSavedImages(false)}
              onEndReachedThreshold={0.6}
              onRefresh={() => loadSavedImages(true)}
              refreshing={isLoading && savedImages.length > 0}
            />
          </GalleryDragContext.Provider>
        </View>
      </SafeAreaView>
      <GallerySelectionActions
        selectionStore={selectionStore}
        bottomInset={safeAreaInsets.bottom}
        disabled={isDeleting || isSharing || Boolean(pdfProgress)}
        shareDisabled={isLoading}
        isSharing={isSharing}
        pdfDisabled={isLoading}
        pdfProgress={pdfProgress}
        onDelete={confirmDeleteSelectedImages}
        onShare={shareSelectedImages}
        onSavePdf={saveSelectedImagesAsPdf}
        onOpenCamera={() => router.navigate('/screen')}
        backgroundColor={theme.background}
        textColor={theme.text}
      />
    </ThemedView>
  );
}

// Forward VirtualizedList's own layout/focus events as well as caching grid geometry.
const GalleryCellRenderer = memo(function GalleryCellRenderer({
  cellKey, item, style, onLayout, onFocusCapture, children,
}) {
  const dragSelection = useContext(GalleryDragContext);
  const layoutRef = useRef(null);
  const rowKey = item?.images ? cellKey : null;

  useLayoutEffect(() => {
    if (rowKey && layoutRef.current) {
      dragSelection.setRowLayout(rowKey, layoutRef.current, item.images.map(getAssetKey));
    }
    return () => { if (rowKey) dragSelection.removeRow(rowKey); };
  }, [dragSelection, item, rowKey]);

  const handleLayout = useCallback((event) => {
    onLayout?.(event);
    layoutRef.current = event.nativeEvent.layout;
    if (rowKey) {
      dragSelection.setRowLayout(rowKey, layoutRef.current, item.images.map(getAssetKey));
    }
  }, [dragSelection, item, onLayout, rowKey]);

  return (
    <View
      collapsable={false}
      onLayout={handleLayout}
      onFocusCapture={onFocusCapture}
      style={style}>
      {children}
    </View>
  );
});

// Only controls and tiles whose selected value changed subscribe to selection.
// Gallery rows, image decoding, and the navigation root stay out of this update.
function createSnippetSelectionStore() {
  let selectedImageIds = new Set();
  const listeners = new Set();
  const imageListeners = new Map();

  return {
    getSnapshot: () => selectedImageIds,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeImage(imageId, listener) {
      let subscribers = imageListeners.get(imageId);
      if (!subscribers) {
        subscribers = new Set();
        imageListeners.set(imageId, subscribers);
      }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) imageListeners.delete(imageId);
      };
    },
    setSelectedImageIds(update) {
      const next = typeof update === 'function' ? update(selectedImageIds) : update;
      if (next === selectedImageIds || (
        next.size === selectedImageIds.size && [...next].every((id) => selectedImageIds.has(id))
      )) return;

      const previous = selectedImageIds;
      selectedImageIds = next;
      const notifyImage = (id) => {
        const subscribers = imageListeners.get(id);
        if (subscribers) [...subscribers].forEach((listener) => listener());
      };
      previous.forEach((id) => { if (!next.has(id)) notifyImage(id); });
      next.forEach((id) => { if (!previous.has(id)) notifyImage(id); });
      [...listeners].forEach((listener) => listener());
    },
  };
}

const GalleryHeader = memo(function GalleryHeader({
  selectionStore, images, hasMoreImages, isLoading, onClose, onToggleSelectAll, textColor,
}) {
  const selected = useSyncExternalStore(
    selectionStore.subscribe, selectionStore.getSnapshot, selectionStore.getSnapshot
  );
  const isSelectionMode = selected.size > 0;
  const allSelected = images.length > 0 && !hasMoreImages &&
    selected.size === images.length && images.every((image) => selected.has(getAssetKey(image)));

  return (
    <View style={styles.galleryHeader}>
      {/* The title always determines the shared header height, including font scaling. */}
      <View
        pointerEvents={isSelectionMode ? 'none' : 'auto'}
        accessibilityElementsHidden={isSelectionMode}
        importantForAccessibility={isSelectionMode ? 'no-hide-descendants' : 'auto'}
        style={isSelectionMode && styles.inactiveHeaderLayer}>
        <GalleryTitleHeader />
      </View>
      <View
        pointerEvents={isSelectionMode ? 'auto' : 'none'}
        accessibilityElementsHidden={!isSelectionMode}
        importantForAccessibility={isSelectionMode ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.selectionHeaderLayer,
          !isSelectionMode && styles.inactiveHeaderLayer,
        ]}>
        <SelectionHeader
          selectedCount={selected.size}
          allSelected={allSelected}
          onClose={onClose}
          onToggleSelectAll={onToggleSelectAll}
          isLoading={isLoading}
          textColor={textColor}
        />
      </View>
    </View>
  );
});

const GalleryTitleHeader = memo(function GalleryTitleHeader() {
  return (
    <View style={styles.header}>
      <ThemedText type="title">Snippets</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.subtitle}>
        Your saved snippets
      </ThemedText>
    </View>
  );
});

const GallerySelectionActions = memo(function GallerySelectionActions({
  selectionStore, bottomInset, disabled, pdfDisabled, pdfProgress, shareDisabled, isSharing,
  onDelete, onShare, onSavePdf, onOpenCamera, backgroundColor, textColor,
}) {
  const selected = useSyncExternalStore(
    selectionStore.subscribe, selectionStore.getSnapshot, selectionStore.getSnapshot
  );
  if (selected.size > 0) {
    return (
      <SelectionActionBar
        bottomInset={bottomInset}
        disabled={disabled}
        shareDisabled={shareDisabled}
        isSharing={isSharing}
        pdfDisabled={pdfDisabled}
        pdfProgress={pdfProgress}
        onDelete={onDelete}
        onShare={onShare}
        onSavePdf={onSavePdf}
        backgroundColor={backgroundColor}
        textColor={textColor}
      />
    );
  }

  return (
    <Pressable
      accessibilityLabel="Open camera"
      accessibilityRole="button"
      onPress={onOpenCamera}
      style={({ pressed }) => [styles.cameraFab, pressed && styles.pressed]}>
      <SymbolView
        name={{ ios: 'camera.fill', android: 'photo_camera', web: 'photo_camera' }}
        size={28}
        tintColor={backgroundColor}
      />
    </Pressable>
  );
});

const SnippetThumbnail = memo(function SnippetThumbnail({ item }) {
  return (
    <Image
      accessibilityLabel={item.fileName || 'Snippet'}
      contentFit="cover"
      priority="low"
      recyclingKey={item.id || item.uri}
      source={item.uri}
      style={styles.galleryImage}
      transition={0}
    />
  );
});

const SnippetTile = memo(function SnippetTile({
  item, selectionStore, onLongPress, onPress,
}) {
  const imageId = getAssetKey(item);
  const subscribe = useCallback(
    (listener) => selectionStore.subscribeImage(imageId, listener),
    [imageId, selectionStore]
  );
  const getSnapshot = useCallback(
    () => selectionStore.getSnapshot().has(imageId),
    [imageId, selectionStore]
  );
  const isSelected = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <Pressable
      accessibilityLabel={item.fileName || 'Snippet'}
      accessibilityHint="Tap to open or toggle selection. Hold still, then drag to select a range. Swipe normally to scroll."
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityActions={[
        { name: 'select', label: isSelected ? 'Deselect image' : 'Select image' },
      ]}
      onAccessibilityAction={({ nativeEvent: { actionName } }) => {
        if (actionName === 'select') {
          if (isSelected) onPress(item);
          else onLongPress(item);
        }
      }}
      delayLongPress={200}
      onLongPress={(event) => onLongPress(item, event)}
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.galleryTile, pressed && styles.pressed]}>
      <SnippetThumbnail item={item} />
      {isSelected && (
        <View pointerEvents="none" style={styles.selectionCheckmark}>
          <View style={styles.selectionTick} />
        </View>
      )}
    </Pressable>
  );
});

function OpenedImageView({
  image,
  images = [],
  disabled,
  onBack,
  onDelete,
  onNavigate,
  onShare,
  error,
}) {
  const zoomScale = useRef(new Animated.Value(1)).current;
  const panTranslateX = useRef(new Animated.Value(0)).current;
  const panTranslateY = useRef(new Animated.Value(0)).current;
  const swipeTranslateX = useRef(new Animated.Value(0)).current;
  const zoomScaleRef = useRef(1);
  const panTranslateRef = useRef({ x: 0, y: 0 });
  const panStartTranslateRef = useRef({ x: 0, y: 0 });
  const panStartCenterRef = useRef({ x: 0, y: 0 });
  const pinchStartDistanceRef = useRef(null);
  const pinchStartScaleRef = useRef(1);
  const activeTouchCountRef = useRef(0);
  const swipeCandidateRef = useRef(false);
  const swipeAnimatingRef = useRef(false);
  const swipePreviewImageRef = useRef(null);
  const swipePreviewDirectionRef = useRef(0);
  const pendingSwipeTargetRef = useRef(null);
  const swipeResetCompleteRef = useRef(false);
  const displayedImageLoadedRef = useRef(false);
  const disabledRef = useRef(disabled);
  const imageRef = useRef(image);
  const imagesRef = useRef(images);
  const onNavigateRef = useRef(onNavigate);
  const imageFrameSizeRef = useRef({ width: 0, height: 0 });
  const [imageFrameSize, setImageFrameSize] = useState({ width: 0, height: 0 });
  const [displayedImage, setDisplayedImage] = useState(image);
  const [swipePreviewImage, setSwipePreviewImage] = useState(null);
  const [swipePreviewDirection, setSwipePreviewDirection] = useState(0);
  const [swipePreviewCentered, setSwipePreviewCentered] = useState(false);
  disabledRef.current = disabled;
  imageRef.current = displayedImage;
  imagesRef.current = images;
  onNavigateRef.current = onNavigate;
  imageFrameSizeRef.current = imageFrameSize;

  const resetZoom = useCallback(() => {
    zoomScaleRef.current = 1;
    panTranslateRef.current = { x: 0, y: 0 };
    panStartTranslateRef.current = { x: 0, y: 0 };
    panStartCenterRef.current = { x: 0, y: 0 };
    pinchStartDistanceRef.current = null;
    pinchStartScaleRef.current = 1;
    activeTouchCountRef.current = 0;
    swipeCandidateRef.current = false;
    swipePreviewImageRef.current = null;
    swipePreviewDirectionRef.current = 0;
    swipeResetCompleteRef.current = false;
    swipeTranslateX.setValue(0);
    zoomScale.setValue(1);
    panTranslateX.setValue(0);
    panTranslateY.setValue(0);
  }, [panTranslateX, panTranslateY, swipeTranslateX, zoomScale]);

  useEffect(() => {
    resetZoom();
  }, [displayedImage?.uri, resetZoom]);

  const completePendingSwipe = useCallback(() => {
    if (!pendingSwipeTargetRef.current) return;

    pendingSwipeTargetRef.current = null;
    swipeResetCompleteRef.current = false;
    swipePreviewImageRef.current = null;
    swipePreviewDirectionRef.current = 0;
    setSwipePreviewImage(null);
    setSwipePreviewDirection(0);
    setSwipePreviewCentered(false);
    swipeAnimatingRef.current = false;
  }, []);

  useEffect(() => {
    if (!swipePreviewCentered) return;

    swipeTranslateX.setValue(0);
    swipeResetCompleteRef.current = true;

    if (displayedImageLoadedRef.current) {
      completePendingSwipe();
    }
  }, [completePendingSwipe, swipePreviewCentered, swipeTranslateX]);

  const pinchPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) =>
        !disabledRef.current &&
        !swipeAnimatingRef.current &&
        (getTouchCount(event) > 0 || zoomScaleRef.current > 1),
      onStartShouldSetPanResponder: (event) =>
        !disabledRef.current &&
        !swipeAnimatingRef.current &&
        (getTouchCount(event) > 0 || zoomScaleRef.current > 1),
      onMoveShouldSetPanResponderCapture: (event) =>
        !disabledRef.current &&
        !swipeAnimatingRef.current &&
        (getTouchCount(event) > 0 || zoomScaleRef.current > 1),
      onMoveShouldSetPanResponder: (event) =>
        !disabledRef.current &&
        !swipeAnimatingRef.current &&
        (getTouchCount(event) > 0 || zoomScaleRef.current > 1),
      onPanResponderGrant: (event) => {
        const touchCount = getTouchCount(event);
        panStartTranslateRef.current = { ...panTranslateRef.current };
        panStartCenterRef.current = getTouchCenter(event);
        activeTouchCountRef.current = touchCount;
        swipeCandidateRef.current = touchCount === 1 && zoomScaleRef.current <= 1;
        swipePreviewImageRef.current = null;
        swipePreviewDirectionRef.current = 0;
        setSwipePreviewImage(null);
        setSwipePreviewDirection(0);
        setSwipePreviewCentered(false);
        swipeTranslateX.stopAnimation();
        swipeTranslateX.setValue(0);

        const distance = touchCount >= 2 ? getTouchDistance(event) : 0;
        if (distance <= 0) return;

        pinchStartDistanceRef.current = distance;
        pinchStartScaleRef.current = zoomScaleRef.current;
      },
      onPanResponderMove: (event, gestureState) => {
        const previousTouchCount = activeTouchCountRef.current;
        const touchCount = getTouchCount(event);
        const distance = getTouchDistance(event);
        const currentCenter = getTouchCenter(event);

        if (touchCount >= 2) {
          swipeCandidateRef.current = false;
        }

        if (swipeCandidateRef.current && touchCount === 1 && zoomScaleRef.current <= 1) {
          const horizontalDistance = gestureState?.dx ?? 0;
          const verticalDistance = gestureState?.dy ?? 0;
          const isHorizontal = Math.abs(horizontalDistance) > Math.abs(verticalDistance) * 1.1;
          const direction = horizontalDistance < 0 ? -1 : 1;
          const targetImage = getAdjacentImage(imagesRef.current, imageRef.current, direction);
          const resistance = targetImage ? 1 : 0.25;

          if (isHorizontal && targetImage) {
            if (swipePreviewImageRef.current !== targetImage) {
              swipePreviewImageRef.current = targetImage;
              setSwipePreviewImage(targetImage);
            }
            if (swipePreviewDirectionRef.current !== direction) {
              swipePreviewDirectionRef.current = direction;
              setSwipePreviewDirection(direction);
            }
          } else if (swipePreviewImageRef.current) {
            swipePreviewImageRef.current = null;
            swipePreviewDirectionRef.current = 0;
            setSwipePreviewImage(null);
            setSwipePreviewDirection(0);
          }

          swipeTranslateX.setValue(isHorizontal ? horizontalDistance * resistance : 0);
          activeTouchCountRef.current = touchCount;
          return;
        }

        if (touchCount >= 2 && distance > 0 && previousTouchCount < 2) {
          pinchStartDistanceRef.current = distance;
          pinchStartScaleRef.current = zoomScaleRef.current;
          panStartTranslateRef.current = { ...panTranslateRef.current };
          panStartCenterRef.current = currentCenter;
        } else if (previousTouchCount >= 2 && touchCount === 1) {
          pinchStartDistanceRef.current = null;
          panStartTranslateRef.current = { ...panTranslateRef.current };
          panStartCenterRef.current = currentCenter;
        }

        activeTouchCountRef.current = touchCount;

        const startDistance = pinchStartDistanceRef.current;
        const nextScale = startDistance && distance > 0
          ? clamp(pinchStartScaleRef.current * (distance / startDistance), 1, 4)
          : zoomScaleRef.current;

        if (startDistance && distance > 0) {
          zoomScaleRef.current = nextScale;
          zoomScale.setValue(nextScale);
        }

        if (nextScale <= 1 || touchCount < 1) {
          if (nextScale <= 1) {
            panTranslateRef.current = { x: 0, y: 0 };
            panTranslateX.setValue(0);
            panTranslateY.setValue(0);
          }
          return;
        }

        // Keep the first zoom centered. Once the image is already zoomed,
        // subsequent pinch-center movement can pan it naturally.
        if (startDistance && pinchStartScaleRef.current <= 1) {
          panTranslateRef.current = { x: 0, y: 0 };
          panTranslateX.setValue(0);
          panTranslateY.setValue(0);
          return;
        }

        const deltaX = currentCenter.x - panStartCenterRef.current.x;
        const deltaY = currentCenter.y - panStartCenterRef.current.y;
        const nextTranslation = clampPanTranslation(
          panStartTranslateRef.current.x + deltaX,
          panStartTranslateRef.current.y + deltaY,
          nextScale,
          imageFrameSizeRef.current,
          imageRef.current
        );
        panTranslateRef.current = nextTranslation;
        panTranslateX.setValue(nextTranslation.x);
        panTranslateY.setValue(nextTranslation.y);
      },
      onPanResponderRelease: (event, gestureState) => {
        const horizontalDistance = gestureState?.dx ?? 0;
        const verticalDistance = gestureState?.dy ?? 0;
        const isHorizontal = Math.abs(horizontalDistance) > Math.abs(verticalDistance) * 1.1;
        const swipeWidth = Math.max(imageFrameSizeRef.current.width, 1);
        const direction = horizontalDistance < 0 ? -1 : 1;
        const targetImage = swipeCandidateRef.current && isHorizontal
          ? swipePreviewImageRef.current ?? getAdjacentImage(imagesRef.current, imageRef.current, direction)
          : null;
        const triggerDistance = Math.min(96, swipeWidth * 0.24);
        const shouldNavigate =
          targetImage &&
          Math.abs(horizontalDistance) >= triggerDistance &&
          zoomScaleRef.current <= 1;

        if (shouldNavigate && !swipeAnimatingRef.current) {
          swipeAnimatingRef.current = true;
          Animated.timing(swipeTranslateX, {
            toValue: swipeWidth * direction,
            duration: 125,
            useNativeDriver: true,
          }).start(({ finished }) => {
            if (!finished) {
              swipeAnimatingRef.current = false;
              swipeTranslateX.setValue(0);
              swipePreviewImageRef.current = null;
              swipePreviewDirectionRef.current = 0;
              setSwipePreviewImage(null);
              setSwipePreviewDirection(0);
              setSwipePreviewCentered(false);
              return;
            }

            pendingSwipeTargetRef.current = targetImage;
            displayedImageLoadedRef.current = false;
            swipeResetCompleteRef.current = false;
            swipePreviewImageRef.current = targetImage;
            swipePreviewDirectionRef.current = direction;
            setDisplayedImage(targetImage);
            setSwipePreviewImage(targetImage);
            setSwipePreviewDirection(direction);
            setSwipePreviewCentered(true);
            onNavigateRef.current?.(targetImage);
          });
        } else {
          Animated.spring(swipeTranslateX, {
            toValue: 0,
            speed: 20,
            bounciness: 6,
            useNativeDriver: true,
          }).start(() => {
            swipePreviewImageRef.current = null;
            swipePreviewDirectionRef.current = 0;
            setSwipePreviewImage(null);
            setSwipePreviewDirection(0);
            setSwipePreviewCentered(false);
          });
        }

        pinchStartDistanceRef.current = null;
        activeTouchCountRef.current = 0;
        swipeCandidateRef.current = false;
      },
      onPanResponderTerminate: () => {
        pinchStartDistanceRef.current = null;
        activeTouchCountRef.current = 0;
        swipeCandidateRef.current = false;
        Animated.spring(swipeTranslateX, {
          toValue: 0,
          speed: 20,
          bounciness: 6,
          useNativeDriver: true,
        }).start(() => {
          swipePreviewImageRef.current = null;
          swipePreviewDirectionRef.current = 0;
          setSwipePreviewImage(null);
          setSwipePreviewDirection(0);
          setSwipePreviewCentered(false);
        });
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  const swipeWidth = Math.max(imageFrameSize.width, 1);
  const swipePreviewOffset = swipePreviewCentered
    ? 0
    : swipePreviewDirection < 0
      ? Animated.add(swipeTranslateX, swipeWidth)
      : Animated.add(swipeTranslateX, -swipeWidth);

  return (
    <ThemedView style={styles.openedImageContainer}>
      <SafeAreaView style={styles.openedImageSafeArea}>
        <View style={styles.openedImageHeader}>
          <Pressable
            accessibilityLabel="Back to Explore"
            accessibilityRole="button"
            onPress={onBack}
            style={({ pressed }) => [styles.viewerBackButton, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
              size={24}
              tintColor={Colors.light.background}
            />
          </Pressable>
        </View>

        <View
          style={styles.openedImageFrame}
          onLayout={({ nativeEvent }) => {
            const { width, height } = nativeEvent.layout;
            setImageFrameSize({ width, height });
          }}
          {...pinchPanResponder.panHandlers}>
          <View style={styles.openedImageSwipeViewport}>
            {swipePreviewImage ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.openedImageSlide,
                  styles.openedImageSwipePreview,
                  { transform: [{ translateX: swipePreviewOffset }] },
                ]}>
                <Image
                  key={getAssetKey(swipePreviewImage)}
                  accessibilityLabel={swipePreviewImage.fileName || 'Adjacent opened snippet'}
                  contentFit="contain"
                  recyclingKey={getAssetKey(swipePreviewImage)}
                  source={swipePreviewImage.uri}
                  style={styles.openedImage}
                  transition={0}
                />
              </Animated.View>
            ) : null}

            <Animated.View
              pointerEvents="none"
              style={[styles.openedImageSlide, { transform: [{ translateX: swipeTranslateX }] }]}> 
              <Animated.View
                style={[
                  styles.openedImagePanLayer,
                  { transform: [{ translateX: panTranslateX }, { translateY: panTranslateY }] },
                ]}>
                <Animated.View
                  style={[styles.openedImageZoomLayer, { transform: [{ scale: zoomScale }] }]}> 
                  <Image
                    key={getAssetKey(displayedImage)}
                    accessibilityLabel={displayedImage.fileName || 'Opened snippet'}
                    contentFit="contain"
                    onLoad={() => {
                      displayedImageLoadedRef.current = true;
                      if (swipeResetCompleteRef.current) {
                        completePendingSwipe();
                      }
                    }}
                    recyclingKey={getAssetKey(displayedImage)}
                    source={displayedImage.uri}
                    style={styles.openedImage}
                    transition={0}
                  />
                </Animated.View>
              </Animated.View>
            </Animated.View>
          </View>
        </View>

        <View style={styles.openedImageActions}>
          <Pressable
            accessibilityLabel="Delete opened image"
            accessibilityRole="button"
            disabled={disabled}
            onPress={onDelete}
            style={({ pressed }) => [
              styles.openedImageAction,
              styles.horizontalAction,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'trash.fill', android: 'delete', web: 'delete' }}
              size={27}
              tintColor="#d92d20"
            />
            <ThemedText type="smallBold" style={styles.deleteActionText}>
              Delete
            </ThemedText>
          </Pressable>

          <Pressable
            accessibilityLabel="Share opened image"
            accessibilityRole="button"
            disabled={disabled}
            onPress={onShare}
            style={({ pressed }) => [
              styles.openedImageAction,
              styles.horizontalAction,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}>
            <SymbolView
              name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
              size={27}
              tintColor={Colors.light.background}
            />
            <ThemedText type="smallBold" style={styles.openedImageActionText}>
              Share
            </ThemedText>
          </Pressable>
        </View>
        {error ? (
          <ThemedText style={styles.openedImageError}>
            {error}
          </ThemedText>
        ) : null}
      </SafeAreaView>
    </ThemedView>
  );
}

function getTouchCount(event) {
  return event?.nativeEvent?.touches?.length ?? 0;
}

function getTouchCenter(event) {
  const touches = event?.nativeEvent?.touches ?? [];
  if (!touches.length) return { x: 0, y: 0 };

  const points = touches.slice(0, 2).map((touch) => ({
    x: touch.pageX ?? touch.locationX ?? 0,
    y: touch.pageY ?? touch.locationY ?? 0,
  }));
  const total = points.reduce(
    (center, point) => ({ x: center.x + point.x, y: center.y + point.y }),
    { x: 0, y: 0 }
  );

  return {
    x: total.x / points.length,
    y: total.y / points.length,
  };
}

function getTouchDistance(event) {
  const touches = event?.nativeEvent?.touches ?? [];
  if (touches.length < 2) return 0;

  const [first, second] = touches;
  const firstX = first.pageX ?? first.locationX ?? 0;
  const firstY = first.pageY ?? first.locationY ?? 0;
  const secondX = second.pageX ?? second.locationX ?? 0;
  const secondY = second.pageY ?? second.locationY ?? 0;
  const deltaX = secondX - firstX;
  const deltaY = secondY - firstY;
  return Math.sqrt(deltaX ** 2 + deltaY ** 2);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampPanTranslation(x, y, scale, frameSize, image) {
  if (!frameSize.width || !frameSize.height) return { x, y };

  const imageSize = getContainedImageSize(frameSize, image);
  const maxX = Math.max(0, (imageSize.width * scale - frameSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - frameSize.height) / 2);

  return {
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  };
}

function getContainedImageSize(frameSize, image) {
  const imageRatio = image?.width && image?.height
    ? image.width / image.height
    : frameSize.width / frameSize.height;
  const frameRatio = frameSize.width / frameSize.height;

  if (frameRatio > imageRatio) {
    return {
      width: frameSize.height * imageRatio,
      height: frameSize.height,
    };
  }

  return {
    width: frameSize.width,
    height: frameSize.width / imageRatio,
  };
}

function SelectionHeader({
  selectedCount,
  allSelected,
  onClose,
  onToggleSelectAll,
  isLoading,
  textColor,
}) {
  return (
    <View style={styles.selectionHeader}>
      <Pressable
        accessibilityLabel="Close image selection"
        accessibilityRole="button"
        onPress={onClose}
        style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}>
        <SymbolView
          name={{ ios: 'xmark', android: 'close', web: 'close' }}
          size={22}
          tintColor={textColor}
        />
      </Pressable>
      <ThemedText type="subtitle" numberOfLines={1} style={styles.selectedCountText}>
        {selectedCount} selected
      </ThemedText>
      <Pressable
        accessibilityLabel={allSelected ? 'Unselect all images' : 'Select all images'}
        accessibilityRole="button"
        disabled={isLoading}
        onPress={onToggleSelectAll}
        style={({ pressed }) => [styles.selectAllButton, pressed && styles.pressed]}>
        <ThemedText type="smallBold" style={styles.selectAllText}>
          {allSelected ? 'Unselect all' : 'Select all'}
        </ThemedText>
      </Pressable>
    </View>
  );
}

function ExploreEmptyState({ isLoading, error, onRetry, textColor }) {
  if (isLoading) {
    return (
      <View style={styles.emptyState}>
        <ActivityIndicator color={textColor} />
        <ThemedText themeColor="textSecondary" style={styles.emptyText}>
          Loading snippets…
        </ThemedText>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.emptyState}>
        <SymbolView
          name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
          size={42}
          tintColor="#b9b9b9"
        />
        <ThemedText themeColor="textSecondary" style={styles.emptyText}>
          {error}
        </ThemedText>
        <Pressable
          accessibilityLabel="Retry loading snippets"
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
          <ThemedText type="smallBold" style={styles.retryButtonText}>
            Retry
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.emptyState}>
      <SymbolView
        name={{ ios: 'photo.on.rectangle.angled', android: 'photo_library', web: 'photo_library' }}
        size={48}
        tintColor="#b9b9b9"
      />
      <ThemedText themeColor="textSecondary" style={styles.emptyText}>
        No snippets yet.
      </ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.emptyHint}>
        Images you save from the camera will appear here.
      </ThemedText>
    </View>
  );
}

function GalleryFooter({ isLoading, hasMore, error, onRetry }) {
  if (isLoading) {
    return (
      <View style={styles.footerState}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.footerState}>
        <ThemedText themeColor="textSecondary" style={styles.footerText}>
          Could not load more snippets.
        </ThemedText>
        <Pressable
          accessibilityLabel="Retry loading more snippets"
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
          <ThemedText type="smallBold" style={styles.retryButtonText}>
            Retry
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  if (!hasMore) {
    return (
      <View style={styles.footerState}>
        <ThemedText themeColor="textSecondary" style={styles.footerText}>
          All snippets are shown.
        </ThemedText>
      </View>
    );
  }

  return null;
}

async function querySavedImagePage(album, offset, limit) {
  const assets = await new mediaLibraryModule.Query()
    .album(album)
    .eq(mediaLibraryModule.AssetField.MEDIA_TYPE, mediaLibraryModule.MediaType.IMAGE)
    .limit(limit)
    .offset(offset)
    .orderBy({
      key: mediaLibraryModule.AssetField.CREATION_TIME ?? mediaLibraryModule.AssetField.MODIFICATION_TIME,
      ascending: false,
    })
    .exe();

  return assets ?? [];
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return 'Unable to load snippets.';
}

function getAssetKey(asset) {
  return asset.id || asset.uri;
}

function getAdjacentImage(images, image, direction) {
  const imageIndex = images.findIndex((candidate) => getAssetKey(candidate) === getAssetKey(image));
  if (imageIndex < 0) return null;

  const adjacentIndex = imageIndex + (direction < 0 ? 1 : -1);
  return images[adjacentIndex] ?? null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  galleryHeader: {
    paddingHorizontal: Spacing.three,
    minHeight: 72,
    flexShrink: 0,
  },
  selectionHeaderLayer: {
    position: 'absolute',
    top: 0,
    left: Spacing.three,
    right: Spacing.three,
  },
  inactiveHeaderLayer: {
    opacity: 0,
  },
  galleryViewport: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.three,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  header: {
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
  },
  selectionTick: {
    width: 6,
    height: 11,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: Colors.light.background,
    marginTop: -2,
    transform: [{ rotate: '45deg' }],
  },
  openedImageContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  openedImageSafeArea: {
    flex: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  openedImageHeader: {
    minHeight: 48,
    justifyContent: 'center',
  },
  viewerBackButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  openedImageFrame: {
    flex: 1,
    minHeight: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: Spacing.two,
    borderRadius: Spacing.two,
    backgroundColor: '#111111',
    overflow: 'hidden',
  },
  openedImageSwipeViewport: {
    flex: 1,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
  },
  openedImageSlide: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openedImageSwipePreview: {
    zIndex: 2,
  },
  openedImage: {
    width: '100%',
    height: '100%',
  },
  openedImagePanLayer: {
    width: '100%',
    height: '100%',
  },
  openedImageZoomLayer: {
    width: '100%',
    height: '100%',
  },
  openedImageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingTop: Spacing.two,
  },
  openedImageAction: {
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
  },
  horizontalAction: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  openedImageActionText: {
    color: Colors.light.background,
  },
  openedImageError: {
    marginTop: Spacing.two,
    color: '#ffb4ab',
    textAlign: 'center',
  },
  selectionHeader: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    gap: Spacing.two,
  },
  headerIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  selectedCountText: {
    flex: 1,
  },
  selectAllButton: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
  },
  selectAllText: {
    color: '#3c87f7',
  },
  subtitle: {
    fontSize: 15,
  },
  dateSectionHeader: {
    paddingHorizontal: Spacing.one,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  dateSectionTitle: {
    fontSize: 18,
    lineHeight: 24,
  },
  galleryPlaceholder: {
    flex: 1,
    aspectRatio: 1,
  },
  galleryRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: Spacing.one,
    marginBottom: Spacing.one,
  },
  cameraFab: {
    position: 'absolute',
    right: Spacing.three,
    bottom: Spacing.three,
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 32,
    backgroundColor: '#3c87f7',
    zIndex: 30,
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
  },
  galleryTile: {
    flex: 1,
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: Spacing.two,
    backgroundColor: Colors.light.backgroundElement,
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  selectionCheckmark: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#3c87f7',
    borderWidth: 2,
    borderColor: Colors.light.background,
  },
  deleteActionText: {
    color: '#d92d20',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.six,
  },
  emptyText: {
    textAlign: 'center',
  },
  emptyHint: {
    textAlign: 'center',
    maxWidth: 280,
  },
  retryButton: {
    minWidth: 96,
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    backgroundColor: '#3c87f7',
  },
  retryButtonText: {
    color: Colors.light.background,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.45,
  },
  footerState: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  footerText: {
    textAlign: 'center',
  },
});

