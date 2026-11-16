import { Image } from 'expo-image';
import { useCallback, useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hasCustomCrop } from '@/crop-geometry';
import { getBatchPhotoId } from '@/batch-workflow';

function getFilmstripOffset(index, count, size, viewportWidth) {
  if (count <= 0 || viewportWidth <= 0) return 0;
  const selected = Math.max(0, Math.min(index, count - 1));
  const contentWidth = count * size + Math.max(0, count - 1) * 12 + 3;
  const centered = selected * (size + 12) - (viewportWidth - size) / 2;
  return Math.max(0, Math.min(centered, Math.max(0, contentWidth - viewportWidth)));
}

export function BatchFilmstrip({
  photos, selectedIndex, onSelect, disabled = false, editsById = {}, compact = false, showCaption = true,
  showCount = true, size: sizeProp,
}) {
  const listRef = useRef(null);
  const viewportWidthRef = useRef(0);
  const size = sizeProp ?? (compact ? 56 : 66);
  const activeIndex = Math.max(0, Math.min(selectedIndex, photos.length - 1));
  // A primitive signature keeps FlatList from re-rendering every tile when an
  // unrelated parent state changes; only real selection/edit changes refresh.
  const extraData = [
    activeIndex,
    disabled ? 1 : 0,
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
  useEffect(() => { revealSelected(true); }, [revealSelected]);
  return (
    <View style={styles.container}>
      {showCaption && <View style={styles.caption}>
        <ThemedText style={styles.eyebrow}>YOUR STACK</ThemedText>
        {showCount && (
          <ThemedText style={styles.count}>{photos.length ? activeIndex + 1 : 0} / {photos.length}</ThemedText>
        )}
      </View>}
      <FlatList
        ref={listRef}
        horizontal
        style={{ width: '100%', height: size + 14, flexGrow: 0 }}
        onLayout={({ nativeEvent: { layout } }) => {
          viewportWidthRef.current = layout.width;
          revealSelected();
        }}
        onContentSizeChange={() => revealSelected()}
        initialNumToRender={Math.max(1, Math.min(photos.length, 12))}
        removeClippedSubviews={false}
        showsHorizontalScrollIndicator
        data={photos}
        extraData={extraData}
        keyExtractor={(item, index) => `${getBatchPhotoId(item)}:${index}`}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={ThumbnailSeparator}
        getItemLayout={(_, index) => ({ length: size, offset: (size + 12) * index, index })}
        renderItem={({ item, index }) => {
          const id = getBatchPhotoId(item);
          const edits = editsById[id] ?? item.edits;
          const edited = Boolean(edits?.rotation || hasCustomCrop(edits?.corners));
          const rotation = (edits?.rotation ?? 0) - (item.sourcePhoto ? item.edits?.rotation ?? 0 : 0);
          const selected = index === activeIndex;
          return (
            <Pressable
              accessibilityLabel={`Image ${index + 1}${edited ? ', edited' : ''}`}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onSelect(index)}
              style={({ pressed }) => [
                styles.tile, { width: size, height: size + 8 },
                selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled,
              ]}>
              <View style={styles.imageClip}>
                <Image
                  source={item.uri}
                  contentFit="cover"
                  recyclingKey={item.uri}
                  transition={0}
                  style={[styles.image, { transform: [{ rotate: `${rotation}deg` }] }]}
                />
              </View>
              <View style={[styles.number, selected && styles.selectedNumber]}>
                <ThemedText style={styles.numberText}>{String(index + 1).padStart(2, '0')}</ThemedText>
              </View>
              {edited && <View style={styles.edited} />}
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

const styles = StyleSheet.create({
  container: { width: '100%', flexShrink: 0, paddingVertical: 10 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { color: '#718096', fontSize: 10, lineHeight: 14, letterSpacing: 1.8, fontWeight: '700' },
  count: { color: '#526581', fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  list: { paddingVertical: 3, paddingRight: 3 },
  separator: { width: 12 },
  tile: { borderWidth: 2, borderColor: 'transparent', borderRadius: 15, padding: 3 },
  selected: { borderColor: '#3C78D8', backgroundColor: '#EAF1FF' },
  imageClip: { flex: 1, borderRadius: 10, overflow: 'hidden', backgroundColor: '#DFE7F1' },
  image: { width: '100%', height: '100%' },
  number: { position: 'absolute', bottom: 7, left: 7, borderRadius: 5, paddingHorizontal: 4, backgroundColor: 'rgba(15,23,42,0.72)' },
  selectedNumber: { backgroundColor: '#3C78D8' },
  numberText: { color: '#FFFFFF', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  edited: { position: 'absolute', top: 6, right: 6, width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#3C78D8' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
