const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const EXPO_GL_RULES = `

# expo-gl is used for the headless image-processing context. R8 can otherwise
# strip the native GL classes in release/preview builds, causing a native crash
# as soon as crop or document enhancement starts.
-keep class expo.modules.gl.** { *; }
`;

module.exports = function withExpoGlReleaseRules(config) {
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
