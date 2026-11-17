import { Image } from 'expo-image';
import { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, FlatList, Pressable, StyleSheet, View } from 'react-native';

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
  showCount = true, size: sizeProp, style,
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
        style={{ width: '100%', height: size + 14, flexGrow: 0 }}
        onLayout={({ nativeEvent: { layout } }) => {
          viewportWidthRef.current = layout.width;
          revealSelected();
        }}
        onContentSizeChange={() => revealSelected()}
        initialNumToRender={Math.max(1, Math.min(photos.length, 12))}
        removeClippedSubviews={false}
        showsHorizontalScrollIndicator={false}
        data={photos}
        extraData={extraData}
        keyExtractor={(item, index) => `${getBatchPhotoId(item)}:${index}`}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={ThumbnailSeparator}
        getItemLayout={(_, index) => ({ length: size, offset: (size + GAP) * index, index })}
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
              {edited && <EditedDot />}
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

// Marks a thumbnail as edited/cropped. The dot rests in a muted grey and
// shimmers through bright tints on a loop so it reads as "something changed"
// without shouting for attention.
const DOT_TINTS = ['#8A97A8', '#7FD1E8', '#BBA6F7', '#8FE3B8', '#F7C9A6', '#8A97A8'];

function EditedDot() {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(progress, {
      toValue: DOT_TINTS.length - 1,
      duration: 3600,
      easing: Easing.linear,
      useNativeDriver: false,
      isInteraction: false,
    }));
    loop.start();
    return () => loop.stop();
  }, [progress]);
  const pulse = {
    inputRange: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
  };
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.edited, {
        backgroundColor: progress.interpolate({
          inputRange: DOT_TINTS.map((_, index) => index),
          outputRange: DOT_TINTS,
        }),
        opacity: progress.interpolate({
          ...pulse,
          outputRange: [0.55, 1, 0.55, 1, 0.55, 1, 0.55, 1, 0.55, 1, 0.55],
        }),
        transform: [{
          scale: progress.interpolate({
            ...pulse,
            outputRange: [0.85, 1.1, 0.85, 1.1, 0.85, 1.1, 0.85, 1.1, 0.85, 1.1, 0.85],
          }),
        }],
      }]}
    />
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', flexShrink: 0, paddingVertical: 6 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { color: '#718096', fontSize: 10, lineHeight: 14, letterSpacing: 1.8, fontWeight: '700' },
  count: { color: '#526581', fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  list: { paddingVertical: 2, paddingRight: 3 },
  separator: { width: GAP },
  tile: { borderWidth: 2, borderColor: 'transparent', borderRadius: 14, padding: 3 },
  selected: { borderColor: '#3C78D8', backgroundColor: '#EAF1FF' },
  imageClip: { flex: 1, borderRadius: 9, overflow: 'hidden', backgroundColor: '#EEF2F7' },
  image: { width: '100%', height: '100%' },
  number: { position: 'absolute', bottom: 7, left: 7, borderRadius: 5, paddingHorizontal: 4, backgroundColor: 'rgba(15,23,42,0.72)' },
  selectedNumber: { backgroundColor: '#3C78D8' },
  numberText: { color: '#FFFFFF', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  edited: { position: 'absolute', top: 6, right: 6, width: 9, height: 9, borderRadius: 5,
    backgroundColor: '#8A97A8' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
