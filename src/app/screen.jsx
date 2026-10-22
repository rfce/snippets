import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const cameraModule = getCameraModule();
const mediaLibraryModule = getMediaLibraryModule();
const CameraView = cameraModule?.CameraView;

function getCameraModule() {
  try {
    return require('expo-camera');
  } catch {
    return null;
  }
}

function getMediaLibraryModule() {
  try {
    return require('expo-media-library');
  } catch {
    return null;
  }
}

export default function ScreenTab() {
  if (
    !cameraModule?.CameraView ||
    !cameraModule?.useCameraPermissions ||
    !mediaLibraryModule?.usePermissions ||
    !mediaLibraryModule?.Asset?.create
  ) {
    return <CameraModuleUnavailable />;
  }

  return <CameraScreen />;
}

function CameraModuleUnavailable() {
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.centeredContent}>
        <ThemedText type="subtitle" style={styles.statusText}>
          Camera unavailable
        </ThemedText>
        <ThemedText style={styles.statusText} themeColor="textSecondary">
          This development build does not include the camera native module. Rebuild the development
          build after installing expo-camera and expo-media-library, then reload the app.
        </ThemedText>
        <ActivityIndicator color={theme.text} />
      </SafeAreaView>
    </ThemedView>
  );
}

function CameraScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef(null);
  const cameraRequestStarted = useRef(false);
  const [cameraPermission, requestCameraPermission] = cameraModule.useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = mediaLibraryModule.usePermissions({
    writeOnly: true,
  });
  const [isFocused, setIsFocused] = useState(true);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);

      return () => setIsFocused(false);
    }, [])
  );

  useEffect(() => {
    if (!cameraPermission || cameraPermission.granted || cameraRequestStarted.current) return;

    cameraRequestStarted.current = true;
    requestCameraPermission().then((permission) => {
      if (!permission.granted) {
        router.replace('/');
      }
    }).catch(() => router.replace('/'));
  }, [cameraPermission, requestCameraPermission]);

  const capturePhoto = async () => {
    if (!cameraRef.current || !isCameraReady || isCapturing) return;

    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });

      if (!photo?.uri) return;

      if (Platform.OS === 'web') {
        Alert.alert('Not available', 'Saving photos is available on a mobile device.');
        return;
      }

      let permission = mediaPermission;
      if (!permission?.granted) {
        permission = await requestMediaPermission();
      }

      if (!permission.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save captured images.');
        return;
      }

      await mediaLibraryModule.Asset.create(photo.uri);
      Alert.alert('Photo saved', 'The captured image was saved to your device.');
    } catch {
      Alert.alert('Capture failed', 'We could not save the captured image. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  };

  if (!cameraPermission || !cameraPermission.granted) {
    return (
      <ThemedView style={styles.container}>
        <SafeAreaView style={styles.centeredContent}>
          <ActivityIndicator color={theme.text} />
          <ThemedText style={styles.statusText}>Requesting camera access…</ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <View style={styles.container}>
      {isFocused && (
        <CameraView
          ref={cameraRef}
          facing="back"
          ratio={Platform.OS === 'android' ? '4:3' : undefined}
          onCameraReady={() => setIsCameraReady(true)}
          onMountError={(event) => {
            setCameraError(event?.nativeEvent?.message ?? 'The camera preview could not start.');
          }}
          style={styles.camera}
        />
      )}

      <View
        pointerEvents="box-none"
        style={[styles.controls, { paddingBottom: insets.bottom + BottomTabInset + Spacing.three }]}>
        <Pressable
          accessibilityLabel="Capture photo"
          accessibilityRole="button"
          disabled={!isCameraReady || isCapturing}
          onPress={capturePhoto}
          style={({ pressed }) => [
            styles.captureButton,
            { borderColor: Colors.light.background },
            pressed && styles.pressed,
            (!isCameraReady || isCapturing) && styles.disabled,
          ]}>
          {isCapturing ? (
            <ActivityIndicator color={Colors.light.text} />
          ) : (
            <View style={[styles.captureButtonInner, { backgroundColor: Colors.light.background }]} />
          )}
        </Pressable>
      </View>

      {cameraError && (
        <View style={styles.errorOverlay} pointerEvents="none">
          <ThemedText style={styles.statusText}>{cameraError}</ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  camera: {
    flex: 1,
  },
  centeredContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  statusText: {
    textAlign: 'center',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  errorOverlay: {
    position: 'absolute',
    top: Spacing.four,
    left: Spacing.four,
    right: Spacing.four,
    alignItems: 'center',
    padding: Spacing.two,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  captureButton: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
