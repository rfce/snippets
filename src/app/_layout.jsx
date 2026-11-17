import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useState } from 'react';
import { StyleSheet, View, useColorScheme as useNativeColorScheme } from 'react-native';

import { SaveStatusPill } from '@/components/save-status';
import { SelectionContext } from '@/context/SelectionContext';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useNativeColorScheme();
  const [selectedImageIds, setSelectedImageIds] = useState(() => new Set());

  // Hide the native splash on the first layout pass, so the library appears
  // immediately. The animated intro (AnimatedSplashOverlay in
  // components/animated-icon) used to hide it here after its own layout and
  // then play for 600 ms on every launch; render it above the Stack again to
  // restore that intro.
  const hideSplash = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {
      // Already hidden, for example after a fast refresh.
    });
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <View style={styles.root} onLayout={hideSplash}>
        <SelectionContext.Provider value={{ selectedImageIds, setSelectedImageIds }}>
          <Stack screenOptions={{ headerShown: false }} />
        </SelectionContext.Provider>
        {/* Background saves report progress here, on every screen. */}
        <SaveStatusPill />
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
