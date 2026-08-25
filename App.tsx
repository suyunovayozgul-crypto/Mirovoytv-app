import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  BackHandler,
  Image,
  Modal,
  Switch,
  ScrollView,
  Dimensions,
  Alert,
  Platform,
  Linking,
  Animated,
  Pressable,
  InteractionManager,
} from 'react-native';
// ═══════════════════════════════════════════════════════════════════════
//  PLEYER: react-native-video (Android'da ExoPlayer, iOS'da AVPlayer)
//
//  ESLATMA (tarix): avval libVLC (react-native-vlc-media-player)
//  ishlatilgan edi, chunki ba'zi eski IPTV serverlar ExoPlayer o'qiy
//  olmaydigan xom formatlar yuborishi mumkin edi. Lekin VLC kutubxonasi
//  APK hajmini ~250MB'ga chiqarib yuborgani va ba'zi qurilmalarda uzoq
//  tomosha qilinganda (apparat dekoder xotira sizishi tufayli) ilovani
//  qulatib qo'ygani sababli — Televizo kabi aksariyat professional IPTV
//  ilovalari ishlatadigan ExoPlayer'ga o'tkazildi (ancha kichik va
//  barqaror). Agar ayrim "nostandart" kanal ochilmay qolsa, shu izohga
//  qaytib, o'sha kanal uchun alohida VLC fallback qo'shish mumkin.
import Video from 'react-native-video';
// Zaxira (fallback) pleyer — ExoPlayer ochira olmagan "nostandart" kanallar
// uchun. Faqat ExoPlayer xato bergan HOLATDA, o'sha bitta kanal uchun
// ishlatiladi — asosiy pleyer hamon Video (ExoPlayer).
import { VLCPlayer } from 'react-native-vlc-media-player';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as KeepAwake from 'expo-keep-awake';
import Focusable from './Focusable';
import {
  fetchEpg,
  getNowNext,
  getFullSchedule,
  matchEpgChannelId,
  serializeEpg,
  deserializeEpg,
  type EpgData,
  type EpgProgram,
} from './epg';

