import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

// Icon-only editing controls shared by batch Edit image and single Review
// capture, so both editors use identical icons, circle sizes and dock.
export const EDIT_ICONS = {
  crop: { ios: 'crop', android: 'crop', web: 'crop' },
  rotate: { ios: 'rotate.right', android: 'rotate_right', web: 'rotate_right' },
  reset: { ios: 'arrow.up.left.and.arrow.down.right', android: 'open_in_full', web: 'open_in_full' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  delete: { ios: 'trash', android: 'delete', web: 'delete' },
};

/** Rounded, softly raised container for a row of IconButtons. */
export function IconDock({ children, style }) {
  return <View style={[styles.dock, style]}>{children}</View>;
}

export function IconButton({
  label, icon, iconSize = 22, large = false, onPress, active = false, destructive = false,
  disabled = false, primary = false, success = false, busy = false,
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled, busy }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.iconButton, large && styles.iconButtonLarge,
        active && styles.iconActive, destructive && styles.iconDestructive,
        primary && styles.iconPrimary, success && styles.iconSuccess,
        pressed && styles.pressed, disabled && styles.disabled]}>
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <SymbolView name={icon} size={iconSize}
          tintColor={primary || success ? '#FFFFFF'
            : destructive ? '#C2415A' : active ? '#FFFFFF' : '#31517F'} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dock: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingHorizontal: 8, paddingVertical: 8, borderRadius: 36,
    backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#EDF1F7',
    shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  iconButton: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: '#EEF3FB',
    alignItems: 'center', justifyContent: 'center',
  },
  iconButtonLarge: { width: 56, height: 56, borderRadius: 28 },
  iconActive: { backgroundColor: '#3C78D8' },
  iconDestructive: { backgroundColor: '#FFF1F3' },
  iconSuccess: {
    backgroundColor: '#2F9E72',
    shadowColor: '#1F7A56', shadowOpacity: 0.22, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  iconPrimary: {
    backgroundColor: '#3C78D8',
    shadowColor: '#2A5EB0', shadowOpacity: 0.22, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
