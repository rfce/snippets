const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const EXPO_GL_RULES = `

# expo-gl is used for the headless image-processing context. R8 can otherwise
# strip the native GL classes in release/preview builds, causing a native crash
# as soon as crop or document enhancement starts.
-keep class expo.modules.gl.** { *; }
`;

const DEFAULT_PREVIEW_ANDROID_ABI = 'arm64-v8a';
const ALL_PREVIEW_ANDROID_ABIS = [
  'arm64-v8a',
  'armeabi-v7a',
  'x86',
  'x86_64',
];
const PREVIEW_ANDROID_ABIS = new Set([...ALL_PREVIEW_ANDROID_ABIS, 'universe']);

function readEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) return null;

  const contents = fs.readFileSync(filePath, 'utf8');
  const line = contents.split(/\r?\n/).find((entry) => {
    return new RegExp(`^\\s*${key}\\s*=`).test(entry);
  });

  if (!line) return null;

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function getPreviewAndroidAbi(projectRoot) {
  const envValue =
    process.env.SNIPPETS_PREVIEW_ANDROID_ABI ??
    readEnvFileValue(path.join(projectRoot, '.env'), 'SNIPPETS_PREVIEW_ANDROID_ABI');

  return PREVIEW_ANDROID_ABIS.has(envValue) ? envValue : DEFAULT_PREVIEW_ANDROID_ABI;
}

function withPreviewAndroidArchitecture(config) {
  if (process.env.EAS_BUILD_PROFILE !== 'preview') return config;

  return withDangerousMod(config, [
    'android',
    async (config) => {
      const gradlePropertiesPath = path.join(
        config.modRequest.platformProjectRoot,
        'gradle.properties'
      );
      const previewAndroidAbi = getPreviewAndroidAbi(config.modRequest.projectRoot);
      const previewAndroidArchitectures = previewAndroidAbi === 'universe'
        ? ALL_PREVIEW_ANDROID_ABIS.join(',')
        : previewAndroidAbi;
      const existingProperties = fs.existsSync(gradlePropertiesPath)
        ? fs.readFileSync(gradlePropertiesPath, 'utf8')
        : '';
      const architectureLine = `reactNativeArchitectures=${previewAndroidArchitectures}`;
      const architecturePattern = /^reactNativeArchitectures=.*$/m;
      const nextProperties = architecturePattern.test(existingProperties)
        ? existingProperties.replace(architecturePattern, architectureLine)
        : `${existingProperties.trimEnd()}\n${architectureLine}\n`;

      if (nextProperties !== existingProperties) {
        fs.writeFileSync(gradlePropertiesPath, nextProperties);
      }

      return config;
    },
  ]);
}

function withSingleTaskMainActivity(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    const activities = application?.activity ?? [];
    const mainActivity = activities.find((activity) => {
      const name = activity.$?.['android:name'] ?? '';
      const hasMainLauncherIntent = (activity['intent-filter'] ?? []).some((intentFilter) => {
        const actions = intentFilter.action ?? [];
        const categories = intentFilter.category ?? [];
        const hasMainAction = actions.some((action) => action.$?.['android:name'] === 'android.intent.action.MAIN');
        const hasLauncherCategory = categories.some(
          (category) => category.$?.['android:name'] === 'android.intent.category.LAUNCHER'
        );
        return hasMainAction && hasLauncherCategory;
      });

      return name.endsWith('.MainActivity') || hasMainLauncherIntent;
    });

    if (mainActivity) {
      mainActivity.$ = {
        ...mainActivity.$,
        'android:launchMode': 'singleTask',
      };
    }

    return config;
  });
}

module.exports = function withExpoGlReleaseRules(config) {
  config = withSingleTaskMainActivity(config);
  config = withPreviewAndroidArchitecture(config);

  return withDangerousMod(config, [
    'android',
    async (config) => {
      const proguardPath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro'
      );
      const existingRules = fs.existsSync(proguardPath)
        ? fs.readFileSync(proguardPath, 'utf8')
        : '';

      if (!existingRules.includes('expo.modules.gl.**')) {
        fs.mkdirSync(path.dirname(proguardPath), { recursive: true });
        fs.writeFileSync(proguardPath, `${existingRules}${EXPO_GL_RULES}`);
      }

      return config;
    },
  ]);
};
