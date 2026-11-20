import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hasCustomCrop } from '@/crop-geometry';
import { getBatchPhotoId } from '@/batch-workflow';

const GAP = 10;

function getFilmstripOffset(index, count, size, viewportWidth) {
  if (count <= 0 || viewportWidth <= 0) return 0;
  const selected = Math.max(0, Math.min(index, count - 1));
  const contentWidth = count * size + Math.max(0, count - 1) * GAP + 3;
  const centered = selected * (size + GAP) - (viewportWidth - size) / 2;
  return Math.max(0, Math.min(centered, Math.max(0, contentWidth - viewportWidth)));
}

export function BatchFilmstrip({
  photos, selectedIndex, onSelect, disabled = false, editsById = {}, compact = false, showCaption = true,
  showCount = true, size: sizeProp, style, statuses,
}) {
  const listRef = useRef(null);
  const viewportWidthRef = useRef(0);
  const size = sizeProp ?? (compact ? 62 : 72);
  const activeIndex = Math.max(0, Math.min(selectedIndex, photos.length - 1));
  // A primitive signature keeps FlatList from re-rendering every tile when an
  // unrelated parent state changes; only real selection/edit changes refresh.
  const extraData = [
    activeIndex,
    disabled ? 1 : 0,
    statuses ? statuses.map((status) => status ?? '-').join(',') : '',
    ...photos.map((item) => {
      const value = editsById[getBatchPhotoId(item)] ?? item.edits;
      return `${value?.rotation ?? 0}:${hasCustomCrop(value?.corners) ? 1 : 0}`;
    }),
  ].join('|');
  const revealSelected = useCallback((animated = false) => {
    if (!viewportWidthRef.current) return;
    listRef.current?.scrollToOffset({
      offset: getFilmstripOffset(activeIndex, photos.length, size, viewportWidthRef.current),
      animated,
    });
  }, [activeIndex, photos.length, size]);
  // Follow selection and real viewport changes. Content-size notifications
  // also fire during virtualized scrolling and must not recenter the strip.
  useEffect(() => { revealSelected(true); }, [revealSelected]);
  return (
    <View style={[styles.container, style]}>
      {showCaption && <View style={styles.caption}>
        <ThemedText style={styles.eyebrow}>YOUR STACK</ThemedText>
        {showCount && (
          <ThemedText style={styles.count}>{photos.length ? activeIndex + 1 : 0} / {photos.length}</ThemedText>
        )}
      </View>}
      <FlatList
        ref={listRef}
        horizontal
        style={{ width: '100%', height: size + 4, flexGrow: 0 }}
        onLayout={({ nativeEvent: { layout } }) => {
          if (viewportWidthRef.current === layout.width) return;
          viewportWidthRef.current = layout.width;
          revealSelected();
        }}
        initialScrollIndex={photos.length ? activeIndex : undefined}
        initialNumToRender={Math.max(1, Math.min(photos.length, 6))}
        maxToRenderPerBatch={4}
        windowSize={3}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={Platform.OS === 'android'}
        showsHorizontalScrollIndicator={false}
        data={photos}
        extraData={extraData}
        keyExtractor={(item) => getBatchPhotoId(item)}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={ThumbnailSeparator}
        getItemLayout={(_, index) => ({ length: size, offset: (size + GAP) * index, index })}
        renderItem={({ item, index }) => {
          const id = getBatchPhotoId(item);
          const edits = editsById[id] ?? item.edits;
          const edited = Boolean(edits?.rotation || hasCustomCrop(edits?.corners));
          const rotation = (edits?.rotation ?? 0) - (item.sourcePhoto ? item.edits?.rotation ?? 0 : 0);
          const selected = index === activeIndex;
          // Per-image processing state (batch Review): queued tiles are veiled,
          // the image being processed shows a spinner, and finished tiles show
          // their result because `photos` already holds the processed image.
          const status = statuses?.[index] ?? null;
          const statusLabel = status === 'processing' ? ', enhancing'
            : status === 'queued' ? ', waiting to enhance'
              : status === 'error' ? ', enhancement failed' : '';
          return (
            <Pressable
              accessibilityLabel={`Image ${index + 1}${edited ? ', edited' : ''}${statusLabel}`}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled, busy: status === 'processing' }}
              disabled={disabled}
              onPress={() => onSelect(index)}
              style={({ pressed }) => [
                styles.tile, { width: size, height: size },
                selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled,
              ]}>
              <View style={styles.imageClip}>
                <Image
                  source={item.uri}
                  contentFit="cover"
                  cachePolicy="disk"
                  enforceEarlyResizing
                  priority="low"
                  recyclingKey={item.uri}
                  transition={0}
                  style={[styles.image, { transform: [{ rotate: `${rotation}deg` }] }]}
                />
                {status === 'queued' || status === 'processing' ? (
                  <View pointerEvents="none" style={styles.statusVeil}>
                    {status === 'processing' ? <ActivityIndicator size="small" color="#3C78D8" /> : null}
                  </View>
                ) : null}
              </View>
              {status === 'error' ? (
                <View pointerEvents="none" style={styles.errorBadge}>
                  <SymbolView
                    name={{ ios: 'exclamationmark', android: 'priority_high', web: 'priority_high' }}
                    size={11}
                    tintColor="#FFFFFF"
                  />
                </View>
              ) : null}
              <ThumbnailCount label={String(index + 1).padStart(2, '0')} index={index} />
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function ThumbnailSeparator() {
  return <View style={styles.separator} />;
}

// Static badges avoid a JavaScript-driven animation loop for every mounted
// thumbnail while the user is swiping or a native edit is being saved.
const COUNT_TINTS = [
  '#4A6FA5', '#6B5FA8', '#35786A', '#A85A54', '#7E5626', '#41718C', '#4A6FA5',
];

function ThumbnailCount({ label, index }) {
  return (
    <Text
      accessible={false}
      style={[styles.number, { backgroundColor: COUNT_TINTS[index % COUNT_TINTS.length] }]}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', flexShrink: 0, paddingVertical: 6 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { color: '#718096', fontSize: 10, lineHeight: 14, letterSpacing: 1.8, fontWeight: '700' },
  count: { color: '#526581', fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  list: { paddingVertical: 2, paddingRight: 3 },
  separator: { width: GAP },
  tile: { borderWidth: 2, borderColor: 'transparent', borderRadius: 15, padding: 3 },
  selected: { borderColor: '#3C78D8', backgroundColor: '#EAF1FF' },
  imageClip: { flex: 1, borderRadius: 10, overflow: 'hidden', backgroundColor: '#EEF2F7' },
  image: { width: '100%', height: '100%' },
  number: { position: 'absolute', bottom: 8, left: 8, borderRadius: 7, paddingHorizontal: 6,
    paddingVertical: 1, overflow: 'hidden', color: '#FFFFFF', fontSize: 11, lineHeight: 16,
    fontWeight: '700', fontVariant: ['tabular-nums'] },
  statusVeil: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)' },
  errorBadge: { position: 'absolute', top: 6, right: 6, width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#C2415A',
    borderWidth: 1.5, borderColor: '#FFFFFF' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
