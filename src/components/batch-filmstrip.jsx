import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useRef } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hasCustomCrop } from '@/crop-geometry';
import { getBatchPhotoId } from '@/batch-workflow';

export function BatchFilmstrip({
  photos, selectedIndex, onSelect, disabled = false, editsById = {}, compact = false, showCaption = true,
}) {
  const listRef = useRef(null);
  const size = compact ? 56 : 66;
  return (
    <View style={styles.container}>
      {showCaption && <View style={styles.caption}>
        <ThemedText style={styles.eyebrow}>YOUR STACK</ThemedText>
        <ThemedText style={styles.count}>{selectedIndex + 1} / {photos.length}</ThemedText>
      </View>}
      <FlatList
        ref={listRef}
        horizontal
        style={{ height: size + 14, flexGrow: 0 }}
        initialScrollIndex={selectedIndex}
        showsHorizontalScrollIndicator={false}
        data={photos}
        extraData={{ selectedIndex, editsById, disabled }}
        keyExtractor={getBatchPhotoId}
        contentContainerStyle={styles.list}
        getItemLayout={(_, index) => ({ length: size + 12, offset: (size + 12) * index, index })}
        renderItem={({ item, index }) => {
          const id = getBatchPhotoId(item);
          const edits = editsById[id] ?? item.edits;
          const edited = Boolean(edits?.rotation || hasCustomCrop(edits?.corners));
          const selected = index === selectedIndex;
          return (
            <Pressable
              accessibilityLabel={`Image ${index + 1}${edited ? ', framed' : ''}`}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => {
                onSelect(index);
                listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
              }}
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
                  style={[styles.image, !item.sourcePhoto && { transform: [{ rotate: `${edits?.rotation ?? 0}deg` }] }]}
                />
              </View>
              <View style={[styles.number, selected && styles.selectedNumber]}>
                <ThemedText style={styles.numberText}>{String(index + 1).padStart(2, '0')}</ThemedText>
              </View>
              {edited && (
                <View style={styles.edited}>
                  <SymbolView
                    name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                    size={11}
                    tintColor="#FFFFFF"
                  />
                </View>
              )}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexShrink: 0, paddingVertical: 10 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { color: '#718096', fontSize: 10, lineHeight: 14, letterSpacing: 1.8, fontWeight: '700' },
  count: { color: '#526581', fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  list: { gap: 12, paddingVertical: 3, paddingRight: 3 },
  tile: { borderWidth: 2, borderColor: 'transparent', borderRadius: 15, padding: 3 },
  selected: { borderColor: '#3C78D8', backgroundColor: '#EAF1FF' },
  imageClip: { flex: 1, borderRadius: 10, overflow: 'hidden', backgroundColor: '#DFE7F1' },
  image: { width: '100%', height: '100%' },
  number: { position: 'absolute', bottom: 7, left: 7, borderRadius: 5, paddingHorizontal: 4, backgroundColor: 'rgba(15,23,42,0.72)' },
  selectedNumber: { backgroundColor: '#3C78D8' },
  numberText: { color: '#FFFFFF', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  edited: { position: 'absolute', top: 0, right: -2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#2F9E72', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
