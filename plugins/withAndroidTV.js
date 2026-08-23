/**
 * Expo config plugin — ilovani Android TV (Leanback) uchun ham
 * ishga tushiriladigan qilib qo'yadi.
 *
 * Standart Expo managed loyihada Android TV'ning "Kanallar/Ilovalar"
 * ekranida ilova ikonkasi umuman ko'rinmaydi, chunki AndroidManifest.xml'da
 * kerakli <uses-feature> va LEANBACK_LAUNCHER intent-filter yo'q.
 * Bu plugin `expo prebuild` bosqichida shu yozuvlarni avtomatik qo'shadi.
 *
 * Ishlatish: app.json -> "plugins" ro'yxatiga "./plugins/withAndroidTV.js"
 * qo'shilgan (allaqachon qo'shilgan).
 */
const { withAndroidManifest } = require("expo/config-plugins");

function withAndroidTV(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application[0];

    // 1) Sensortik ekran SHART EMASLIGINI bildiramiz (TV'da barmoq ekrani yo'q)
    manifest.manifest["uses-feature"] = manifest.manifest["uses-feature"] || [];
    const hasTouchscreenFeature = manifest.manifest["uses-feature"].some(
      (f) => f.$["android:name"] === "android.hardware.touchscreen"
    );
    if (!hasTouchscreenFeature) {
      manifest.manifest["uses-feature"].push({
        $: { "android:name": "android.hardware.touchscreen", "android:required": "false" },
      });
    }

    // 2) Leanback (TV interfeysi) qo'llab-quvvatlanishini bildiramiz
    const hasLeanback = manifest.manifest["uses-feature"].some(
      (f) => f.$["android:name"] === "android.software.leanback"
    );
    if (!hasLeanback) {
      manifest.manifest["uses-feature"].push({
        $: { "android:name": "android.software.leanback", "android:required": "false" },
      });
    }

    // 3) Asosiy Activity'ga LEANBACK_LAUNCHER intent-filter qo'shamiz —
    //    shu bo'lmasa, ilova Android TV'ning "Ilovalar" qatorida chiqmaydi.
    const mainActivity = application.activity.find(
      (a) =>
        a["intent-filter"] &&
        a["intent-filter"].some((f) =>
          f.action?.some((act) => act.$["android:name"] === "android.intent.action.MAIN")
        )
    );

    if (mainActivity) {
      const filter = mainActivity["intent-filter"].find((f) =>
        f.action?.some((act) => act.$["android:name"] === "android.intent.action.MAIN")
      );
      const hasLeanbackCategory = filter.category?.some(
        (c) => c.$["android:name"] === "android.intent.category.LEANBACK_LAUNCHER"
      );
      if (!hasLeanbackCategory) {
        filter.category = filter.category || [];
        filter.category.push({
          $: { "android:name": "android.intent.category.LEANBACK_LAUNCHER" },
        });
      }
      // TV pult bilan boshqarishda fokus/navigatsiya to'g'ri ishlashi uchun
      mainActivity.$["android:screenOrientation"] = "unspecified";
    }

    // 4) Banner rasm — Android TV bosh ekranida ilova uchun (odatdagi
    //    ikonka o'rniga) katta afisha ko'rsatiladi. mipmap resurs
    //    mavjud bo'lmasa, tizim standart ikonkani ishlatib qo'yaveradi,
    //    shuning uchun bu qator xavfsiz.
    application.$["android:banner"] = "@mipmap/ic_launcher";

    return config;
  });
}

module.exports = withAndroidTV;
