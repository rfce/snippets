import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, MaxContentWidth, Spacing } from '@/constants/theme';
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
  const loadingRef = useRef(false);
  const assetsRef = useRef([]);
  const hasMoreRef = useRef(true);
  const permissionRef = useRef(null);
  const [mediaPermission, requestMediaPermission] = useMediaPermissions({
    writeOnly: false,
    granularPermissions: ['photo'],
  });
  const [savedImages, setSavedImages] = useState([]);
  const [hasMoreImages, setHasMoreImages] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

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

      let permission = permissionRef.current ?? mediaPermission;
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
  }, [mediaPermission, requestMediaPermission]);

  useFocusEffect(
    useCallback(() => {
      loadSavedImages(true);
    }, [loadSavedImages])
  );

  const bottomInset = safeAreaInsets.bottom + BottomTabInset + Spacing.three;

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
            <View style={styles.galleryTile}>
              <Image
                accessibilityLabel={item.fileName || 'Saved image'}
                contentFit="cover"
                source={{ uri: item.uri }}
                style={styles.galleryImage}
              />
            </View>
          )}
          ListHeaderComponent={
            <View style={styles.header}>
              <ThemedText type="title">Saved images</ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.subtitle}>
                Your previously saved images
              </ThemedText>
            </View>
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
          refreshing={isLoading && savedImages.length > 0}
        />
      </SafeAreaView>
    </ThemedView>
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
  subtitle: {
    fontSize: 15,
  },
  galleryRow: {
    justifyContent: 'space-between',
    marginBottom: Spacing.one,
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
  footerState: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  footerText: {
    textAlign: 'center',
  },
});
