// plugins/withAbiSplit.js
//
// MAQSAD: APK hajmini kamaytirish. react-native-vlc-media-player o'z ichiga
// libVLC'ni 4 xil protsessor arxitekturasi (arm64-v8a, armeabi-v7a, x86,
// x86_64) uchun alohida-alohida qo'shadi — shu sabab APK ~249MB bo'lib
// chiqadi. Zamonaviy telefonlarning deyarli barchasi (99%+) arm64-v8a
// bo'lgani uchun, faqat shu arxitekturani qoldirib, boshqalarini olib
// tashlaymiz — bu hajmni ~4 baravar kamaytiradi.
//
// Bu loyiha "managed" (android/ papkasi repoda saqlanmaydi) bo'lgani
// uchun, build.gradle'ni qo'lda tahrirlab bo'lmaydi — EAS har safar uni
// "prebuild" jarayonida qaytadan yaratadi. Shu sabab bu o'zgarishni
// build.gradle GENERATSIYA QILINGANDA avtomatik qo'shadigan plagin kerak
// (xuddi ./plugins/withAndroidTV.js kabi).
const { withAppBuildGradle } = require('expo/config-plugins');

const SPLIT_BLOCK = `
    splits {
        abi {
            reset()
            enable true
            universalApk false
            include "arm64-v8a"
        }
    }
`;

module.exports = function withAbiSplit(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withAbiSplit faqat Groovy build.gradle bilan ishlaydi');
    }
    // Ikki marta qo'shilib ketmasligi uchun tekshiramiz (masalan qayta prebuild bo'lsa)
    if (config.modResults.contents.includes('universalApk false')) {
      return config;
    }
    // "android {" ochilgan qatordan darhol keyin joylashtiramiz
    config.modResults.contents = config.modResults.contents.replace(
      /android\s*\{/,
      (match) => `${match}\n${SPLIT_BLOCK}`
    );
    return config;
  });
};