// ═══════════════════════════════════════════════════════════════════════
//  SOZLAMALAR — asosiy manba (agar masofaviy config yuklanmasa, shu
//  ishlatiladi). Masofaviy config orqali buni qayta APK chiqarmasdan
//  o'zgartirish mumkin — pastdagi REMOTE_CONFIG_URL ga qarang.
// ═══════════════════════════════════════════════════════════════════════
// ─── VLC Wrapper — releasePlayer() ni main thread dan ajratadi ──────────────
// VLC ning eng katta muammosi: kanal almashganda yoki komponent o'chirilganda
// libvlc_media_player_release() main thread ni bloklab qo'yadi (vlc_join).
// Bu 5+ soniya davom etib, ANR (Application Not Responding) ga olib keladi.
// Yechim: eski VLC instance ni darhol o'chirish o'rniga, uni ref da saqlab,
// InteractionManager orqali barcha animatsiyalar/interaksiyalar tugagandan
// KEYIN background da release qilamiz.
function SafeVlcPlayer({ source, style, ...props }: any) {
  const vlcRef = useRef<any>(null);
  const prevSourceRef = useRef<any>(null);

  useEffect(() => {
    // Manba o'zgarganda eski playerni background da release qilish
    if (prevSourceRef.current && prevSourceRef.current.uri !== source?.uri) {
      const oldRef = vlcRef.current;
      if (oldRef) {
        InteractionManager.runAfterInteractions(() => {
          try {
            // VLC internal release — main thread ni bloklamaydi
            oldRef.release?.();
          } catch (e) {
            // Xato bo'lsa ham muammo emas — garbage collector o'zi tozalaydi
          }
        });
      }
    }
    prevSourceRef.current = source;
  }, [source?.uri]);

  return (
    <VLCPlayer
      ref={vlcRef}
      source={source}
      style={style}
      {...props}
    />
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const APP_NAME = 'Mirovoy TV';
const APP_VERSION = '2.0.0';
const UNGROUPED_LABEL = 'Boshqa';
const TELEGRAM_URL = 'https://t.me/mirovoytvuz';

// Ko'p IPTV manbalari (masalan oktv.uz kabi) translyatsiyani faqat "haqiqiy
// brauzer/pleyer"dan kelayotganday ko'rinadigan so'rovlarga beradi — aks
// holda 403/vaqt tugashi bilan rad etadi. Shu sabab Televizo kabi ilovalarda
// ochiladigan kanal, sarlavhasiz so'ralganda bizning ilovada ochilmay qoladi.
// Shu yerda har bir translyatsiya so'roviga standart brauzer User-Agent va
// manba domenining o'ziga mos Referer qo'shib yuboramiz.
function buildStreamHeaders(url: string): Record<string, string> {
  let referer = 'https://ru.oktv.uz/';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.host}/`;
  } catch (e) {
    // URL tahlil qilinmasa, standart referer bilan davom etamiz
  }
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: referer,
    Origin: referer.replace(/\/$/, ''),
  };
}

// react-native-video (ExoPlayer) headerlarni to'g'ridan-to'g'ri
// source.headers orqali qabul qiladi. libVLC esa oddiy "headers" obyektini
// qabul qilmaydi — buyruq-qatori uslubidagi initOptions orqali beriladi.
// Faqat VLC zaxira (fallback) rejimida ishlatiladi.
function buildVlcInitOptions(url: string): string[] {
  const headers = buildStreamHeaders(url);
  return [
    `--http-user-agent=${headers['User-Agent']}`,
    `--http-referrer=${headers.Referer}`,
    '--network-caching=1500',
    '--live-caching=1500',
    '--clock-jitter=0',
    '--clock-synchro=0',
  ];
}

// Pleylistdagi "🇺🇿 Telegram" reklama kanallari — bularga bosilganda video
// pleyer o'rniga to'g'ridan-to'g'ri Telegram kanaliga o'tkazamiz.
function isTelegramAdChannel(ch: { group: string }): boolean {
  return ch.group.toLowerCase().includes('telegram');
}

const DEFAULT_PLAYLIST_URL = 'https://ru.oktv.uz/dSelix36.m3u8';

// Masofaviy boshqaruv fayli. Shu havoladagi JSON'ni siz istagan vaqt
// tahrirlab, ilovaning playlist manbasini va e'lonni foydalanuvchilar
// qayta o'rnatmasdan yangilay olasiz.
// GitHub'da "raw" havola shaklida bo'lishi kerak, masalan:
// https://raw.githubusercontent.com/SIZNING_USER/mirovoy-tv-app/main/config.json
const REMOTE_CONFIG_URL =
  'https://raw.githubusercontent.com/suyunovayozgul-crypto/Mirovoytv-app/main/config.json';

// ═══════════════════════════════════════════════════════════════════════
//  TARJIMALAR (o'zbekcha / ruscha)
// ═══════════════════════════════════════════════════════════════════════
type Lang = 'uz' | 'ru';

const STRINGS: Record<Lang, Record<string, string>> = {
  uz: {
    channels: 'Kanallar',
    search: 'Qidiruv',
    favorites: 'Sevimli',
    settings: 'Sozlama',
    loading: 'Kanallar yuklanmoqda...',
    loadError: 'Yuklab bo\u2018lmadi',
    retry: 'Qayta urinish',
    channelsCount: 'ta kanal',
    categoriesCount: 'ta kategoriya',
    searchPlaceholder: 'Kanal yoki kategoriya qidirish...',
    searchEmpty: 'Hech narsa topilmadi',
    searchHint: 'Kanal nomini yozing',
    favoritesEmpty: 'Hali sevimli kanal qo\u2018shmagansiz. Kanal ustidagi yulduzchani bosing.',
    emptyGroup: 'Bu yerda hech narsa yo\u2018q',
    playlist: 'Pleylist',
    totalChannels: 'Jami kanallar',
    totalCategories: 'Jami kategoriyalar',
    lastSync: 'Oxirgi yangilanish',
    neverSynced: 'Hali yangilanmagan',
    refreshNow: 'Pleylistni hozir yangilash',
    playlistSource: 'Pleylist manbasi',
    appearance: 'Ko\u2018rinish',
    gridColumns: 'Ustunlar soni (grid)',
    showLogos: 'Kanal logotiplarini ko\u2018rsatish',
    language: 'Til',
    favoritesSection: 'Sevimlilar',
    saveFavorites: 'Sevimlilarni saqlash',
    clearFavorites: 'Sevimlilarni tozalash',
    clearFavoritesConfirmTitle: 'Sevimlilarni tozalash',
    clearFavoritesConfirmMsg: 'Hammasi o\u2018chirilsinmi?',
    cancel: 'Bekor qilish',
    delete: 'O\u2018chirish',
    parental: 'Ota-ona nazorati',
    pinProtect: 'PIN bilan himoyalash',
    changePin: 'PIN kodni o\u2018zgartirish',
    lockedCategories: 'Qulflangan kategoriyalar',
    aboutApp: 'Ilova haqida',
    version: 'Versiya',
    website: 'Sayt',
    telegram: 'Telegram',
    aboutNote: 'Muammo yoki taklif bo\u2018lsa \u2014 Telegram kanalimizga yozing.',
    lockedTitle: 'Bu kategoriya qulflangan',
    lockedSubtitle: 'Kirish uchun PIN kodni kiriting',
    confirm: 'Tasdiqlash',
    wrongPin: 'Xato PIN',
    wrongPinMsg: 'Kod noto\u2018g\u2018ri kiritildi, qayta urinib ko\u2018ring.',
    setPinTitle: 'Yangi PIN kod o\u2018rnating',
    save: 'Saqlash',
    tooShort: 'Juda qisqa',
    tooShortMsg: 'Kamida 4 ta raqam kiriting.',
    channelNotReady: 'Bu kanal hozircha ochilmadi.',
    back: 'Orqaga',
    nextChannel: 'Keyingi',
    prevChannel: 'Oldingi',
    done: 'Tayyor',
    recentlyWatched: 'Yaqinda ko\u2018rilgan',
    epgGuide: 'Dastur jadvali',
    epgNoData: 'Bu kanal uchun dastur jadvali topilmadi',
    epgNow: 'Hozir',
    epgNext: 'Keyingi',
  },
  ru: {
    channels: '\u041a\u0430\u043d\u0430\u043b\u044b',
    search: '\u041f\u043e\u0438\u0441\u043a',
    favorites: '\u0418\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435',
    settings: '\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',
    loading: '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u043a\u0430\u043d\u0430\u043b\u043e\u0432...',
    loadError: '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c',
    retry: '\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c',
    channelsCount: '\u043a\u0430\u043d\u0430\u043b\u043e\u0432',
    categoriesCount: '\u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0439',
    searchPlaceholder: '\u041f\u043e\u0438\u0441\u043a \u043a\u0430\u043d\u0430\u043b\u0430 \u0438\u043b\u0438 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438...',
    searchEmpty: '\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e',
    searchHint: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043a\u0430\u043d\u0430\u043b\u0430',
    favoritesEmpty: '\u0412\u044b \u0435\u0449\u0451 \u043d\u0435 \u0434\u043e\u0431\u0430\u0432\u0438\u043b\u0438 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u044b\u0435 \u043a\u0430\u043d\u0430\u043b\u044b. \u041d\u0430\u0436\u043c\u0438\u0442\u0435 \u043d\u0430 \u0437\u0432\u0451\u0437\u0434\u043e\u0447\u043a\u0443 \u043d\u0430 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435 \u043a\u0430\u043d\u0430\u043b\u0430.',
    emptyGroup: '\u0417\u0434\u0435\u0441\u044c \u043f\u0443\u0441\u0442\u043e',
    playlist: '\u041f\u043b\u0435\u0439\u043b\u0438\u0441\u0442',
    totalChannels: '\u0412\u0441\u0435\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u043e\u0432',
    totalCategories: '\u0412\u0441\u0435\u0433\u043e \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0439',
    lastSync: '\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435',
    neverSynced: '\u0415\u0449\u0451 \u043d\u0435 \u043e\u0431\u043d\u043e\u0432\u043b\u044f\u043b\u043e\u0441\u044c',
    refreshNow: '\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043f\u043b\u0435\u0439\u043b\u0438\u0441\u0442 \u0441\u0435\u0439\u0447\u0430\u0441',
    playlistSource: '\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a \u043f\u043b\u0435\u0439\u043b\u0438\u0441\u0442\u0430',
    appearance: '\u0412\u043d\u0435\u0448\u043d\u0438\u0439 \u0432\u0438\u0434',
    gridColumns: '\u041a\u043e\u043b\u043e\u043d\u043a\u0438 \u0441\u0435\u0442\u043a\u0438',
    showLogos: '\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u043b\u043e\u0433\u043e\u0442\u0438\u043f\u044b \u043a\u0430\u043d\u0430\u043b\u043e\u0432',
    language: '\u042f\u0437\u044b\u043a',
    favoritesSection: '\u0418\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435',
    saveFavorites: '\u0421\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u044c \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435',
    clearFavorites: '\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435',
    clearFavoritesConfirmTitle: '\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435',
    clearFavoritesConfirmMsg: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0432\u0441\u0451?',
    cancel: '\u041e\u0442\u043c\u0435\u043d\u0430',
    delete: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c',
    parental: '\u0420\u043e\u0434\u0438\u0442\u0435\u043b\u044c\u0441\u043a\u0438\u0439 \u043a\u043e\u043d\u0442\u0440\u043e\u043b\u044c',
    pinProtect: '\u0417\u0430\u0449\u0438\u0442\u0430 PIN-\u043a\u043e\u0434\u043e\u043c',
    changePin: '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c PIN-\u043a\u043e\u0434',
    lockedCategories: '\u0417\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0435 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438',
    aboutApp: '\u041e\u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0438',
    version: '\u0412\u0435\u0440\u0441\u0438\u044f',
    website: '\u0421\u0430\u0439\u0442',
    telegram: 'Telegram',
    aboutNote: '\u0415\u0441\u043b\u0438 \u0435\u0441\u0442\u044c \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u0430 \u0438\u043b\u0438 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u0435 \u2014 \u043d\u0430\u043f\u0438\u0448\u0438\u0442\u0435 \u043d\u0430\u043c \u0432 Telegram.',
    lockedTitle: '\u042d\u0442\u0430 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u0430',
    lockedSubtitle: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 PIN-\u043a\u043e\u0434 \u0434\u043b\u044f \u0432\u0445\u043e\u0434\u0430',
    confirm: '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c',
    wrongPin: '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 PIN',
    wrongPinMsg: '\u041a\u043e\u0434 \u0432\u0432\u0435\u0434\u0451\u043d \u043d\u0435\u0432\u0435\u0440\u043d\u043e, \u043f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0441\u043d\u043e\u0432\u0430.',
    setPinTitle: '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 \u043d\u043e\u0432\u044b\u0439 PIN-\u043a\u043e\u0434',
    save: '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c',
    tooShort: '\u0421\u043b\u0438\u0448\u043a\u043e\u043c \u043a\u043e\u0440\u043e\u0442\u043a\u043e',
    tooShortMsg: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043c\u0438\u043d\u0438\u043c\u0443\u043c 4 \u0446\u0438\u0444\u0440\u044b.',
    channelNotReady: '\u042d\u0442\u043e\u0442 \u043a\u0430\u043d\u0430\u043b \u043f\u043e\u043a\u0430 \u043d\u0435 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442\u0441\u044f.',
    back: '\u041d\u0430\u0437\u0430\u0434',
    nextChannel: '\u0421\u043b\u0435\u0434.',
    prevChannel: '\u041f\u0440\u0435\u0434.',
    done: '\u0413\u043e\u0442\u043e\u0432\u043e',
    recentlyWatched: '\u041d\u0435\u0434\u0430\u0432\u043d\u043e \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u043d\u044b\u0435',
    epgGuide: '\u0422\u0415\u041b\u0415\u041f\u0420\u041e\u0413\u0420\u0410\u041c\u041c\u0410',
    epgNoData: '\u0414\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u0430 \u043d\u0435\u0442 \u0442\u0435\u043b\u0435\u043f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u044b',
    epgNow: '\u0421\u0435\u0439\u0447\u0430\u0441',
    epgNext: '\u0414\u0430\u043b\u0435\u0435',
  },
};


// ═══════════════════════════════════════════════════════════════════════
//  TIPLAR
// ═══════════════════════════════════════════════════════════════════════
type Channel = {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
  tvgId?: string;
};

type PlaylistSource = { name: string; url: string };

type RemoteConfig = {
  playlists?: PlaylistSource[];
  announcement?: string;
  // EPG (dastur jadvali) manbasini QAYTA BUILD QILMASDAN almashtirish
  // uchun — shu yerga havola qo'yilsa, epg.ts'dagi standart EPG_URL
  // o'rniga shu ishlatiladi.
  epgUrl?: string;
};

type Screen = 'categories' | 'channels' | 'search' | 'favorites' | 'settings';

type AppSettings = {
  gridColumns: number;
  showLogos: boolean;
  autoRefreshHours: number;
  parentalPinEnabled: boolean;
  parentalPin: string;
  lockedGroups: string[];
  saveHistory: boolean;
  language: Lang;
};

const DEFAULT_SETTINGS: AppSettings = {
  gridColumns: 2,
  showLogos: true,
  autoRefreshHours: 12,
  parentalPinEnabled: false,
  parentalPin: '',
  lockedGroups: [],
  saveHistory: true,
  language: 'uz',
};

// ═══════════════════════════════════════════════════════════════════════
//  YORDAMCHI FUNKSIYALAR
// ═══════════════════════════════════════════════════════════════════════

// Oddiy, mustahkam M3U parser — #EXTINF qatoridan group-title, tvg-logo
// va nomni, undan keyingi bo'sh bo'lmagan qatordan URL manzilini oladi.
// JS ipini bloklamaslik uchun bitta event-loop navbatini bo'shatadi
// (epg.ts'dagi xuddi shu, sinovdan o'tgan usul).
// EPG manbasi (masalan iptvx.one) ODATDA butun mintaqadagi minglab
// kanal uchun ma'lumot beradi — bizga esa faqat OʻZ pleylistimizdagi
// kanallarga tegishli qismi kerak. Keraksiz qismini tashlab yuborish
// keshni (va JSON.parse vaqtini) sezilarli kichraytiradi — aks holda
// katta massivni qayta o'qish JS ipini bir necha soniyaga bloklab,
// ilovani "muzlatib" qo'yishi mumkin edi.
function trimEpgToChannels(epg: EpgData, channels: Channel[]): EpgData {
  const neededIds = new Set<string>();
  for (const ch of channels) {
    const id = matchEpgChannelId(epg, ch);
    if (id) neededIds.add(id);
  }
  const trimmedPrograms = new Map<string, EpgProgram[]>();
  for (const id of neededIds) {
    const list = epg.programsById.get(id);
    if (list) trimmedPrograms.set(id, list);
  }
  const trimmedNameToId = new Map<string, string>();
  for (const [name, id] of epg.nameToId.entries()) {
    if (neededIds.has(id)) trimmedNameToId.set(name, id);
  }
  return { programsById: trimmedPrograms, nameToId: trimmedNameToId };
}

function yieldToJs(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// To'liq URL asosida barqaror, GLOBAL DARAJADA UNIKAL identifikator.
// (Avvalgi `${idx}-${line.slice(-24)}` usulida bir nechta pleylist
// birlashtirilganda ikkita kanal bir xil ID olib qolishi mumkin edi —
// har bir parseM3U/parseM3UChunked chaqiruvi idx'ni 0'dan boshlaydi.
// Bu esa FlatList'da "duplicate key" holatiga, g'alati render va
// ba'zan qotishga sabab bo'lardi. Endi butun URL bo'yicha hash
// olinadi — amalda to'qnashuv ehtimoli yo'q.)
function hashId(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

async function parseM3UChunked(text: string, onProgress?: (count: number) => void): Promise<Channel[]> {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let pendingName = '';
  let pendingGroup = '';
  let pendingLogo = '';
  let pendingTvgId = '';
  let idx = 0;
  const CHUNK_SIZE = 500;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch?.[1]?.trim() || UNGROUPED_LABEL;
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      pendingLogo = logoMatch?.[1]?.trim() || '';
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      pendingTvgId = idMatch?.[1]?.trim() || '';
      const afterComma = line.split(',').slice(1).join(',').trim();
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      pendingName = afterComma || nameMatch?.[1]?.trim() || `Kanal ${idx + 1}`;
      continue;
    }
    if (line.startsWith('#')) continue;

    idx += 1;
    channels.push({
      id: hashId(line),
      name: pendingName || `Kanal ${idx}`,
      url: line,
      group: pendingGroup || UNGROUPED_LABEL,
      logo: pendingLogo || undefined,
      tvgId: pendingTvgId || undefined,
    });
    pendingName = '';
    pendingGroup = '';
    pendingLogo = '';
    pendingTvgId = '';

    if (idx % CHUNK_SIZE === 0) {
      onProgress?.(idx);
      await yieldToJs();
    }
  }
  onProgress?.(idx);
  return channels;
}

function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let pendingName = '';
  let pendingGroup = '';
  let pendingLogo = '';
  let pendingTvgId = '';
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch?.[1]?.trim() || UNGROUPED_LABEL;
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      pendingLogo = logoMatch?.[1]?.trim() || '';
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      pendingTvgId = idMatch?.[1]?.trim() || '';
      const afterComma = line.split(',').slice(1).join(',').trim();
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      pendingName = afterComma || nameMatch?.[1]?.trim() || `Kanal ${idx + 1}`;
      continue;
    }
    if (line.startsWith('#')) continue;

    idx += 1;
    channels.push({
      id: hashId(line),
      name: pendingName || `Kanal ${idx}`,
      url: line,
      group: pendingGroup || UNGROUPED_LABEL,
      logo: pendingLogo || undefined,
      tvgId: pendingTvgId || undefined,
    });
    pendingName = '';
    pendingGroup = '';
    pendingLogo = '';
    pendingTvgId = '';
  }
  return channels;
}

async function mergePlaylistsChunked(
  texts: string[],
  onProgress?: (count: number) => void
): Promise<Channel[]> {
  const all: Channel[] = [];
  const seen = new Set<string>();
  let runningCount = 0;
  for (const text of texts) {
    const parsed = await parseM3UChunked(text, (c) => onProgress?.(runningCount + c));
    runningCount += parsed.length;
    for (const ch of parsed) {
      if (seen.has(ch.url)) continue;
      seen.add(ch.url);
      all.push(ch);
    }
  }
  return all;
}

function mergePlaylists(texts: string[]): Channel[] {
  const all: Channel[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const ch of parseM3U(text)) {
      if (seen.has(ch.url)) continue;
      seen.add(ch.url);
      all.push(ch);
    }
  }
  return all;
}

function initials(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ═══════════════════════════════════════════════════════════════════════
//  ASOSIY KOMPONENT
// ═══════════════════════════════════════════════════════════════════════
function AppInner() {
  const [channels, setChannels] = useState<Channel[]>([]);
  // EPG'ni kesish (trim) uchun eng so'nggi kanallar ro'yxatiga ishora —
  // buni oddiy holat (state) sifatida bog'liqlikka qo'ysak, kanal
  // ro'yxati yangilanganda EPG ham keraksiz qayta-qayta yuklanib ketardi.
  const channelsRef = useRef<Channel[]>([]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // Birinchi (kesh yo'q) yuklanishda foydalanuvchiga aniq raqam
  // ko'rsatish uchun — "0" bo'lsa hali tahlil boshlanmagan (yuklab
  // olinmoqda) degani.
  const [loadProgress, setLoadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);

  const [screen, setScreen] = useState<Screen>('categories');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Qidiruv 250ms "debounce" bilan ishlaydi — har bosilgan harfda
  // minglab kanalni qayta filtrlash o'rniga, foydalanuvchi yozishni
  // bir zum to'xtatgandagina filtrlanadi (sekin qurilmalarda terish
  // paytidagi "sekinlashish" hissini yo'qotadi).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [activeChannelList, setActiveChannelList] = useState<Channel[]>([]);

  // ── Kanal ochilganda avtomatik GORIZONTAL (fullscreen), yopilganda
  //    VERTIKALga qaytadi — haqiqiy IPTV pleyer kabi. ────────────────
  useEffect(() => {
    (async () => {
      try {
        if (activeChannel) {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
        } else {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        }
      } catch (e) {
        // ba'zi qurilmalarda (masalan planshet) cheklov ishlamasligi mumkin — muammo emas
      }
    })();
  }, [activeChannel]);

  // Pleyer ochiq bo'lganida ekran o'chib/qulflanib qolmasin (TV
  // tomosha qilayotganda ekran uxlab qolishi yomon tajriba bo'lardi —
  // Televizo kabi ilovalar ham shunday qiladi).
  useEffect(() => {
    if (activeChannel) {
      KeepAwake.activateKeepAwakeAsync?.().catch(() => {});
    } else {
      KeepAwake.deactivateKeepAwake?.().catch(() => {});
    }
    return () => {
      KeepAwake.deactivateKeepAwake?.().catch(() => {});
    };
  }, [activeChannel]);

  const [playerError, setPlayerError] = useState(false);
  const [playerLoading, setPlayerLoading] = useState(true);
  // Qaysi pleyer motori ishlatilyapti — 'exo' (ExoPlayer, asosiy, tezroq)
  // yoki 'vlc' (zaxira, ExoPlayer ocholmagan "nostandart" kanallar uchun)
  const [playerEngine, setPlayerEngine] = useState<'exo' | 'vlc'>('exo');
  const [epgModalVisible, setEpgModalVisible] = useState(false);
  // Video o'ynab turgan paytda, ekrandan chiqmasdan boshqa kanalga
  // o'tish uchun kanallar ro'yxati overlay'i (mustaqil, alohida holat —
  // mavjud epgModalVisible bilan aralashmaydi)
  const [channelSwitcherVisible, setChannelSwitcherVisible] = useState(false);
  // react-native-video'da ham expo-av'dagi kabi videoRef.current.loadAsync()
  // metodi yo'q — qayta yuklash uchun butun komponentni "key" orqali
  // majburiy qayta o'rnatamiz (React'ning standart, ishonchli usuli).
  const [retryKey, setRetryKey] = useState(0);

  // ── Qayta ulanish (retry) va taymout — stream "abadiy aylanib"
  // qolmasligi uchun. Televizo/IPTV Smarters kabi ilovalar ham xato
  // chiqarishdan oldin bir necha marta jimgina qayta urinib ko'radi —
  // ko'p hollarda stream shunchaki sekin ochiladi, xato emas.
  const MAX_AUTO_RETRY = 2;
  const LOAD_TIMEOUT_MS = 15000;
  const retryCountRef = useRef(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ketma-ket avtomatik o'tkazilgan (ishlamagan) kanallar soni — agar
  // butun pleylist yoki internet o'zi ishlamasa, cheksiz "tirillab"
  // aylanib qolmaslik uchun chegara qo'yamiz.
  const autoSkipCountRef = useRef(0);
  const MAX_AUTO_SKIP = 5;

  const clearLoadTimer = useCallback(() => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const armLoadTimer = useCallback(() => {
    clearLoadTimer();
    loadTimeoutRef.current = setTimeout(() => {
      attemptRetryOrFail();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, LOAD_TIMEOUT_MS);
  }, [clearLoadTimer]);

  const attemptRetryOrFail = useCallback(() => {
    if (!activeChannel) return;
    if (retryCountRef.current < MAX_AUTO_RETRY) {
      retryCountRef.current += 1;
      setPlayerLoading(true);
      setPlayerError(false);
      setRetryKey((k) => k + 1); // Pleyerni majburan qayta o'rnatib, oqimni qaytadan ochadi
      armLoadTimer();
    } else if (playerEngine === 'exo') {
      // ExoPlayer bir necha marta urinib ham ocholmadi — bu ko'pincha
      // "nostandart" oqim formati degani (xom MPEG-TS yoki g'ayrioddiy
      // kodek). Shunday hollarda VLC (ichida ffmpeg bor) deyarli hammasini
      // o'qiydi — shu SABABLI, xato ko'rsatishdan oldin, aynan shu bitta
      // kanal uchun VLC'ga o'tib, so'nggi marta urinib ko'ramiz.
      setPlayerEngine('vlc');
      retryCountRef.current = 0;
      setPlayerLoading(true);
      setPlayerError(false);
      setRetryKey((k) => k + 1);
      armLoadTimer();
    } else {
      clearLoadTimer();
      setPlayerLoading(false);
      setPlayerError(true);
    }
  }, [activeChannel, armLoadTimer, clearLoadTimer, playerEngine]);

  // Kanal almashganda — hisoblagichni qaytadan boshlaymiz, taymerni
  // o'rnatamiz va pleyer motorini yana ExoPlayer'ga qaytaramiz (VLC —
  // faqat oldingi kanal uchun tanlangan istisno edi, yangisiga tegishli emas)
  useEffect(() => {
    retryCountRef.current = 0;
    setRetryKey(0);
    setPlayerError(false);
    setPlayerLoading(true);
    setPlayerEngine('exo');
    if (activeChannel) armLoadTimer();
    return () => clearLoadTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel?.url]);

  // Kanal MUVAFFAQIYATLI ochilganda (video haqiqatan ketayotganda) —
  // avtomatik-o'tkazish hisoblagichini nolga tushiramiz, chunki bu safar
  // ketma-ketlik uzildi (yaxshi kanal topildi).
  useEffect(() => {
    if (!playerLoading && !playerError) {
      autoSkipCountRef.current = 0;
    }
  }, [playerLoading, playerError]);

  const manualRetry = useCallback(() => {
    retryCountRef.current = 0;
    attemptRetryOrFail();
  }, [attemptRetryOrFail]);

  const [favorites, setFavorites] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);
  // Bir nechta pleylist manbasi mavjud bo'lsa (config.json'da), foydalanuvchi
  // ularni BIRLASHTIRMASDAN, xohlagan birini tanlab almashtira oladi —
  // Sozlamalar bo'limida. Tanlov xotirada saqlanadi.
  const [activeSourceIndex, setActiveSourceIndexState] = useState(0);
  const activeSourceIndexRef = useRef(0);

  // ── EPG (dastur jadvali) — avval keshdan DARHOL ko'rsatamiz, so'ng
  //    orqa fonda yangisini yuklab, keshni yangilaymiz ─────────────────
  const [epg, setEpg] = useState<EpgData | null>(null);
  const serializeEpg2SafeStore = useCallback((data: EpgData) => {
    try {
      AsyncStorage.setItem('mtv:cachedEpg', serializeEpg(data)).catch(() => {});
    } catch (e) {
      // juda katta bo'lsa yoki JSON xato bersa — jimgina o'tkazib yuboramiz
    }
  }, []);
  const refreshEpg = useCallback(() => {
    fetchEpg(remoteConfig?.epgUrl)
      .then((data) => {
        // Faqat bizning pleylistimizdagi kanallarga tegishli qismini
        // qoldiramiz — manba minglab boshqa kanal ma'lumotini ham
        // yuborishi mumkin, bularning barchasini xotirada/keshda
        // saqlash shart emas. channelsRef orqali o'qiymiz — shu bilan
        // kanal ro'yxati yangilanishi EPG'ni qayta yuklashga majburlamaydi.
        const currentChannels = channelsRef.current;
        const trimmed = currentChannels.length > 0 ? trimEpgToChannels(data, currentChannels) : data;
        setEpg(trimmed);
        // Keyingi ochilishda darhol ko'rsatish uchun saqlaymiz. Endi
        // kichraytirilgani uchun JSON.parse ham tez bo'ladi — ilova
        // "muzlab qolmaydi".
        serializeEpg2SafeStore(trimmed);
      })
      .catch(() => {});
  }, [serializeEpg2SafeStore, remoteConfig?.epgUrl]);
  useEffect(() => {
    (async () => {
      try {
        const rawEpg = await AsyncStorage.getItem('mtv:cachedEpg');
        if (rawEpg) setEpg(deserializeEpg(rawEpg));
      } catch (e) {
        // kesh buzilgan yoki yo'q — muammo emas
      }
      refreshEpg();
    })();
    // Har 6 soatda EPG'ni yangilab turamiz (dastur vaqtlari eskirmasin)
    const iv = setInterval(refreshEpg, 6 * 60 * 60 * 1000);
    return () => clearInterval(iv);
  }, [refreshEpg]);

  // ── Yaqinda ko'rilgan kanallar (Televizo/IPTV Smarters kabi) ────────
  const [recentUrls, setRecentUrls] = useState<string[]>([]);
  useEffect(() => {
    AsyncStorage.getItem('mtv:recent')
      .then((raw) => raw && setRecentUrls(JSON.parse(raw)))
      .catch(() => {});
  }, []);
  const pushRecent = useCallback((url: string) => {
    setRecentUrls((prev) => {
      const next = [url, ...prev.filter((u) => u !== url)].slice(0, 12);
      AsyncStorage.setItem('mtv:recent', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pendingUnlockGroup, setPendingUnlockGroup] = useState<string | null>(null);
  const [unlockedGroups, setUnlockedGroups] = useState<string[]>([]);

  const lang = settings.language;
  const t = useCallback((key: string) => STRINGS[lang]?.[key] ?? STRINGS.uz[key] ?? key, [lang]);

  // ── Boshlang'ich yuklash: sozlamalar, sevimlilar, keyin pleylist ────
  useEffect(() => {
    (async () => {
      try {
        const rawFav = await AsyncStorage.getItem('mtv:favorites');
        if (rawFav) setFavorites(JSON.parse(rawFav));
        const rawSettings = await AsyncStorage.getItem('mtv:settings');
        if (rawSettings) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) });
        const rawSync = await AsyncStorage.getItem('mtv:lastSync');
        if (rawSync) setLastSync(Number(rawSync));
        const rawSourceIdx = await AsyncStorage.getItem('mtv:sourceIndex');
        if (rawSourceIdx) {
          const n = Number(rawSourceIdx);
          activeSourceIndexRef.current = n;
          setActiveSourceIndexState(n);
        }
      } catch (e) {
        // birinchi marta ishga tushganda xotira bo'sh — muammo emas
      }
      // Kesh bo'lsa — DARHOL ko'rsatamiz (kutish yo'q), so'ng orqa fonda
      // jimgina yangi ma'lumotni yuklaymiz. Kesh bo'lmasa — odatdagidek,
      // "Yuklanmoqda" ekrani bilan kutamiz.
      let hasCached = false;
      try {
        const rawCached = await AsyncStorage.getItem('mtv:cachedChannels');
        if (rawCached) {
          const cachedChannels = JSON.parse(rawCached);
          if (Array.isArray(cachedChannels) && cachedChannels.length > 0) {
            setChannels(cachedChannels);
            setStatus('ready');
            hasCached = true;
          }
        }
      } catch (e) {
        // kesh buzilgan bo'lsa — e'tibor bermaymiz, tarmoqdan yuklaymiz
      }
      loadEverything(hasCached);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ── Masofaviy config + pleylist(lar)ni yuklash ───────────────────────
  // silent=true bo'lsa — bu keshdan ko'rsatilgan ma'lumotni orqa fonda
  // yangilash: ekranga "Yuklanmoqda" spinneri chiqmaydi, xato bo'lsa ham
  // eski (kesh) ro'yxat ekranda qolaveradi.
  const loadEverything = useCallback(async (silent: boolean = false) => {
    if (!silent) setStatus('loading');
    setErrorMsg('');
    let cfg: RemoteConfig | null = null;
    try {
      // config.json (GitHub) ba'zan sekin javob berishi mumkin — buni
      // cheksiz kutish o'rniga, 4 soniyadan keyin "topilmadi" deb hisoblab,
      // standart pleylistga o'tamiz. Shu orqali ilova sekin tarmoqda ham
      // tezroq ochiladi (foydalanuvchi behuda kutib qolmaydi).
      const res = await Promise.race([
        fetch(REMOTE_CONFIG_URL, { headers: { 'Cache-Control': 'no-cache' } }),
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      if (res.ok) {
        cfg = await res.json();
        setRemoteConfig(cfg);
      }
    } catch (e) {
      // masofaviy config topilmasa yoki sekin bo'lsa — muammo emas, standart pleylistga o'tamiz
    }

    const allSources: string[] =
      cfg?.playlists && cfg.playlists.length > 0
        ? cfg.playlists.map((p) => p.url)
        : [DEFAULT_PLAYLIST_URL];
    // Bir nechta manba bo'lsa — foydalanuvchi tanlagan BITTASINI ishlatamiz
    // (birlashtirmaymiz). Indeks chegaradan chiqib qolsa (masalan config
    // qisqarib qolgan bo'lsa), xavfsiz tarzda birinchisiga qaytamiz.
    const idx = activeSourceIndexRef.current < allSources.length ? activeSourceIndexRef.current : 0;
    const sources: string[] = [allSources[idx]];

    try {
      setLoadProgress(0);
      // Config-fayl kabi, pleylistning o'zi ham "abadiy kutilmasin" — 20
      // soniyada javob kelmasa, shu manbadan voz kechamiz (validTexts'da
      // bo'sh qatordek qoladi, boshqa manba bo'lsa davom etadi).
      const texts = await Promise.all(
        sources.map((url) =>
          Promise.race([
            fetch(url).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.text();
            }),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 20000)
            ),
          ]).catch(() => '')
        )
      );
      const validTexts = texts.filter((t) => t && t.trim().length > 0);
      if (validTexts.length === 0) throw new Error('Pleylist manbalariga ulanib bo\u2018lmadi');
      const parsed = await mergePlaylistsChunked(validTexts, (c) => {
        if (!silent) setLoadProgress(c);
      });
      if (parsed.length === 0) throw new Error('Pleylist bo\u2018sh');
      setChannels(parsed);
      setStatus('ready');
      const now = Date.now();
      setLastSync(now);
      AsyncStorage.setItem('mtv:lastSync', String(now)).catch(() => {});
      // Keyingi safar ilova DARHOL ochilishi uchun — muvaffaqiyatli
      // yuklangan ro'yxatni xotiraga saqlab qo'yamiz. Fayl katta bo'lsa
      // ham (minglab kanal) bu faqat matn, AsyncStorage bemalol sig'diradi.
      //
      // MUHIM (xato tuzatildi): JSON.stringify(parsed) 3000+ kanal uchun
      // JS oqimini bir zumga BLOKLAYDI. Bu avval setStatus('ready')'dan
      // DARHOL keyin, sinxron tarzda ishga tushar edi — agar foydalanuvchi
      // aynan o'sha payt (birinchi ochilishda, bosh ekran endigina
      // ko'ringanda) biror joyga (masalan Sozlamalarga) bossa, o'sha
      // bosish "muzlab qolgandek" kechikib ishlar edi. Endi bu yozuvni
      // InteractionManager orqali — foydalanuvchining joriy
      // bosishi/o'tishi tugagunicha — kechiktiramiz.
      InteractionManager.runAfterInteractions(() => {
        AsyncStorage.setItem('mtv:cachedChannels', JSON.stringify(parsed)).catch(() => {});
      });
    } catch (e: any) {
      // Jimgina (orqa fondagi) yangilanish muvaffaqiyatsiz bo'lsa — eski
      // (keshdagi) ro'yxat ekranda qolaveradi, foydalanuvchiga xato
      // ko'rsatilmaydi. Faqat ochilishning o'zida (silent=false) xato
      // ekrani chiqadi.
      if (!silent) {
        setErrorMsg(e?.message || 'Nomalum xatolik');
        setStatus('error');
      }
    }
  }, []);

  // Foydalanuvchi Sozlamalar'da boshqa pleylist manbasini tanlaganda —
  // tanlovni saqlaymiz va butun ro'yxatni o'sha manbadan qayta yuklaymiz.
  const selectPlaylistSource = useCallback(
    (index: number) => {
      activeSourceIndexRef.current = index;
      setActiveSourceIndexState(index);
      AsyncStorage.setItem('mtv:sourceIndex', String(index)).catch(() => {});
      loadEverything();
    },
    [loadEverything]
  );

  // ── Orqaga tugmasi: pleyer > ekranlar > chiqish ──────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeChannel) {
        setActiveChannel(null);
        return true;
      }
      if (screen === 'channels') {
        setScreen('categories');
        setActiveGroup(null);
        return true;
      }
      if (screen !== 'categories') {
        setScreen('categories');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [activeChannel, screen]);

  // ── Sevimlilar ────────────────────────────────────────────────────
  const toggleFavorite = useCallback((url: string) => {
    setFavorites((prev) => {
      const next = prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url];
      AsyncStorage.setItem('mtv:favorites', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const saveSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    AsyncStorage.setItem('mtv:settings', JSON.stringify(next)).catch(() => {});
  }, []);

  // ── Kategoriyalar ro'yxati ────────────────────────────────────────
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const ch of channels) {
      map.set(ch.group, (map.get(ch.group) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [channels]);

  // categoryNames — SettingsScreen'ga uzatiladi. Ilgari bu inline
  // `categories.map(...)` sifatida JSX ichida yozilgan edi — ya'ni HAR
  // BIR renderda (parent komponent har safar qayta render bo'lganda)
  // yangi array yaratilib, SettingsScreen'ni keraksiz qayta render
  // qilishga majbur qilardi. Endi categories o'zgarmasa, categoryNames
  // ham qayta hisoblanmaydi.
  const categoryNames = useMemo(() => categories.map((c) => c.name), [categories]);

  const channelsInGroup = useMemo(() => {
    if (!activeGroup) return [];
    return channels.filter((c) => c.group === activeGroup);
  }, [channels, activeGroup]);

  const searchResults = useMemo(() => {
    if (!debouncedSearch.trim()) return [];
    const q = debouncedSearch.trim().toLowerCase();
    return channels.filter(
      (c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [channels, debouncedSearch]);

  const favoriteChannels = useMemo(
    () => channels.filter((c) => favorites.includes(c.url)),
    [channels, favorites]
  );

  const recentChannels = useMemo(() => {
    const byUrl = new Map(channels.map((c) => [c.url, c]));
    return recentUrls.map((u) => byUrl.get(u)).filter(Boolean) as Channel[];
  }, [channels, recentUrls]);

  // ── Kategoriya ochish (ota-ona nazorati bilan) ───────────────────
  const openGroup = (groupName: string) => {
    const isLocked =
      settings.parentalPinEnabled &&
      settings.lockedGroups.includes(groupName) &&
      !unlockedGroups.includes(groupName);
    if (isLocked) {
      setPendingUnlockGroup(groupName);
      setPinInput('');
      setPinModalVisible(true);
      return;
    }
    setActiveGroup(groupName);
    setScreen('channels');
  };

  const confirmPin = () => {
    if (pinInput === settings.parentalPin && pendingUnlockGroup) {
      setUnlockedGroups((prev) => [...prev, pendingUnlockGroup]);
      setActiveGroup(pendingUnlockGroup);
      setScreen('channels');
      setPinModalVisible(false);
    } else {
      Alert.alert('Xato PIN', 'Kod noto\u2018g\u2018ri kiritildi, qayta urinib ko\u2018ring.');
    }
  };

  const openChannel = (ch: Channel, list?: Channel[]) => {
    if (isTelegramAdChannel(ch)) {
      Linking.openURL(TELEGRAM_URL).catch(() => {
        Alert.alert('Xatolik', 'Telegram ilovasini ochib bo\u2018lmadi.');
      });
      return;
    }
    setPlayerError(false);
    setPlayerLoading(true);
    setActiveChannel(ch);
    setActiveChannelList(list && list.length > 0 ? list : [ch]);
    pushRecent(ch.url);
  };

  const switchChannel = useCallback(
    (direction: 1 | -1) => {
      if (!activeChannel || activeChannelList.length === 0) return;
      const idx = activeChannelList.findIndex((c) => c.id === activeChannel.id);
      if (idx === -1) return;
      const nextIdx = (idx + direction + activeChannelList.length) % activeChannelList.length;
      const next = activeChannelList[nextIdx];
      setPlayerError(false);
      setPlayerLoading(true);
      setActiveChannel(next);
    },
    [activeChannel, activeChannelList]
  );

  // Kanal ochilmay qolsa (barcha qayta-urinishlar tugab, playerError
  // true bo'lsa) — foydalanuvchini kutdirmasdan avtomatik keyingi
  // kanalga o'tkazamiz. Faqat MAX_AUTO_SKIP tagacha — aks holda butun
  // pleylist yoki internetning o'zi ishlamasa, foydalanuvchi cheksiz
  // "tirillab" aylanib qolmasin, shunda qo'lda tanlash imkoni
  // (xato oynasi, Qayta urinish/Orqaga tugmalari) ko'rsatiladi.
  useEffect(() => {
    if (!playerError) return;
    if (activeChannelList.length <= 1) return;
    if (autoSkipCountRef.current >= MAX_AUTO_SKIP) return;
    const t = setTimeout(() => {
      autoSkipCountRef.current += 1;
      switchChannel(1);
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerError]);

  // ── Boshqaruv paneli (yuqori panel, oldingi/keyingi tugmalar) —
  // Televizo uslubida: ekranga bir marta bosilganda ko'rinadi/yashiriladi,
  // va harakatsiz qolsa 4 soniyadan keyin o'zi yashirinadi (video to'liq
  // ekranga chiqadi, hech narsa xalaqit bermaydi).
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsFade = useRef(new Animated.Value(1)).current;
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleAutoHide = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 4000);
  }, []);

  useEffect(() => {
    Animated.timing(controlsFade, {
      toValue: controlsVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
    if (controlsVisible) scheduleAutoHide();
    return () => {
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    };
  }, [controlsVisible, controlsFade, scheduleAutoHide]);

  // Kanal almashganda panel qayta ko'rsatilsin (yangi kanal nomi ko'rinishi uchun)
  useEffect(() => {
    setControlsVisible(true);
  }, [activeChannel?.url]);

  const toggleControls = useCallback(() => {
    setControlsVisible((v) => !v);
  }, []);

  // ── Silliq ochilish: video tayyor bo'lgach, uni asta (fade-in) ko'rsatamiz
  // — bunday "qora ekrandan to'satdan sakrash" o'rniga Televizo/YouTube kabi
  // yumshoq o'tish hissi beradi.
  const videoFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(videoFade, {
      toValue: playerLoading ? 0 : 1,
      duration: playerLoading ? 0 : 320,
      useNativeDriver: true,
    }).start();
  }, [playerLoading, videoFade]);

  // ═══════════════════════════════════════════════════════════════════
  //  PLEYER EKRANI — TO'LIQ EKRAN, KEYINGI/OLDINGI KANALGA O'TISH TUGMALARI
  //  BILAN (Televizo-uslubidagi jonli TV pleyeri)
  // ═══════════════════════════════════════════════════════════════════
  if (activeChannel) {
    const canSwitch = activeChannelList.length > 1;
    const playerNowNext = epg ? getNowNext(epg, activeChannel) : { now: null, next: null };
    return (
      <SafeAreaView style={styles.playerRoot}>
        <StatusBar hidden />
        <Pressable style={{ flex: 1 }} onPress={toggleControls}>
          <Animated.View style={{ flex: 1, opacity: videoFade }}>
            {playerEngine === 'vlc' ? (
              <SafeVlcPlayer
                key={`vlc-${activeChannel.url}-${retryKey}`}
                style={styles.video}
                source={{
                  uri: activeChannel.url,
                  initOptions: buildVlcInitOptions(activeChannel.url),
                }}
                resizeMode="contain"
                autoplay
                autoAspectRatio
                onBuffering={() => setPlayerLoading(true)}
                onPlaying={() => {
                  setPlayerLoading(false);
                  clearLoadTimer();
                }}
                onProgress={() => {
                  if (playerLoading) setPlayerLoading(false);
                  clearLoadTimer();
                }}
                onError={() => {
                  attemptRetryOrFail();
                }}
              />
            ) : (
              <Video
                key={`${activeChannel.url}-${retryKey}`}
                style={styles.video}
                source={{
                  uri: activeChannel.url,
                  headers: buildStreamHeaders(activeChannel.url),
                }}
                resizeMode="contain"
                paused={false}
                muted={false}
                // iOS qurilma "jim rejim" (mute switch) holatida bo'lsa
                // ham video ovozi eshitilsin — aks holda foydalanuvchi
                // "ovoz chiqmayapti" deb o'ylashi mumkin.
                ignoreSilentSwitch="ignore"
                playInBackground={false}
                playWhenInactive={false}
                bufferConfig={{
                  // Beqaror IPTV serverlarida "tirsillash/to'xtalish"ni
                  // kamaytirish uchun buferni biroz kattaroq qilamiz —
                  // VLC'dagi network-caching sozlamasining ExoPlayer'dagi muqobili.
                  minBufferMs: 3000,
                  maxBufferMs: 15000,
                  bufferForPlaybackMs: 1500,
                  bufferForPlaybackAfterRebufferMs: 3000,
                  // Jonli (live) translyatsiyada allaqachon ko'rsatilgan
                  // kadrlarni orqada saqlashning hojati yo'q — buni 0 qilish
                  // xotira sarfini kamaytiradi va telefon eskirgan/kuchsiz
                  // bo'lganda ilova sekinlashib/qulab qolish xavfini kamaytiradi.
                  backBufferDurationMs: 0,
                }}
                // iOS: standart holatda pleyer tarmoq "sifatli" bo'lguncha
                // ataylab kutadi (stall'ni kamaytirish uchun) — bu boshlanish
                // tezligini pasaytiradi. Pleylist sog'lom bo'lsa, buni o'chirib,
                // kanal TEZROQ ochilishiga erishamiz.
                automaticallyWaitsToMinimizeStalling={false}
                // Android: apparat (hardware) dekoderni ustuvor qilish —
                // dasturiy dekoderga qaraganda ancha tezroq va kam batareya
                // sarflaydi, kadrlar tashlanishini kamaytiradi.
                useTextureView={false}
                onBuffer={({ isBuffering }) => setPlayerLoading(isBuffering)}
                onLoad={() => {
                  setPlayerLoading(false);
                  clearLoadTimer();
                }}
                onProgress={() => {
                  // Kadrlar kelayotgani — stream tirik, xato/taymer holatini tozalaymiz
                  if (playerLoading) setPlayerLoading(false);
                  clearLoadTimer();
                }}
                onError={() => {
                  // Darhol xato ko'rsatmasdan, avval jimgina qayta urinib ko'ramiz
                  attemptRetryOrFail();
                }}
              />
            )}
          </Animated.View>

          {playerLoading && !playerError && (
            <View style={styles.playerCenterOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#ffffff" />
            </View>
          )}

          {/* Boshqaruv paneli — ekranga bosilganda ko'rinadi/yashiriladi,
              4 soniya harakatsizlikdan keyin o'zi yashiradi. */}
          <Animated.View
            style={[StyleSheet.absoluteFillObject, { opacity: controlsFade }]}
            pointerEvents={controlsVisible ? 'box-none' : 'none'}
          >
            <View style={styles.playerTopBar}>
              <Focusable onPress={() => setActiveChannel(null)} style={styles.backBtn} hitSlop={{top:10,bottom:10,left:10,right:10}} focusStyle={styles.iconBtnFocused}>
                <Ionicons name="chevron-back" size={26} color="#fff" />
              </Focusable>
              {activeChannel.logo ? (
                <Image
                  source={{ uri: activeChannel.logo, headers: buildStreamHeaders(activeChannel.logo) }}
                  style={styles.playerLogo}
                />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={styles.playerTitle} numberOfLines={1}>
                  {activeChannel.name}
                </Text>
                {playerNowNext.now ? (
                  <Text style={styles.playerEpgText} numberOfLines={1}>
                    {t('epgNow')}: {playerNowNext.now.title}
                  </Text>
                ) : null}
              </View>
              {canSwitch && (
                <Focusable
                  onPress={() => setChannelSwitcherVisible(true)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ marginRight: 4 }}
                  focusStyle={styles.iconBtnFocused}
                >
                  <Ionicons name="tv-outline" size={22} color="#fff" />
                </Focusable>
              )}
              <Focusable
                onPress={() => setEpgModalVisible(true)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={{ marginRight: 4 }}
                focusStyle={styles.iconBtnFocused}
              >
                <Ionicons name="list-outline" size={22} color="#fff" />
              </Focusable>
              <Focusable
                onPress={() => toggleFavorite(activeChannel.url)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                focusStyle={styles.iconBtnFocused}
              >
                <Ionicons
                  name={favorites.includes(activeChannel.url) ? 'star' : 'star-outline'}
                  size={24}
                  color={GOLD}
                />
              </Focusable>
            </View>

            {canSwitch && (
              <>
                <Focusable
                  style={[styles.sideNavBtn, { left: 8 }]}
                  onPress={() => switchChannel(-1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  focusStyle={styles.sideNavBtnFocused}
                >
                  <Ionicons name="play-skip-back" size={24} color="#fff" />
                </Focusable>
                <Focusable
                  style={[styles.sideNavBtn, { right: 8 }]}
                  onPress={() => switchChannel(1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  focusStyle={styles.sideNavBtnFocused}
                >
                  <Ionicons name="play-skip-forward" size={24} color="#fff" />
                </Focusable>
              </>
            )}
          </Animated.View>

          {playerError && (
            <View style={styles.playerErrorBox}>
              <Text style={styles.playerErrorText}>
                {t('channelNotReady')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <Focusable
                  style={styles.retryBtnSmall}
                  onPress={manualRetry}
                  hasTVPreferredFocus
                >
                  <Text style={styles.retryBtnText}>{t('retry')}</Text>
                </Focusable>
                <Focusable
                  style={[styles.retryBtnSmall, { backgroundColor: '#334155' }]}
                  onPress={() => setActiveChannel(null)}
                >
                  <Text style={styles.retryBtnText}>{t('back')}</Text>
                </Focusable>
              </View>
            </View>
          )}
        </Pressable>

        <EpgGuideModal
          visible={epgModalVisible}
          onClose={() => setEpgModalVisible(false)}
          channel={activeChannel}
          epg={epg}
          t={t}
        />

        <ChannelSwitcherModal
          visible={channelSwitcherVisible}
          onClose={() => setChannelSwitcherVisible(false)}
          channels={activeChannelList}
          activeChannel={activeChannel}
          epg={epg}
          onSelect={(ch) => {
            setChannelSwitcherVisible(false);
            openChannel(ch, activeChannelList);
          }}
          t={t}
        />
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  ASOSIY EKRAN (tab-lar bilan)
  // ═══════════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0c18" />

      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Image source={require('./assets/adaptive-icon.png')} style={styles.headerLogo} />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>{APP_NAME}</Text>
            <Text style={styles.headerSubtitle}>
              {status === 'ready' ? `${channels.length} ${t('channelsCount')} \u00b7 ${categories.length} ${t('categoriesCount')}` : ' '}
            </Text>
          </View>
        </View>
        {remoteConfig?.announcement ? (
          <View style={styles.announceBox}>
            <Text style={styles.announceText}>{remoteConfig.announcement}</Text>
          </View>
        ) : null}
      </View>

      {status === 'loading' && (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#8b5cf6" />
          <Text style={styles.centerText}>
            {loadProgress > 0 ? `${loadProgress} ${t('channelsCount')}...` : t('loading')}
          </Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centerBox}>
          <Ionicons name="warning-outline" size={32} color="#f59e0b" />
          <Text style={styles.centerText}>{t('loadError')}: {errorMsg}</Text>
          <Focusable onPress={loadEverything} style={styles.retryBtn} hasTVPreferredFocus>
            <Text style={styles.retryBtnText}>{t('retry')}</Text>
          </Focusable>
        </View>
      )}

      {status === 'ready' && screen === 'categories' && (
        <CategoriesScreen
          categories={categories}
          settings={settings}
          onOpen={openGroup}
          t={t}
          recentChannels={recentChannels}
          onOpenChannel={(ch) => openChannel(ch, recentChannels)}
          epg={epg}
        />
      )}

      {status === 'ready' && screen === 'channels' && activeGroup && (
        <ChannelGridScreen
          title={activeGroup}
          channels={channelsInGroup}
          settings={settings}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, channelsInGroup)}
          onBack={() => {
            setScreen('categories');
            setActiveGroup(null);
          }}
          t={t}
          epg={epg}
        />
      )}

      {status === 'ready' && screen === 'search' && (
        <SearchScreen
          search={search}
          setSearch={setSearch}
          results={searchResults}
          settings={settings}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, searchResults)}
          t={t}
          epg={epg}
        />
      )}

      {status === 'ready' && screen === 'favorites' && (
        <ChannelGridScreen
          title={t('favoritesSection')}
          channels={favoriteChannels}
          settings={settings}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, favoriteChannels)}
          emptyText={t('favoritesEmpty')}
          t={t}
          epg={epg}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          onSave={saveSettings}
          lastSync={lastSync}
          onRefresh={loadEverything}
          totalChannels={channels.length}
          totalCategories={categories.length}
          categoryNames={categoryNames}
          playlistSources={remoteConfig?.playlists ?? []}
          activeSourceIndex={activeSourceIndex}
          onSelectSource={selectPlaylistSource}
          t={t}
          onClearFavorites={() => {
            Alert.alert(t('clearFavoritesConfirmTitle'), t('clearFavoritesConfirmMsg'), [
              { text: t('cancel'), style: 'cancel' },
              {
                text: t('delete'),
                style: 'destructive',
                onPress: () => {
                  setFavorites([]);
                  AsyncStorage.setItem('mtv:favorites', JSON.stringify([])).catch(() => {});
                },
              },
            ]);
          }}
        />
      )}

      {/* ── Pastki tab-menyu ────────────────────────────────────────── */}
      <View style={styles.tabBar}>
        <TabButton label={t('channels')} iconName="grid-outline" active={screen === 'categories' || screen === 'channels'} onPress={() => { setScreen('categories'); setActiveGroup(null); }} />
        <TabButton label={t('search')} iconName="search-outline" active={screen === 'search'} onPress={() => setScreen('search')} />
        <TabButton label={t('favorites')} iconName="star-outline" active={screen === 'favorites'} onPress={() => setScreen('favorites')} />
        <TabButton label={t('settings')} iconName="settings-outline" active={screen === 'settings'} onPress={() => setScreen('settings')} />
      </View>

      {/* ── Ota-ona nazorati PIN oynasi ─────────────────────────────── */}
      <Modal visible={pinModalVisible} transparent animationType="fade">
        <View style={styles.pinOverlay}>
          <View style={styles.pinBox}>
            <Text style={styles.pinTitle}>{t('lockedTitle')}</Text>
            <Text style={styles.pinSubtitle}>{t('lockedSubtitle')}</Text>
            <TextInput
              value={pinInput}
              onChangeText={setPinInput}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              style={styles.pinInput}
              placeholder="****"
              placeholderTextColor="#475569"
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity style={[styles.pinBtn, { backgroundColor: '#334155' }]} onPress={() => setPinModalVisible(false)}>
                <Text style={styles.retryBtnText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pinBtn} onPress={confirmPin}>
                <Text style={styles.retryBtnText}>{t('confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  TAB TUGMASI
// ═══════════════════════════════════════════════════════════════════════
function TabButton({ label, iconName, active, onPress }: { label: string; iconName: keyof typeof Ionicons.glyphMap; active: boolean; onPress: () => void }) {
  return (
    <Focusable style={styles.tabBtn} onPress={onPress} focusStyle={styles.tabBtnFocused}>
      <Ionicons name={iconName} size={21} color={active ? ACCENT : '#64748b'} />
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Focusable>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  KATEGORIYALAR EKRANI
// ═══════════════════════════════════════════════════════════════════════
function CategoriesScreen({
  categories,
  settings,
  onOpen,
  t,
  recentChannels,
  onOpenChannel,
  epg,
}: {
  categories: { name: string; count: number }[];
  settings: AppSettings;
  onOpen: (name: string) => void;
  t: (k: string) => string;
  recentChannels: Channel[];
  onOpenChannel: (ch: Channel) => void;
  epg: EpgData | null;
}) {
  return (
    <FlatList
      data={categories}
      keyExtractor={(item) => item.name}
      numColumns={2}
      contentContainerStyle={{ padding: 12, paddingBottom: 90 }}
      columnWrapperStyle={{ gap: 12 }}
      ListHeaderComponent={
        recentChannels.length > 0 ? (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.sectionTitle}>{t('recentlyWatched')}</Text>
            <FlatList
              data={recentChannels}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ gap: 10 }}
              renderItem={({ item, index }) => {
                const nn = epg ? getNowNext(epg, item) : { now: null, next: null };
                return (
                  <Focusable
                    onPress={() => onOpenChannel(item)}
                    hasTVPreferredFocus={index === 0}
                    style={styles.recentCard}
                  >
                    <Text style={styles.recentCardName} numberOfLines={1}>{item.name}</Text>
                    {nn.now ? (
                      <Text style={styles.recentCardProgram} numberOfLines={1}>{nn.now.title}</Text>
                    ) : null}
                  </Focusable>
                );
              }}
            />
          </View>
        ) : null
      }
      renderItem={({ item, index }) => {
        const locked = settings.parentalPinEnabled && settings.lockedGroups.includes(item.name);
        return (
          <Focusable
            style={styles.catCard}
            onPress={() => onOpen(item.name)}
            hasTVPreferredFocus={index === 0 && recentChannels.length === 0}
          >
            <View style={[styles.catIconCircle, { backgroundColor: colorFor(item.name) }]}>
              <Text style={styles.catIconText}>{initials(item.name)}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={styles.catName} numberOfLines={2}>
                {item.name}
              </Text>
              {locked && <Ionicons name="lock-closed" size={12} color="#94a3b8" />}
            </View>
            <Text style={styles.catCount}>{item.count} {t('channelsCount')}</Text>
          </Focusable>
        );
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  KANALLAR GRID EKRANI (kategoriya ichi / sevimlilar)
// ═══════════════════════════════════════════════════════════════════════
function ChannelGridScreen({
  title,
  channels,
  settings,
  favorites,
  onToggleFavorite,
  onOpenChannel,
  onBack,
  emptyText,
  t,
  epg,
}: {
  title: string;
  channels: Channel[];
  settings: AppSettings;
  favorites: string[];
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
  onBack?: () => void;
  emptyText?: string;
  t: (k: string) => string;
  epg?: EpgData | null;
}) {
  const cols = settings.gridColumns;
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subHeader}>
        {onBack && (
          <Focusable onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} focusStyle={styles.iconBtnFocused}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </Focusable>
        )}
        <Text style={styles.subHeaderTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <FlatList
        data={channels}
        key={cols}
        keyExtractor={(item) => item.id}
        numColumns={cols}
        contentContainerStyle={{ padding: 10, paddingBottom: 90 }}
        columnWrapperStyle={cols > 1 ? { gap: 10 } : undefined}
        // Minglab kanalli ro'yxatni silliq aylantirish uchun — bir
        // vaqtning o'zida faqat ekran atrofidagi elementlarni chizamiz,
        // uzoqdagilarni xotiradan chiqarib tashlaymiz.
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item, index }) => (
          <ChannelCard
            channel={item}
            settings={settings}
            isFav={favorites.includes(item.url)}
            onToggleFavorite={() => onToggleFavorite(item.url)}
            onPress={() => onOpenChannel(item)}
            columns={cols}
            epg={epg}
            hasTVPreferredFocus={index === 0}
          />
        )}
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>{emptyText || t('emptyGroup')}</Text>
          </View>
        }
      />
    </View>
  );
}

// React.memo — kanal kartasi faqat o'ziga tegishli prop'lar (masalan
// sevimli holati, EPG) o'zgarganda qayta chiziladi. Ro'yxatda minglab
// karta bo'lganda, boshqa kartalar chizilishi bunga ta'sir qilmaydi —
// aylantirish sezilarli silliqlashadi.
const ChannelCard = React.memo(function ChannelCard({
  channel,
  settings,
  isFav,
  onToggleFavorite,
  onPress,
  columns,
  epg,
  hasTVPreferredFocus,
}: {
  channel: Channel;
  settings: AppSettings;
  isFav: boolean;
  onToggleFavorite: () => void;
  onPress: () => void;
  columns: number;
  epg?: EpgData | null;
  hasTVPreferredFocus?: boolean;
}) {
  const screenW = Dimensions.get('window').width;
  const cardW = (screenW - 10 * 2 - (columns - 1) * 10) / columns;
  const [logoFailed, setLogoFailed] = useState(false);
  const isTgAd = isTelegramAdChannel(channel);
  const showLogo = settings.showLogos && channel.logo && !logoFailed;

  const nowNext = useMemo(
    () => (epg ? getNowNext(epg, channel) : { now: null, next: null }),
    [epg, channel]
  );
  const progressPct = useMemo(() => {
    const p = nowNext.now;
    if (!p) return 0;
    const total = p.stop - p.start;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, ((Date.now() - p.start) / total) * 100));
  }, [nowNext]);

  return (
    <Focusable style={[styles.chCard, { width: cardW }]} onPress={onPress} hasTVPreferredFocus={hasTVPreferredFocus}>
      <View style={styles.chLogoBox}>
        {showLogo ? (
          <Image
            source={{ uri: channel.logo, headers: buildStreamHeaders(channel.logo!) }}
            style={styles.chLogoImg}
            resizeMode="contain"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <View style={[styles.chLogoFallback, { backgroundColor: colorFor(channel.name) }]}>
            <Text style={styles.chLogoFallbackText}>{initials(channel.name)}</Text>
          </View>
        )}
        {isTgAd ? (
          <View style={styles.chTgBadge}>
            <Ionicons name="paper-plane" size={13} color="#fff" />
          </View>
        ) : (
          <TouchableOpacity
            style={styles.chFavBtn}
            onPress={onToggleFavorite}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name={isFav ? 'star' : 'star-outline'} size={17} color={GOLD} />
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.chName} numberOfLines={2}>
        {channel.name}
      </Text>
      {nowNext.now ? (
        <>
          <Text style={styles.chEpgText} numberOfLines={1}>{nowNext.now.title}</Text>
          <View style={styles.chEpgTrack}>
            <View style={[styles.chEpgFill, { width: `${progressPct}%` }]} />
          </View>
        </>
      ) : null}
    </Focusable>
  );
});

// ═══════════════════════════════════════════════════════════════════════
//  QIDIRUV EKRANI
// ═══════════════════════════════════════════════════════════════════════
function SearchScreen({
  search,
  setSearch,
  results,
  settings,
  favorites,
  onToggleFavorite,
  onOpenChannel,
  t,
  epg,
}: {
  search: string;
  setSearch: (s: string) => void;
  results: Channel[];
  settings: AppSettings;
  favorites: string[];
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
  t: (k: string) => string;
  epg?: EpgData | null;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('searchPlaceholder')}
          placeholderTextColor="#64748b"
          style={styles.search}
          autoFocus
        />
      </View>
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        numColumns={settings.gridColumns}
        contentContainerStyle={{ padding: 10, paddingBottom: 90 }}
        columnWrapperStyle={settings.gridColumns > 1 ? { gap: 10 } : undefined}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item }) => (
          <ChannelCard
            channel={item}
            settings={settings}
            isFav={favorites.includes(item.url)}
            onToggleFavorite={() => onToggleFavorite(item.url)}
            onPress={() => onOpenChannel(item)}
            columns={settings.gridColumns}
            epg={epg}
          />
        )}
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>
              {search.trim() ? t('searchEmpty') : t('searchHint')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  SOZLAMALAR EKRANI (~90% - boshqa professional IPTV ilovalaridagidek)
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
//  DASTUR JADVALI (EPG) OYNASI — pleyerdagi ro'yxat tugmasi orqali ochiladi
// ═══════════════════════════════════════════════════════════════════════
// Video o'ynayotgan paytda, ekrandan chiqmasdan, ro'yxatdagi istalgan
// kanalga to'g'ridan-to'g'ri o'tish uchun overlay. EpgGuideModal'dan
// mustaqil — uni o'zgartirmaydi, faqat undan keyin qo'shilgan.
function ChannelSwitcherModal({
  visible,
  onClose,
  channels,
  activeChannel,
  epg,
  onSelect,
  t,
}: {
  visible: boolean;
  onClose: () => void;
  channels: Channel[];
  activeChannel: Channel | null;
  epg: EpgData | null;
  onSelect: (ch: Channel) => void;
  t: (k: string) => string;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.epgOverlay}>
        <View style={styles.epgSheet}>
          <View style={styles.epgSheetHeader}>
            <Text style={styles.epgSheetTitle} numberOfLines={1}>
              {t('channels')}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          <FlatList
            data={channels}
            keyExtractor={(c) => c.id}
            contentContainerStyle={{ paddingBottom: 20 }}
            initialNumToRender={20}
            renderItem={({ item }) => {
              const isActive = activeChannel?.id === item.id;
              const nn = epg ? getNowNext(epg, item) : { now: null, next: null };
              return (
                <TouchableOpacity
                  style={[styles.epgRow, isActive && styles.epgRowActive]}
                  onPress={() => onSelect(item)}
                >
                  {item.logo ? (
                    <Image source={{ uri: item.logo, headers: buildStreamHeaders(item.logo) }} style={{ width: 36, height: 36, borderRadius: 6, marginRight: 10 }} />
                  ) : (
                    <View style={{ width: 36, height: 36, marginRight: 10 }} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.epgRowTitle, isActive && styles.epgRowTimeActive]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {nn.now ? (
                      <Text style={styles.epgRowDesc} numberOfLines={1}>{nn.now.title}</Text>
                    ) : null}
                  </View>
                  {isActive && (
                    <View style={styles.epgLiveBadge}>
                      <Text style={styles.epgLiveBadgeText}>{t('epgNow')}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

function EpgGuideModal({
  visible,
  onClose,
  channel,
  epg,
  t,
}: {
  visible: boolean;
  onClose: () => void;
  channel: Channel | null;
  epg: EpgData | null;
  t: (k: string) => string;
}) {
  const schedule = useMemo(() => {
    if (!channel || !epg) return [];
    return getFullSchedule(epg, channel);
  }, [channel, epg]);

  const now = Date.now();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.epgOverlay}>
        <View style={styles.epgSheet}>
          <View style={styles.epgSheetHeader}>
            <Text style={styles.epgSheetTitle} numberOfLines={1}>
              {t('epgGuide')} — {channel?.name}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          {schedule.length === 0 ? (
            <View style={styles.centerBox}>
              <Text style={styles.centerText}>{t('epgNoData')}</Text>
            </View>
          ) : (
            <FlatList
              data={schedule}
              keyExtractor={(p, i) => `${p.start}-${i}`}
              contentContainerStyle={{ paddingBottom: 20 }}
              renderItem={({ item }) => {
                const isNow = item.start <= now && now < item.stop;
                const timeStr = new Date(item.start).toLocaleTimeString('uz-UZ', {
                  hour: '2-digit',
                  minute: '2-digit',
                });
                return (
                  <View style={[styles.epgRow, isNow && styles.epgRowActive]}>
                    <Text style={[styles.epgRowTime, isNow && styles.epgRowTimeActive]}>{timeStr}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.epgRowTitle} numberOfLines={2}>{item.title}</Text>
                      {item.desc ? (
                        <Text style={styles.epgRowDesc} numberOfLines={2}>{item.desc}</Text>
                      ) : null}
                    </View>
                    {isNow && (
                      <View style={styles.epgLiveBadge}>
                        <Text style={styles.epgLiveBadgeText}>{t('epgNow')}</Text>
                      </View>
                    )}
                  </View>
                );
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function SettingsScreen({
  settings,
  onSave,
  lastSync,
  onRefresh,
  totalChannels,
  totalCategories,
  categoryNames,
  playlistSources,
  activeSourceIndex,
  onSelectSource,
  onClearFavorites,
  t,
}: {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  lastSync: number | null;
  onRefresh: () => void;
  totalChannels: number;
  totalCategories: number;
  categoryNames: string[];
  playlistSources: { name: string; url: string }[];
  activeSourceIndex: number;
  onSelectSource: (index: number) => void;
  onClearFavorites: () => void;
  t: (k: string) => string;
}) {
  const [pinSetupVisible, setPinSetupVisible] = useState(false);
  const [pinValue, setPinValue] = useState(settings.parentalPin);
  const [lockPickerVisible, setLockPickerVisible] = useState(false);

  const update = (patch: Partial<AppSettings>) => onSave({ ...settings, ...patch });

  const lastSyncText = lastSync
    ? new Date(lastSync).toLocaleString(settings.language === 'ru' ? 'ru-RU' : 'uz-UZ')
    : t('neverSynced');

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
      {/* PLEYLIST */}
      <SectionTitle text={t('playlist')} />
      <SettingsRow label={t('totalChannels')} value={`${totalChannels}`} />
      <SettingsRow label={t('totalCategories')} value={`${totalCategories}`} />
      <SettingsRow label={t('lastSync')} value={lastSyncText} />
      <TouchableOpacity style={styles.actionBtn} onPress={onRefresh}>
        <Ionicons name="refresh" size={16} color="#fff" style={{ marginRight: 6 }} />
        <Text style={styles.actionBtnText}>{t('refreshNow')}</Text>
      </TouchableOpacity>

      {playlistSources.length > 1 && (
        <View style={{ marginTop: 14 }}>
          <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 8 }}>
            {t('playlistSource')}
          </Text>
          {playlistSources.map((src, i) => (
            <TouchableOpacity
              key={src.url}
              onPress={() => onSelectSource(i)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 10,
                marginBottom: 8,
                backgroundColor: i === activeSourceIndex ? 'rgba(139,92,246,0.18)' : 'rgba(255,255,255,0.04)',
                borderWidth: i === activeSourceIndex ? 1 : 0,
                borderColor: '#8b5cf6',
              }}
            >
              <Ionicons
                name={i === activeSourceIndex ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={i === activeSourceIndex ? '#8b5cf6' : '#64748b'}
                style={{ marginRight: 10 }}
              />
              <Text style={{ color: '#fff', fontSize: 15 }}>{src.name || `Pleylist ${i + 1}`}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* TIL */}
      <SectionTitle text={t('language')} />
      <SettingsRow label={t('language')}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            style={[styles.langPill, settings.language === 'uz' && styles.langPillActive]}
            onPress={() => update({ language: 'uz' })}
          >
            <Text style={[styles.langPillText, settings.language === 'uz' && styles.langPillTextActive]}>
              O{'\u2018'}zbekcha
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.langPill, settings.language === 'ru' && styles.langPillActive]}
            onPress={() => update({ language: 'ru' })}
          >
            <Text style={[styles.langPillText, settings.language === 'ru' && styles.langPillTextActive]}>
              {'\u0420\u0443\u0441\u0441\u043a\u0438\u0439'}
            </Text>
          </TouchableOpacity>
        </View>
      </SettingsRow>

      {/* KO'RINISH */}
      <SectionTitle text={t('appearance')} />
      <SettingsRow label={t('gridColumns')}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[2, 3, 4].map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.pillBtn, settings.gridColumns === n && styles.pillBtnActive]}
              onPress={() => update({ gridColumns: n })}
            >
              <Text style={[styles.pillBtnText, settings.gridColumns === n && styles.pillBtnTextActive]}>{n}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </SettingsRow>
      <SettingsRow label={t('showLogos')}>
        <Switch
          value={settings.showLogos}
          onValueChange={(v) => update({ showLogos: v })}
          trackColor={{ false: '#334155', true: ACCENT }}
        />
      </SettingsRow>

      {/* SEVIMLILAR VA TARIX */}
      <SectionTitle text={t('favoritesSection')} />
      <SettingsRow label={t('saveFavorites')}>
        <Switch
          value={settings.saveHistory}
          onValueChange={(v) => update({ saveHistory: v })}
          trackColor={{ false: '#334155', true: ACCENT }}
        />
      </SettingsRow>
      <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={onClearFavorites}>
        <Text style={styles.actionBtnText}>{t('clearFavorites')}</Text>
      </TouchableOpacity>

      {/* OTA-ONA NAZORATI */}
      <SectionTitle text={t('parental')} />
      <SettingsRow label={t('pinProtect')}>
        <Switch
          value={settings.parentalPinEnabled}
          onValueChange={(v) => {
            if (v && !settings.parentalPin) {
              setPinSetupVisible(true);
            } else {
              update({ parentalPinEnabled: v });
            }
          }}
          trackColor={{ false: '#334155', true: ACCENT }}
        />
      </SettingsRow>
      {settings.parentalPinEnabled && (
        <>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setPinSetupVisible(true)}>
            <Text style={styles.actionBtnText}>{t('changePin')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setLockPickerVisible(true)}>
            <Text style={styles.actionBtnText}>
              {t('lockedCategories')} ({settings.lockedGroups.length})
            </Text>
          </TouchableOpacity>
        </>
      )}

      {/* ILOVA HAQIDA */}
      <SectionTitle text={t('aboutApp')} />
      <SettingsRow label={t('version')} value={APP_VERSION} />
      <SettingsRow label={t('website')} value="mirovoytv.uz" />
      <SettingsRow label={t('telegram')} value="@mirovoytvuz" />
      <Text style={styles.aboutNote}>{t('aboutNote')}</Text>

      {/* PIN o'rnatish oynasi */}
      <Modal visible={pinSetupVisible} transparent animationType="fade">
        <View style={styles.pinOverlay}>
          <View style={styles.pinBox}>
            <Text style={styles.pinTitle}>{t('setPinTitle')}</Text>
            <TextInput
              value={pinValue}
              onChangeText={setPinValue}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              style={styles.pinInput}
              placeholder="****"
              placeholderTextColor="#475569"
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.pinBtn, { backgroundColor: '#334155' }]}
                onPress={() => setPinSetupVisible(false)}
              >
                <Text style={styles.retryBtnText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pinBtn}
                onPress={() => {
                  if (pinValue.length < 4) {
                    Alert.alert(t('tooShort'), t('tooShortMsg'));
                    return;
                  }
                  update({ parentalPin: pinValue, parentalPinEnabled: true });
                  setPinSetupVisible(false);
                }}
              >
                <Text style={styles.retryBtnText}>{t('save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Qulflanadigan kategoriyalarni tanlash oynasi */}
      <Modal visible={lockPickerVisible} transparent animationType="slide">
        <View style={styles.pinOverlay}>
          <View style={[styles.pinBox, { maxHeight: '70%' }]}>
            <Text style={styles.pinTitle}>{t('lockedCategories')}</Text>
            <ScrollView style={{ marginTop: 10 }}>
              {categoryNames.map((name) => {
                const checked = settings.lockedGroups.includes(name);
                return (
                  <TouchableOpacity
                    key={name}
                    style={styles.lockRow}
                    onPress={() => {
                      const next = checked
                        ? settings.lockedGroups.filter((g) => g !== name)
                        : [...settings.lockedGroups, name];
                      update({ lockedGroups: next });
                    }}
                  >
                    <Text style={styles.lockRowText}>{name}</Text>
                    <Ionicons name={checked ? 'lock-closed' : 'lock-open-outline'} size={17} color={checked ? ACCENT : '#64748b'} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.pinBtn} onPress={() => setLockPickerVisible(false)}>
              <Text style={styles.retryBtnText}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function SectionTitle({ text }: { text: string }) {
  return <Text style={styles.sectionTitle}>{text}</Text>;
}

function SettingsRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.settingsRow}>
      <Text style={styles.settingsLabel}>{label}</Text>
      {children ? children : <Text style={styles.settingsValue}>{value}</Text>}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  STILLAR
// ═══════════════════════════════════════════════════════════════════════
const ACCENT = '#8b5cf6';
const ACCENT2 = '#00e0b0';
const GOLD = '#ffc73c';
const BG = '#0a0c18';
const CARD_BG = '#141827';
const BORDER = '#1e2436';

// ═══════════════════════════════════════════════════════════════════════
//  GLOBAL "QOTISH HIMOYASI" — kutilmagan render xatosi butun ilovani oq
//  ekran qilib "urib qo'ymasligi" uchun. Xato yuz bersa, shu yer ushlab
//  qoladi va foydalanuvchiga "Qayta boshlash" imkonini beradi (ilova
//  to'liq o'chib-yonmasdan, minglab kanalli ro'yxatni qayta yuklamasdan).
// ═══════════════════════════════════════════════════════════════════════
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // Xatoni jim yutamiz — ilova qotib qolmasligi muhimroq
  }
  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0c18', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', marginBottom: 16 }}>
            {'\u26a0\ufe0f'} Kutilmagan xatolik yuz berdi.
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: '#8b5cf6', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 }}
            onPress={() => this.setState({ hasError: false })}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Qayta boshlash</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// Yakuniy export — butun ilova ErrorBoundary bilan o'ralgan.
export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  // ── Yaqinda ko'rilgan tasmasi ──────────────────────────────────────
  recentCard: {
    width: 150,
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: BORDER,
  },
  recentCardName: { color: '#fff', fontWeight: '700', fontSize: 13 },
  recentCardProgram: { color: '#94a3b8', fontSize: 11, marginTop: 4 },

  // ── Kanal kartasidagi EPG (hozir ketayotgan dastur) ─────────────────
  chEpgText: { color: '#94a3b8', fontSize: 10.5, marginTop: 3 },
  chEpgTrack: { height: 3, backgroundColor: '#1e293b', borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  chEpgFill: { height: 3, backgroundColor: ACCENT },

  // ── Pleyerdagi EPG matni ────────────────────────────────────────────
  playerEpgText: { color: '#cbd5e1', fontSize: 11.5, marginTop: 2 },

  // ── EPG (dastur jadvali) oynasi ─────────────────────────────────────
  epgOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  epgSheet: { backgroundColor: '#0d1120', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', paddingTop: 6 },
  epgSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  epgSheetTitle: { color: '#fff', fontWeight: '800', fontSize: 15, flex: 1, marginRight: 10 },
  epgRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  epgRowActive: { backgroundColor: 'rgba(139,92,246,0.12)' },
  epgRowTime: { color: '#64748b', fontSize: 13, fontWeight: '700', width: 46 },
  epgRowTimeActive: { color: ACCENT },
  epgRowTitle: { color: '#e2e8f0', fontSize: 13.5, fontWeight: '600' },
  epgRowDesc: { color: '#64748b', fontSize: 11.5, marginTop: 2 },
  epgLiveBadge: { backgroundColor: ACCENT, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  epgLiveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  root: { flex: 1, backgroundColor: BG },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerLogo: { width: 42, height: 42, borderRadius: 12 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  headerSubtitle: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  announceBox: {
    marginTop: 10,
    backgroundColor: 'rgba(139,92,246,0.15)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.35)',
  },
  announceText: { color: '#c4b5fd', fontSize: 12.5 },

  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  subHeaderBack: { color: '#fff', fontSize: 20 },
  subHeaderTitle: { color: '#fff', fontSize: 17, fontWeight: '700', flexShrink: 1 },

  search: {
    backgroundColor: CARD_BG,
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: BORDER,
  },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { color: '#94a3b8', fontSize: 14, textAlign: 'center' },
  retryBtn: { backgroundColor: ACCENT, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, marginTop: 8 },
  retryBtnText: { color: '#fff', fontWeight: '700', textAlign: 'center' },

  // Kategoriya kartalari
  catCard: {
    flex: 1,
    backgroundColor: CARD_BG,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BORDER,
  },
  catIconCircle: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  catIconText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  catName: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  catCount: { color: '#64748b', fontSize: 11.5 },

  // Kanal kartalari
  chCard: { backgroundColor: CARD_BG, borderRadius: 14, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: BORDER },
  chLogoBox: {
    width: '100%',
    aspectRatio: 1.5,
    backgroundColor: '#0d1120',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    overflow: 'hidden',
  },
  chLogoImg: { width: '80%', height: '80%' },
  chLogoFallback: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chLogoFallbackText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  chFavBtn: { position: 'absolute', top: 6, right: 6 },
  chTgBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: '#229ED9',
    borderRadius: 8,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chFavIcon: { color: GOLD, fontSize: 18 },
  chName: { color: '#e2e8f0', fontSize: 12.5, fontWeight: '600' },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER,
    backgroundColor: '#0d1120',
    paddingBottom: Platform.OS === 'ios' ? 18 : 8,
    paddingTop: 8,
  },
  tabBtn: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 4, borderRadius: 8 },
  tabBtnFocused: { backgroundColor: 'rgba(139,92,246,0.18)', transform: [{ scale: 1.08 }] },
  iconBtnFocused: { backgroundColor: 'rgba(139,92,246,0.25)', borderRadius: 20 },
  sideNavBtnFocused: { backgroundColor: 'rgba(139,92,246,0.55)', transform: [{ scale: 1.12 }] },
  tabIcon: { fontSize: 18, color: '#64748b' },
  tabIconActive: { color: ACCENT },
  tabLabel: { fontSize: 10.5, color: '#64748b', fontWeight: '600' },
  tabLabelActive: { color: ACCENT },

  bannerWrap: { alignItems: 'center', backgroundColor: '#0d1120' },

  // Pleyer
  playerRoot: { flex: 1, backgroundColor: '#000' },
  // MUHIM (tarixiy): backgroundColor QASDDAN OLIB TASHLANGAN — eski VLCPlayer
  // ichida ishlatilgan Android TextureView fon rangini qo'llab-quvvatlamas
  // edi va qulashga sabab bo'lgan (JSApplicationIllegalArgumentException,
  // RCTVLCPlayer). Endi react-native-video ishlatilsa ham, bu qator
  // xavfsizlik uchun shu holicha (backgroundColor'siz) qoldirildi.
  video: { flex: 1 },
  playerCenterOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playerTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 10,
  },
  backBtn: { marginRight: 4 },
  playerLogo: { width: 26, height: 26, borderRadius: 6 },
  playerTitle: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 },
  sideNavBtn: {
    position: 'absolute',
    top: '50%',
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerErrorBox: {
    position: 'absolute',
    bottom: 50,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(30,30,40,0.95)',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  playerErrorText: { color: '#fff', textAlign: 'center', fontSize: 13.5 },
  retryBtnSmall: { backgroundColor: ACCENT, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10 },

  // Til tanlash
  langPill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: '#0d1120', borderWidth: 1, borderColor: BORDER },
  langPillActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  langPillText: { color: '#94a3b8', fontWeight: '700', fontSize: 13 },
  langPillTextActive: { color: '#fff' },

  // Sozlamalar
  sectionTitle: { color: ACCENT2, fontSize: 12.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 22, marginBottom: 10 },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: CARD_BG,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: BORDER,
  },
  settingsLabel: { color: '#e2e8f0', fontSize: 14, flexShrink: 1 },
  settingsValue: { color: '#94a3b8', fontSize: 13 },
  actionBtn: { backgroundColor: ACCENT, borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', marginBottom: 8, marginTop: 2 },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 13.5 },
  dangerBtn: { backgroundColor: '#7f1d1d' },
  aboutNote: { color: '#64748b', fontSize: 12, lineHeight: 18, marginTop: 6 },
  pillBtn: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#0d1120', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER },
  pillBtnActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  pillBtnText: { color: '#94a3b8', fontWeight: '700' },
  pillBtnTextActive: { color: '#fff' },

  // PIN modal
  pinOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  pinBox: { backgroundColor: '#141827', borderRadius: 18, padding: 22, width: '100%', maxWidth: 340, borderWidth: 1, borderColor: BORDER },
  pinTitle: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  pinSubtitle: { color: '#94a3b8', fontSize: 12.5, textAlign: 'center', marginTop: 6, marginBottom: 14 },
  pinInput: {
    backgroundColor: '#0d1120',
    color: '#fff',
    borderRadius: 10,
    paddingVertical: 12,
    textAlign: 'center',
    fontSize: 20,
    letterSpacing: 8,
    marginTop: 12,
    borderWidth: 1,
    borderColor: BORDER,
  },
  pinBtn: { flex: 1, backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  lockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  lockRowText: { color: '#e2e8f0', fontSize: 14 },
  lockRowCheck: { fontSize: 16 },
});
