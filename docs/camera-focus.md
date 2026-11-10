# Camera focus targeting update

Copy all six updated files over the previous camera feature, preserving their paths. Run prebuild, build a new native development or release app, and install that new build. A JavaScript reload or OTA update cannot apply the native changes. Keep the existing app.json and package.json camera/source-build configuration.

The v3 plugin upgrades both v1 and v2 patches automatically. Its native entry points are versioned, so JavaScript cannot silently use an earlier native focus implementation. “Camera update required” means the installed binary needs rebuilding.

This update addresses a cancellation race and competing default focus updates:

- A tap sends one native focus command. It no longer sends an independent cancel that could arrive after focus starts. On Android that command waits for CameraX to release the previous AF lock before it starts the selected-point scan.
- Every focus/release command carries an increasing ID. Native code ignores older commands even if delivery is reordered.
- Android no longer receives Expo's general autofocus switch (documented for iOS); CameraX supplies the automatic baseline until a tap takes ownership. Default Expo autofocus props cannot change focus while the tapped point owns it.
- The native preview is memoized separately from the square indicator. Moving, recoloring and fading the indicator do not resend camera props.
- Android autofocus uses a smaller 4% metering region around the tap; exposure uses a separate 12% region. PreviewView still handles display rotation, crop and sensor-coordinate conversion.
- iOS explicitly locks the lens after its selected-point autofocus scan. A reporting timeout does not restart default autofocus on either platform.
- A new tap replaces the selected point. Closing/backgrounding the camera releases it. Capture and indicator fade preserve it.

The white/turquoise indicator behavior and capture quality are preserved. No packages were added. Crop, enhancement and saved-gallery behavior are unchanged.

Validation covers deliberately reordered native commands, rapid retaps, old completions, capture/fade without focus release, camera-prop isolation, and fresh/v1/v2 native patch application and idempotence. No Node/Git, TypeScript or ESLint commands were run. Native compilation and physical autofocus could not be tested here.

On the reported OnePlus Android device, test after installing the rebuilt app:

1. Place two textured objects at different distances, both within the camera's normal focusing range.
2. Tap the centre of the farther object, away from the nearer object's edge. Check actual sharpness, not only the square's color.
3. Wait for the square to fade, then wait another 30 seconds. Focus should stay on the selected distance.
4. Tap the nearer object and then the farther object repeatedly; the most recent tap should win.
5. Capture after focus and while a scan is pending; verify one photo is taken at native resolution.
6. Confirm flash/torch, Batch, background return and an unfocusable subject still behave correctly.

References: [Expo Camera 58](https://docs.expo.dev/versions/v58.0.0/sdk/camera/), [CameraX focus commands](https://developer.android.com/reference/androidx/camera/core/CameraControl#startFocusAndMetering(androidx.camera.core.FocusMeteringAction)), [metering-point size](https://developer.android.com/reference/androidx/camera/core/MeteringPointFactory), [AVFoundation autofocus](https://developer.apple.com/documentation/avfoundation/avcapturedevice/focusmode-swift.enum/autofocus).
