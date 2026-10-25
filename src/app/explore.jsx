import { router, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { SelectionContext } from '@/context/SelectionContext';
import { useTheme } from '@/hooks/use-theme';
import { getSnippetsAlbum } from '@/snippets-library';

const GALLERY_PAGE_SIZE = 60;
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
  const { selectedImageIds, setSelectedImageIds } = useContext(SelectionContext);
  const loadingRef = useRef(false);
  const assetsRef = useRef([]);
  const hasMoreRef = useRef(true);
  const permissionRef = useRef(null);
  const mediaPermissionRef = useRef(null);
  const ignoreNextPressRef = useRef(false);
  const ignoreNextPressTimerRef = useRef(null);
  const [mediaPermission, requestMediaPermission] = useMediaPermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const [savedImages, setSavedImages] = useState([]);
  const [hasMoreImages, setHasMoreImages] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openedImage, setOpenedImage] = useState(null);
  const isSelectionMode = selectedImageIds.size > 0;
  const allImagesSelected =
    savedImages.length > 0 &&
    !hasMoreImages &&
    savedImages.every((image) => selectedImageIds.has(getAssetKey(image)));

  useEffect(() => {
    mediaPermissionRef.current = mediaPermission;
  }, [mediaPermission]);

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
      const normalizedAssets = await Promise.all(
        assets.map((asset) => normalizeSavedImage(asset))
      );
      const usableAssets = normalizedAssets.filter((asset) => asset?.uri);
      const nextImages = dedupeAssets(
        reset ? usableAssets : [...assetsRef.current, ...usableAssets]
      );
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
        if (ignoreNextPressTimerRef.current) {
          clearTimeout(ignoreNextPressTimerRef.current);
          ignoreNextPressTimerRef.current = null;
        }
        ignoreNextPressRef.current = false;
      };
    }, [loadSavedImages])
  );

  const startSelection = (image) => {
    setSelectedImageIds(new Set([getAssetKey(image)]));
  };

  const toggleSelection = (image) => {
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
  };

  const clearSelection = () => {
    setSelectedImageIds(new Set());
  };

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
        throw new Error('Photo-library permission is required to delete saved images.');
      }

      const assetsToDelete = selectedImages.map((image) => new mediaLibraryModule.Asset(image.id));
      await mediaLibraryModule.Asset.delete(assetsToDelete);

      const deletedIds = new Set(selectedImages.map(getAssetKey));
      const remainingImages = assetsRef.current.filter((image) => !deletedIds.has(getAssetKey(image)));
      assetsRef.current = remainingImages;
      setSavedImages(remainingImages);
      clearSelection();
      setLoadError(null);
      return true;
    } catch (error) {
      setLoadError(getErrorMessage(error));
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
      'Delete saved images?',
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
      await Share.share({
        title: 'Share Snippets image',
        url: selectedImages[0].uri,
      });
    } catch (error) {
      setLoadError(getErrorMessage(error));
    }
  };

  const confirmDeleteOpenedImage = () => {
    if (!openedImage || isDeleting) return;

    Alert.alert(
      'Delete saved image?',
      'This will permanently delete this image.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const deleted = await deleteImages([openedImage]);
            if (deleted) setOpenedImage(null);
          },
        },
      ]
    );
  };

  const shareOpenedImage = async () => {
    if (!openedImage || isDeleting) return;

    try {
      await Share.share({
        title: 'Share Snippets image',
        url: openedImage.uri,
      });
    } catch (error) {
      setLoadError(getErrorMessage(error));
    }
  };

  if (openedImage) {
    return (
      <OpenedImageView
        image={openedImage}
        disabled={isDeleting}
        onBack={() => setOpenedImage(null)}
        onDelete={confirmDeleteOpenedImage}
        onShare={shareOpenedImage}
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
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: bottomInset },
            savedImages.length === 0 && styles.emptyListContent,
          ]}
          columnWrapperStyle={styles.galleryRow}
          renderItem={({ item }) => (
            <Pressable
              accessibilityLabel={
                isSelectionMode
                  ? `${selectedImageIds.has(getAssetKey(item)) ? 'Unselect' : 'Select'} ${item.fileName || 'saved image'}`
                : `Open ${item.fileName || 'saved image'}`
              }
              accessibilityRole="button"
              delayLongPress={300}
              onLongPress={() => {
                if (!isSelectionMode) {
                  ignoreNextPressRef.current = true;
                  if (ignoreNextPressTimerRef.current) {
                    clearTimeout(ignoreNextPressTimerRef.current);
                  }
                  ignoreNextPressTimerRef.current = setTimeout(() => {
                    ignoreNextPressRef.current = false;
                    ignoreNextPressTimerRef.current = null;
                  }, 750);
                  startSelection(item);
                }
              }}
              onPress={() => {
                if (ignoreNextPressRef.current) {
                  ignoreNextPressRef.current = false;
                  if (ignoreNextPressTimerRef.current) {
                    clearTimeout(ignoreNextPressTimerRef.current);
                    ignoreNextPressTimerRef.current = null;
                  }
                  return;
                }

                if (isSelectionMode) {
                  toggleSelection(item);
                } else {
                  setOpenedImage(item);
                }
              }}
              style={({ pressed }) => [styles.galleryTile, pressed && styles.pressed]}>
              <Image
                accessibilityLabel={item.fileName || 'Saved image'}
                contentFit="cover"
                source={{ uri: item.uri }}
                style={styles.galleryImage}
              />
              {selectedImageIds.has(getAssetKey(item)) && (
                <View style={styles.selectionCheckmark}>
                  <SymbolView
                    name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                    size={16}
                    tintColor={Colors.light.background}
                  />
                </View>
              )}
            </Pressable>
          )}
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
                <ThemedText type="title">Saved images</ThemedText>
                <ThemedText themeColor="textSecondary" style={styles.subtitle}>
                  Your previously saved images
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
          onPress={() => router.push('/screen')}
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

