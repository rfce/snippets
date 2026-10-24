import { NativeTabs } from 'expo-router/native-tabs';
import { useContext } from 'react';
import { useColorScheme as useNativeColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { TabBarContext } from '@/context/TabBarContext';

export default function AppTabs() {
  const scheme = useNativeColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const { isTabBarHidden } = useContext(TabBarContext);

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      hidden={isTabBarHidden}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="screen">
        <NativeTabs.Trigger.Label>Screen</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'camera', selected: 'camera.fill' }}
          md="photo_camera"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
