import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { useColorScheme as useNativeColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { TabBarContext } from '@/context/TabBarContext';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useNativeColorScheme();
  const [isTabBarHidden, setIsTabBarHidden] = useState(false);
  const [selectedImageIds, setSelectedImageIds] = useState(() => new Set());

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <TabBarContext.Provider
        value={{
          isTabBarHidden,
          setIsTabBarHidden,
          selectedImageIds,
          setSelectedImageIds,
        }}>
        <AppTabs />
      </TabBarContext.Provider>
    </ThemeProvider>
  );
}
