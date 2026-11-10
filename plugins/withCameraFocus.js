const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs/promises');
const path = require('path');

const MARKER = '// snippets-camera-focus-v3';
const LEGACY_MARKERS = ['// snippets-camera-focus-v1', '// snippets-camera-focus-v2'];

function replaceOnce(source, anchor, replacement, file) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`[camera-focus] Unsupported expo-camera source in ${file}. Expected one: ${anchor}`);
  }
  return source.replace(anchor, replacement);
}

function bridgeFor(relativePath) {
  if (relativePath.endsWith('.kt')) {
    return `      ${MARKER}
      AsyncFunction("snippetsFocusAtPointAsync") { view: ExpoCameraView, x: Double, y: Double, commandId: Double, promise: Promise ->
        view.snippetsFocusAsync(x, y, commandId, promise)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("snippetsCancelPointFocus") { view: ExpoCameraView, commandId: Double ->
        view.snippetsCancelFocus(commandId)
      }.runOnQueue(Queues.MAIN)

`;
  }
  return `      ${MARKER}
      AsyncFunction("snippetsFocusAtPointAsync") { (view: CameraView, x: Double, y: Double, commandId: Double, promise: Promise) in
        view.snippetsFocusAsync(x: x, y: y, commandId: commandId, promise: promise)
      }.runOnQueue(.main)

      AsyncFunction("snippetsCancelPointFocus") { (view: CameraView, commandId: Double) in
        view.snippetsCancelFocus(commandId: commandId)
      }.runOnQueue(.main)

`;
}

function guardDefaultAutofocus(relativePath, source) {
  if (relativePath.endsWith('CameraViewModule.kt')) {
    const anchor = '      Prop("autoFocus") { view, autoFocus: FocusMode? ->';
    return replaceOnce(source, anchor, anchor + '\n        if (view.snippetsHasManualFocus) return@Prop', relativePath);
  }
  const anchor = '      Prop("autoFocus") { (view, focusMode: FocusMode?) in';
  return replaceOnce(source, anchor, anchor + '\n        guard !view.snippetsHasManualFocus else { return }', relativePath);
}

function replaceLegacyBlock(relativePath, source, legacyMarker, endAnchor, replacement) {
  const indent = relativePath.includes('CameraViewModule.') ? '      ' : '  ';
  const startAnchor = indent + legacyMarker;
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  if (source.split(startAnchor).length !== 2 || start < 0 || end < 0 || source.split(endAnchor).length !== 2) {
    throw new Error(`[camera-focus] Previous focus patch boundary changed in ${relativePath}.`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchCameraSource(relativePath, source, payload) {
  source = source.replace(/\r\n/g, '\n');
  if (source.includes(MARKER)) return source;
  const legacyMarker = LEGACY_MARKERS.find((marker) => source.includes(marker));
  const isAndroidModule = relativePath.endsWith('CameraViewModule.kt');
  const isIosModule = relativePath.endsWith('CameraViewModule.swift');

  if (isAndroidModule || isIosModule) {
    const anchor = isAndroidModule ? '      AsyncFunction("takePicture")' : '      AsyncFunction("takePictureRef")';
    source = legacyMarker
      ? replaceLegacyBlock(relativePath, source, legacyMarker, anchor, bridgeFor(relativePath))
      : replaceOnce(source, anchor, bridgeFor(relativePath) + anchor, relativePath);
    return guardDefaultAutofocus(relativePath, source);
  }
  if (relativePath.endsWith('ExpoCameraView.kt')) {
    const anchor = '  fun cleanupCamera() {';
    if (legacyMarker) {
      return replaceLegacyBlock(relativePath, source, legacyMarker, anchor, payload + '\n');
    }
    source = replaceOnce(source, anchor, payload + '\n' + anchor + '\n    snippetsCancelFocus()', relativePath);
    return replaceOnce(source, '  private var previewView = PreviewView(context).apply {',
      '  private var previewView = PreviewView(context).apply {\n    implementationMode = PreviewView.ImplementationMode.COMPATIBLE', relativePath);
  }
  if (relativePath.endsWith('Current/CameraView.swift')) {
    const anchor = '  func takePictureRef(';
    if (legacyMarker) {
      source = replaceLegacyBlock(relativePath, source, legacyMarker, anchor, payload + '\n');
      const obsolete = '    snippetsFocusRestore?.cancel()\n';
      if (source.includes(obsolete)) source = replaceOnce(source, obsolete, '', relativePath);
      return source;
    }
    source = replaceOnce(source, anchor, payload + '\n' + anchor, relativePath);
    source = replaceOnce(source, '  public override func removeFromSuperview() {',
      '  public override func removeFromSuperview() {\n    snippetsCancelFocus()', relativePath);
    source = replaceOnce(source, '  public func onAppBackgrounded() {',
      '  public func onAppBackgrounded() {\n    snippetsCancelFocus()', relativePath);
    return replaceOnce(source, '  deinit {',
      '  deinit {\n    snippetsFocusObservation?.invalidate()\n    snippetsFocusTimeout?.cancel()\n    snippetsFocusPromise?.resolve(["status": "cancelled"])', relativePath);
  }
  throw new Error(`[camera-focus] Unexpected native file: ${relativePath}`);
}

async function applyCameraFocus(projectRoot, platform) {
  const packagePath = require.resolve('expo-camera/package.json', { paths: [projectRoot] });
  const cameraRoot = path.dirname(packagePath);
  const cameraPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (!/^58\./.test(cameraPackage.version)) {
    throw new Error('[camera-focus] This extension supports expo-camera 58. Review it before upgrading the camera SDK.');
  }
  const wrapper = await fs.readFile(path.join(cameraRoot, 'src/CameraView.tsx'), 'utf8');
  if (!wrapper.includes('_cameraRef = createRef') || !wrapper.includes('ref={this._cameraRef}')) {
    throw new Error('[camera-focus] Expo Camera native ref changed. Review the focus adapter before building.');
  }
  const relativeFiles = platform === 'android'
    ? ['android/src/main/java/expo/modules/camera/CameraViewModule.kt', 'android/src/main/java/expo/modules/camera/ExpoCameraView.kt']
    : ['ios/CameraViewModule.swift', 'ios/Current/CameraView.swift'];
  const payload = await fs.readFile(path.join(__dirname, 'camera-focus',
    platform === 'android' ? 'CameraFocus.android.kt.inc' : 'CameraFocus.ios.swift.inc'), 'utf8');
  const changes = await Promise.all(relativeFiles.map(async (relativeFile) => {
    const target = path.join(cameraRoot, relativeFile);
    const original = await fs.readFile(target, 'utf8');
    return { target, original, updated: patchCameraSource(relativeFile, original, payload) };
  }));
  for (const change of changes) {
    if (change.updated !== change.original) await fs.writeFile(change.target, change.updated, 'utf8');
  }
}

function withCameraFocus(config) {
  for (const platform of ['android', 'ios']) {
    config = withDangerousMod(config, [platform, async (mod) => {
      if (!mod.modRequest.introspect) await applyCameraFocus(mod.modRequest.projectRoot, platform);
      return mod;
    }]);
  }
  return config;
}

module.exports = withCameraFocus;
module.exports.patchCameraSource = patchCameraSource;