function OpenedImageView({ image, disabled, onBack, onDelete, onShare }) {
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

        <View style={styles.openedImageFrame}>
          <Image
            accessibilityLabel={image.fileName || 'Opened saved image'}
            contentFit="contain"
            source={{ uri: image.uri }}
            style={styles.openedImage}
          />
        </View>

        <View style={styles.openedImageActions}>
          <Pressable
            accessibilityLabel="Delete opened image"
            accessibilityRole="button"
            disabled={disabled}
            onPress={onDelete}
            style={({ pressed }) => [
              styles.openedImageAction,
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
      </SafeAreaView>
    </ThemedView>
  );
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
        style={({ pressed }) => [styles.selectionAction, pressed && styles.pressed, disabled && styles.disabled]}>
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
        style={({ pressed }) => [styles.selectionAction, pressed && styles.pressed, disabled && styles.disabled]}>
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
          Loading saved images…
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
          accessibilityLabel="Retry loading saved images"
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
        No saved images yet.
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
          Could not load more images.
        </ThemedText>
        <Pressable
          accessibilityLabel="Retry loading more saved images"
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
          All saved images are shown.
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

async function normalizeSavedImage(asset) {
  if (!asset) return null;

  let info = asset;
  let uri = null;

  if (typeof asset.getUri === 'function') {
    try {
      uri = await asset.getUri();
    } catch {
      uri = null;
    }
  }

  if (typeof asset.getInfo === 'function') {
    try {
      info = await asset.getInfo();
    } catch {
      info = asset;
    }
  }

  uri = uri ?? info?.uri ?? asset.uri ?? asset.id;
  if (!uri) return null;

  return {
    id: info?.id ?? asset.id ?? uri,
    uri,
    width: info?.width ?? asset.width ?? 1,
    height: info?.height ?? asset.height ?? 1,
    fileName: info?.filename ?? asset.filename ?? asset.fileName ?? null,
  };
}

function dedupeAssets(assets) {
  const uniqueAssets = [];
  const seen = new Set();

  assets.forEach((asset) => {
    const key = asset.id || asset.uri;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueAssets.push(asset);
    }
  });

  return uniqueAssets;
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return 'Unable to load saved images.';
}

function getAssetKey(asset) {
  return asset.id || asset.uri;
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
  openedImage: {
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
  openedImageActionText: {
    color: Colors.light.background,
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
