import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { useColorScheme as useNativeColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { TabBarContext } from '@/context/TabBarContext';
import { SelectionContext } from '@/context/SelectionContext';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useNativeColorScheme();
  const [selectedImageIds, setSelectedImageIds] = useState(() => new Set());

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <TabBarContext.Provider value={{}}>
        <SelectionContext.Provider value={{ selectedImageIds, setSelectedImageIds }}>
          <AppTabs />
        </SelectionContext.Provider>
      </TabBarContext.Provider>
    </ThemeProvider>
  );
}
