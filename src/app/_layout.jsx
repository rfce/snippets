import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { useColorScheme as useNativeColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { SelectionContext } from '@/context/SelectionContext';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useNativeColorScheme();
  const [selectedImageIds, setSelectedImageIds] = useState(() => new Set());

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <SelectionContext.Provider value={{ selectedImageIds, setSelectedImageIds }}>
        <Stack screenOptions={{ headerShown: false }} />
      </SelectionContext.Provider>
    </ThemeProvider>
  );
}
