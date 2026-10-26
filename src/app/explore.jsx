import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { SelectionContext } from '@/context/SelectionContext';
import { useTheme } from '@/hooks/use-theme';
import {
  appendUniqueMediaLibraryImages,
  getSnippetsAlbum,
  normalizeMediaLibraryImage,
} from '@/snippets-library';

const GALLERY_PAGE_SIZE = 36;
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
  const { selectedImageIds, setSelectedImageIds } = useContext(SelectionContext);
  const loadingRef = useRef(false);
  const assetsRef = useRef([]);
  const hasMoreRef = useRef(true);
  const permissionRef = useRef(null);
  const mediaPermissionRef = useRef(null);
  const suppressedPressKeyRef = useRef(null);
  const openedImageRef = useRef(null);
  const [mediaPermission, requestMediaPermission] = useMediaPermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const [savedImages, setSavedImages] = useState([]);
  const [hasMoreImages, setHasMoreImages] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openedImage, setOpenedImage] = useState(null);
  const isSelectionMode = selectedImageIds.size > 0;
  const isSelectionModeRef = useRef(isSelectionMode);
  isSelectionModeRef.current = isSelectionMode;
  const allImagesSelected =
    savedImages.length > 0 &&
    !hasMoreImages &&
    savedImages.every((image) => selectedImageIds.has(getAssetKey(image)));

  useEffect(() => {
    mediaPermissionRef.current = mediaPermission;
  }, [mediaPermission]);

  useEffect(() => {
    openedImageRef.current = openedImage;
  }, [openedImage]);

  const closeOpenedImage = useCallback(() => {
    openedImageRef.current = null;
    setActionError(null);
    setOpenedImage(null);
  }, []);

  const loadSavedImages = useCallback(async (reset = false) => {
    if (loadingRef.current || (!reset && !hasMoreRef.current)) return;

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
        permission = await requestMediaPermission?.();
        permissionRef.current = permission;
      }

      if (!permission?.granted) {
        throw new Error('Photo-library permission was not granted.');
      }

      const snippetsAlbum = await getSnippetsAlbum(mediaLibraryModule);
      if (!snippetsAlbum) {
        assetsRef.current = [];
        hasMoreRef.current = false;
        setSavedImages([]);
        setHasMoreImages(false);
        setLoadError(null);
        return;
      }

      const offset = reset ? 0 : assetsRef.current.length;
      const assets = await querySavedImagePage(snippetsAlbum, offset, GALLERY_PAGE_SIZE);
      const normalizedAssets = await Promise.all(assets.map(normalizeMediaLibraryImage));
      const usableAssets = normalizedAssets.filter((asset) => asset?.uri);
      const nextImages = reset
        ? appendUniqueMediaLibraryImages([], usableAssets)
        : appendUniqueMediaLibraryImages(assetsRef.current, usableAssets);
      const nextHasMore = usableAssets.length === GALLERY_PAGE_SIZE;

      assetsRef.current = nextImages;
      hasMoreRef.current = nextHasMore;
      setSavedImages(nextImages);
      setHasMoreImages(nextHasMore);
      setLoadError(null);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [requestMediaPermission]);

  useFocusEffect(
    useCallback(() => {
      loadSavedImages(true);

      return () => {
        suppressedPressKeyRef.current = null;
      };
    }, [loadSavedImages])
  );

  useFocusEffect(
    useCallback(() => {
      if (!BackHandler?.addEventListener) return undefined;

      const handleBackPress = () => {
        if (!openedImageRef.current) return false;

        closeOpenedImage();
        return true;
      };

      const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);

      return () => subscription.remove();
    }, [closeOpenedImage])
  );

  const startSelection = useCallback((image) => {
    setSelectedImageIds(new Set([getAssetKey(image)]));
  }, [setSelectedImageIds]);

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

  const clearSelection = useCallback(() => {
    setSelectedImageIds(new Set());
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
    const imageKey = getAssetKey(image);

    // React Native can dispatch an onPress after onLongPress for the same
    // tile. Ignore only that synthetic press; a tap on any other tile must
    // continue through to selection immediately.
    if (suppressedPressKeyRef.current === imageKey) {
      suppressedPressKeyRef.current = null;
      return;
    }

    suppressedPressKeyRef.current = null;

    if (isSelectionModeRef.current) {
      toggleSelection(image);
    } else {
      openImage(image);
    }
  }, [openImage, toggleSelection]);

  const handleTileLongPress = useCallback((image) => {
    if (isSelectionModeRef.current) return;

    suppressedPressKeyRef.current = getAssetKey(image);
    startSelection(image);
  }, [startSelection]);

  const selectAllImages = async () => {
    if (isLoading || isDeleting) return;

    let attempts = 0;
    while (hasMoreRef.current && attempts < 100) {
      await loadSavedImages(false);
      attempts += 1;
    }

    setSelectedImageIds(new Set(assetsRef.current.map(getAssetKey)));
  };

  const toggleSelectAll = () => {
    if (allImagesSelected) {
      clearSelection();
      return;
    }

    selectAllImages();
  };

  const getSelectedImages = () => {
    return assetsRef.current.filter((image) => selectedImageIds.has(getAssetKey(image)));
  };

  const deleteImages = async (images) => {
    if (!images.length || isDeleting) return false;

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

  const deleteSelectedImages = async () => {
    await deleteImages(getSelectedImages());
  };

  const confirmDeleteSelectedImages = () => {
    const selectedCount = selectedImageIds.size;
    if (!selectedCount || isDeleting) return;

    Alert.alert(
      'Delete snippets?',
      `This will permanently delete ${selectedCount} ${selectedCount === 1 ? 'image' : 'images'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: deleteSelectedImages },
      ]
    );
  };

  const shareSelectedImages = async () => {
    const selectedImages = getSelectedImages();
    if (!selectedImages.length || isDeleting) return;

    if (selectedImages.length > 1) {
      Alert.alert(
        'Share images',
        'The current app build can share one local image at a time. Select one image to continue.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      await shareImageFile(selectedImages[0]);
    } catch (error) {
      const message = getErrorMessage(error);
      setActionError(message);
      Alert.alert('Could not share image', message);
    }
  };

  const confirmDeleteOpenedImage = () => {
    if (!openedImage || isDeleting) return;

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
    if (!openedImage || isDeleting) return;

    try {
      await shareImageFile(openedImage);
    } catch (error) {
      const message = getErrorMessage(error);
      setActionError(message);
      Alert.alert('Could not share image', message);
    }
  };

  const renderSnippetItem = useCallback(
    ({ item }) => (
      <SnippetTile
        item={item}
        isSelected={selectedImageIds.has(getAssetKey(item))}
        isSelectionMode={isSelectionMode}
        onLongPress={handleTileLongPress}
        onPress={handleTilePress}
      />
    ),
    [handleTileLongPress, handleTilePress, isSelectionMode, selectedImageIds]
  );

  if (openedImage) {
    return (
      <OpenedImageView
        image={openedImage}
        images={savedImages}
        disabled={isDeleting}
        onBack={closeOpenedImage}
        onDelete={confirmDeleteOpenedImage}
        onNavigate={navigateOpenedImage}
        onShare={shareOpenedImage}
        error={actionError}
      />
    );
  }

  const bottomInset = safeAreaInsets.bottom + (isSelectionMode ? 96 : 112);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <FlatList
          data={savedImages}
          keyExtractor={(item) => item.id || item.uri}
          numColumns={3}
          extraData={selectedImageIds}
          initialNumToRender={12}
          maxToRenderPerBatch={9}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={Platform.OS === 'android'}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: bottomInset },
            savedImages.length === 0 && styles.emptyListContent,
          ]}
          columnWrapperStyle={styles.galleryRow}
          renderItem={renderSnippetItem}
          ListHeaderComponent={
            isSelectionMode ? (
              <SelectionHeader
                selectedCount={selectedImageIds.size}
                allSelected={allImagesSelected}
                onClose={clearSelection}
                onToggleSelectAll={toggleSelectAll}
                isLoading={isLoading}
                textColor={theme.text}
              />
            ) : (
              <View style={styles.header}>
                <ThemedText type="title">Snippets</ThemedText>
                <ThemedText themeColor="textSecondary" style={styles.subtitle}>
                  Your saved snippets
                </ThemedText>
              </View>
            )
          }
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
          refreshing={isLoading && savedImages.length > 0 && !isSelectionMode}
        />
      </SafeAreaView>
      {isSelectionMode && (
        <SelectionActionBar
          bottomInset={safeAreaInsets.bottom}
          disabled={isDeleting}
          onDelete={confirmDeleteSelectedImages}
          onShare={shareSelectedImages}
          backgroundColor={theme.background}
          textColor={theme.text}
        />
      )}
      {!isSelectionMode && (
        <Pressable
          accessibilityLabel="Open camera"
          accessibilityRole="button"
          onPress={() => router.navigate('/screen')}
          style={({ pressed }) => [styles.cameraFab, pressed && styles.pressed]}>
          <SymbolView
            name={{ ios: 'camera.fill', android: 'photo_camera', web: 'photo_camera' }}
            size={28}
            tintColor={theme.background}
          />
        </Pressable>
      )}
    </ThemedView>
  );
}

const SnippetTile = memo(function SnippetTile({
  item,
  isSelected,
  isSelectionMode,
  onLongPress,
  onPress,
}) {
  return (
    <Pressable
      accessibilityLabel={
        isSelectionMode
          ? `${isSelected ? 'Unselect' : 'Select'} ${item.fileName || 'snippet'}`
          : `Open ${item.fileName || 'snippet'}`
      }
      accessibilityRole="button"
      delayLongPress={300}
      onLongPress={() => onLongPress(item)}
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.galleryTile, pressed && styles.pressed]}>
      <Image
        accessibilityLabel={item.fileName || 'Snippet'}
        contentFit="cover"
        priority="low"
        recyclingKey={item.id || item.uri}
        source={item.uri}
        style={styles.galleryImage}
        transition={0}
      />
      {isSelected && (
        <View style={styles.selectionCheckmark}>
          <SymbolView
            name={{ ios: 'checkmark', android: 'check', web: 'check' }}
            size={16}
            tintColor={Colors.light.background}
          />
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
                  accessibilityLabel={swipePreviewImage.fileName || 'Adjacent opened snippet'}
                  contentFit="contain"
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
                    accessibilityLabel={displayedImage.fileName || 'Opened snippet'}
                    contentFit="contain"
                    onLoad={() => {
                      displayedImageLoadedRef.current = true;
                      if (swipeResetCompleteRef.current) {
                        completePendingSwipe();
                      }
                    }}
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
      <ThemedText type="subtitle" style={styles.selectedCountText}>
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

function SelectionActionBar({ bottomInset, disabled, onDelete, onShare, backgroundColor, textColor }) {
  return (
    <View
      style={[
        styles.selectionActionBar,
        { backgroundColor, paddingBottom: bottomInset + Spacing.two },
      ]}>
      <Pressable
        accessibilityLabel="Delete selected images"
        accessibilityRole="button"
        disabled={disabled}
        onPress={onDelete}
        style={({ pressed }) => [
          styles.selectionAction,
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
        accessibilityLabel="Share selected images"
        accessibilityRole="button"
        disabled={disabled}
        onPress={onShare}
        style={({ pressed }) => [
          styles.selectionAction,
          styles.horizontalAction,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}>
        <SymbolView
          name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
          size={27}
          tintColor={textColor}
        />
        <ThemedText type="smallBold">Share</ThemedText>
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
      key: mediaLibraryModule.AssetField.MODIFICATION_TIME,
      ascending: false,
    })
    .exe();

  return assets ?? [];
}

async function shareImageFile(image) {
  if (!image?.uri) {
    throw new Error('The selected snippet does not have a shareable file.');
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Image sharing is not available on this device.');
  }

  await Sharing.shareAsync(image.uri, {
    dialogTitle: 'Share image',
    mimeType: getImageMimeType(image.fileName ?? image.uri),
  });
}

function getImageMimeType(fileNameOrUri) {
  const extension = String(fileNameOrUri).split(/[?#]/)[0].split('.').pop()?.toLowerCase();

  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'heic' || extension === 'heif') return 'image/heic';
  return 'image/jpeg';
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
  galleryRow: {
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
    width: '32.4%',
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
  selectionActionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d0d0d0',
    zIndex: 20,
    elevation: 20,
  },
  selectionAction: {
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
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
