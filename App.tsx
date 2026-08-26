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
  Image as RNImage,
  Modal,
  Switch,
  ScrollView,
  Dimensions,
  Alert,
  Platform,
  Animated,
  Pressable,
} from 'react-native';
import { Video, ResizeMode, Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as KeepAwake from 'expo-keep-awake';
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

// Ko'p IPTV manbalari (masalan oktv.uz kabi) translyatsiyani va rasm
// (logotip) so'rovlarini faqat "haqiqiy brauzer/pleyer"dan kelayotganday
// ko'rinadigan so'rovlarga beradi — aks holda 403/bo'sh javob bilan rad
// etadi. Shu sabab har bir so'rovga standart brauzer User-Agent va
// manba domeniga mos Referer qo'shib yuboramiz.
function buildStreamHeaders(url: string): Record<string, string> {
  let referer = 'https://mirovoytv.uz/';
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

// Kanal logotiplari uchun oddiy React Native Image ishlatiladi.
// (Eslatma: avval expo-image ishlatish ko'zda tutilgan edi, lekin u
// package.json'da o'rnatilmagan bo'lgani uchun build paytida "modul
// topilmadi" xatosi berardi — shu sabab olib tashlandi.)
const Image = RNImage;

// ═══════════════════════════════════════════════════════════════════════
//  SOZLAMALAR — asosiy manba (agar masofaviy config yuklanmasa, shu
//  ishlatiladi). Masofaviy config orqali buni qayta APK chiqarmasdan
//  o'zgartirish mumkin — pastdagi REMOTE_CONFIG_URL ga qarang.
// ═══════════════════════════════════════════════════════════════════════
const APP_NAME = 'Mirovoy TV';
const APP_VERSION = '2.0.0';
const UNGROUPED_LABEL = 'Boshqa';

const DEFAULT_PLAYLIST_URL = 'https://mirovoytv.uz/playlists/813bc163.m3u';

// Masofaviy boshqaruv fayli. Shu havoladagi JSON'ni siz istagan vaqt
// tahrirlab, ilovaning playlist manbasini, reklama sozlamalarini va
// e'lonni foydalanuvchilar qayta o'rnatmasdan yangilay olasiz.
// GitHub'da "raw" havola shaklida bo'lishi kerak, masalan:
// https://raw.githubusercontent.com/SIZNING_USER/mirovoy-tv-app/main/config.json
const REMOTE_CONFIG_URL =
  'https://raw.githubusercontent.com/tirkashs-team/mirovoy-tv-app/main/config.json';

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
  // EPG (dastur jadvali) manbasini QAYTA BUILD QILMASDAN almashtirish uchun
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
};

const DEFAULT_SETTINGS: AppSettings = {
  gridColumns: 2,
  showLogos: true,
  autoRefreshHours: 12,
  parentalPinEnabled: false,
  parentalPin: '',
  lockedGroups: [],
  saveHistory: true,
};

// ═══════════════════════════════════════════════════════════════════════
//  YORDAMCHI FUNKSIYALAR
// ═══════════════════════════════════════════════════════════════════════

// To'liq URL asosida barqaror, GLOBAL DARAJADA UNIKAL identifikator.
// (Avvalgi versiyada ID faqat "shu pleylist ichidagi tartib raqami +
// URL oxiri" edi — bir nechta pleylist birlashtirilganda ikkita
// kanal bir xil ID olib qolishi mumkin edi, bu esa FlatList'da
// "duplicate key" holatiga, g'alati render va ba'zan qotishga sabab
// bo'lardi. Endi butun URL bo'yicha hash olinadi — amalda to'qnashuv
// ehtimoli yo'q.)
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

// Oddiy, mustahkam M3U parser — #EXTINF qatoridan group-title, tvg-logo
// va nomni, undan keyingi bo'sh bo'lmagan qatordan URL manzilini oladi.
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

// Tarmoq so'rovi hech qachon "abadiy kutmasin" — server javob bermasa,
// belgilangan vaqtdan keyin o'zi to'xtaydi (aks holda foydalanuvchiga
// ilova "qotib qolgandek" tuyuladi, garchi texnik jihatdan qotmagan
// bo'lsa ham — u shunchaki cheksiz javob kutayotgan bo'ladi).
async function fetchWithTimeout(url: string, ms: number, opts?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
//  GLOBAL "QOTISH HIMOYASI" — kutilmagan xato butun ilovani oq ekran
//  qilib "urib qo'ymasligi" uchun. Render vaqtida xato yuz bersa, shu
//  yer ushlab qoladi va foydalanuvchiga qayta boshlash imkonini beradi
//  (ilova to'liq o'chib-yonmasdan).
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
        <SafeAreaView style={styles.root}>
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>
              {'\u26a0\ufe0f'} Kutilmagan xatolik yuz berdi.
            </Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => this.setState({ hasError: false })}
            >
              <Text style={styles.retryBtnText}>Qayta boshlash</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  ASOSIY KOMPONENT
// ═══════════════════════════════════════════════════════════════════════
function AppInner() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const channelsRef = useRef<Channel[]>([]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);

  // ── EPG (dastur jadvali) — avval keshdan DARHOL ko'rsatamiz, so'ng
  //    orqa fonda yangisini yuklab, keshni yangilaymiz. Manba minglab
  //    boshqa kanal ma'lumotini ham berishi mumkin — biz FAQAT o'z
  //    kanallarimizga tegishli qismini saqlaymiz, aks holda katta
  //    keshni qayta o'qish (JSON.parse) ilovani "muzlatib" qo'yishi
  //    mumkin edi.
  const [epg, setEpg] = useState<EpgData | null>(null);
  const trimEpgToChannels = useCallback((data: EpgData, chs: Channel[]): EpgData => {
    if (chs.length === 0) return data;
    const neededIds = new Set<string>();
    for (const ch of chs) {
      const id = matchEpgChannelId(data, ch);
      if (id) neededIds.add(id);
    }
    const trimmedPrograms = new Map<string, EpgProgram[]>();
    for (const id of neededIds) {
      const list = data.programsById.get(id);
      if (list) trimmedPrograms.set(id, list);
    }
    const trimmedNameToId = new Map<string, string>();
    for (const [name, id] of data.nameToId.entries()) {
      if (neededIds.has(id)) trimmedNameToId.set(name, id);
    }
    return { programsById: trimmedPrograms, nameToId: trimmedNameToId };
  }, []);
  const cacheEpgSafely = useCallback((data: EpgData) => {
    try {
      AsyncStorage.setItem('mtv:cachedEpg', serializeEpg(data)).catch(() => {});
    } catch (e) {
      // juda katta bo'lsa yoki JSON xato bersa — jimgina o'tkazib yuboramiz
    }
  }, []);
  const refreshEpg = useCallback(
    (epgUrl?: string) => {
      fetchEpg(epgUrl)
        .then((data) => {
          const trimmed = trimEpgToChannels(data, channelsRef.current);
          setEpg(trimmed);
          cacheEpgSafely(trimmed);
        })
        .catch(() => {});
    },
    [trimEpgToChannels, cacheEpgSafely]
  );

  const [screen, setScreen] = useState<Screen>('categories');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Qidiruv 250ms "debounce" bilan ishlaydi — har bosilgan harfda
  // minglab kanalni qayta filtrlash o'rniga, foydalanuvchi yozishni
  // bir zum to'xtatgandagina filtrlanadi. Sekin qurilmalarda
  // terish paytidagi "sekinlashish" hissini yo'qotadi.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  // Pleyerda "oldingi/keyingi" tugmalari ishlashi uchun — qaysi ro'yxatdan
  // ochilgan bo'lsa, o'sha ro'yxat ichida oldinga/orqaga siljiymiz.
  const [activeChannelList, setActiveChannelList] = useState<Channel[]>([]);
  const [playerError, setPlayerError] = useState(false);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [playerErrorMsg, setPlayerErrorMsg] = useState('');
  const videoRef = useRef<Video>(null);
  // Har bir kanal uchun nechta avtomatik qayta urinish qilinganini
  // sanaydi — birinchi 1-2 xatoda ovoz chiqarmasdan o'zi qayta urinadi
  // (ko'p IPTV oqimlar birinchi so'rovda vaqtincha xato beradi),
  // foydalanuvchiga faqat barcha urinishlar tugagach xato ko'rsatiladi.
  const autoRetryRef = useRef(0);
  const autoSkipCountRef = useRef(0);
  const MAX_AUTO_SKIP = 5;
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [favorites, setFavorites] = useState<string[]>([]);
  // Ro'yxatlarda (minglab kanal bo'lishi mumkin) har bir kartochka
  // "sevimlimi?" deb array.includes() bilan tekshirsa — sekinlashadi
  // (har elementda butun ro'yxatni qayta ko'zdan kechiradi). Set bilan
  // bu tekshiruv bir zumda bo'ladi.
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);

  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [epgModalVisible, setEpgModalVisible] = useState(false);
  // Video o'ynab turgan paytda, ekrandan chiqmasdan boshqa kanalga
  // o'tish uchun ro'yxat overlay'i
  const [channelSwitcherVisible, setChannelSwitcherVisible] = useState(false);
  // Boshqaruv paneli — ekranga bir marta bosilganda ko'rinadi/yashiriladi,
  // 4 soniya harakatsizlikdan keyin o'zi yashiradi (Televizo uslubida).
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsFade = useRef(new Animated.Value(1)).current;
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoHide = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
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
  useEffect(() => {
    setControlsVisible(true);
  }, [activeChannel?.url]);
  const toggleControls = useCallback(() => setControlsVisible((v) => !v), []);
  const [pinInput, setPinInput] = useState('');
  const [pendingUnlockGroup, setPendingUnlockGroup] = useState<string | null>(null);
  const [unlockedGroups, setUnlockedGroups] = useState<string[]>([]);


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
        const rawEpg = await AsyncStorage.getItem('mtv:cachedEpg');
        if (rawEpg) setEpg(deserializeEpg(rawEpg));
      } catch (e) {
        // birinchi marta ishga tushganda xotira bo'sh — muammo emas
      }
      loadEverything();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── OVOZ SOZLAMASI — bu yo'q bo'lsa, Android'da ba'zi qurilmalarda
  // ovoz umuman chiqmaydi yoki boshqa ilova ovozi bilan to'qnashadi.
  // Ilova ochilganda BIR MARTA to'g'ri audio-rejim o'rnatiladi:
  // - "DoNotMix": boshqa ilova ovozini pauza qilib, o'z ovozini chiqaradi
  // - playsInSilentModeIOS: iPhone "jim rejim"da bo'lsa ham video ovozi eshitiladi
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: false,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    }).catch(() => {
      // ba'zi qurilmalarda audio-rejim o'rnatilmasligi mumkin — ilova
      // baribir standart ovoz bilan davom etadi, qulash sabab bo'lmaydi
    });
  }, []);

  // ── Masofaviy config + pleylist(lar)ni yuklash ───────────────────────
  const loadEverything = useCallback(async () => {
    setStatus('loading');
    setErrorMsg('');
    let cfg: RemoteConfig | null = null;
    try {
      const res = await fetchWithTimeout(REMOTE_CONFIG_URL, 10000, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (res.ok) {
        cfg = await res.json();
        setRemoteConfig(cfg);
      }
    } catch (e) {
      // masofaviy config topilmasa (yoki 10s ichida javob kelmasa) —
      // muammo emas, standart pleylistga o'tamiz
    }
    // EPG'ni pleylistdan MUSTAQIL, parallel yangilaymiz — biri
    // ikkinchisini kutib turmasin.
    refreshEpg(cfg?.epgUrl);

    const sources: string[] =
      cfg?.playlists && cfg.playlists.length > 0
        ? cfg.playlists.map((p) => p.url)
        : [DEFAULT_PLAYLIST_URL];

    try {
      const texts = await Promise.all(
        sources.map((url) =>
          fetchWithTimeout(url, 20000)
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.text();
            })
            .catch(() => '')
        )
      );
      const validTexts = texts.filter((t) => t && t.trim().length > 0);
      if (validTexts.length === 0) throw new Error('Pleylist manbalariga ulanib bo\u2018lmadi');
      const parsed = mergePlaylists(validTexts);
      if (parsed.length === 0) throw new Error('Pleylist bo\u2018sh');
      setChannels(parsed);
      setStatus('ready');
      const now = Date.now();
      setLastSync(now);
      AsyncStorage.setItem('mtv:lastSync', String(now)).catch(() => {});
    } catch (e: any) {
      setErrorMsg(e?.message || 'Nomalum xatolik');
      setStatus('error');
    }
  }, [refreshEpg]);

  // ── Orqaga tugmasi: pleyer > ekranlar > chiqish ──────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeChannel) {
        closePlayer();
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
    () => channels.filter((c) => favoritesSet.has(c.url)),
    [channels, favoritesSet]
  );

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

  const clearLoadingTimer = () => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  };

  // Har bir "yuklanish boshlandi" holatida — agar 18 soniya ichida na
  // xato, na muvaffaqiyat kelmasa (masalan server "osilib qolgan"),
  // o'zimiz xato deb hisoblaymiz. Aks holda foydalanuvchi cheksiz
  // aylanuvchi belgini ko'rib, ilova "qotib qoldi" deb o'ylaydi.
  const armLoadingTimeout = () => {
    clearLoadingTimer();
    loadingTimerRef.current = setTimeout(() => {
      setPlayerLoading((stillLoading) => {
        if (stillLoading) handlePlayerFail('Ulanish vaqti tugadi');
        return stillLoading;
      });
    }, 18000);
  };

  const handlePlayerFail = (msg: string) => {
    // Birinchi 2 marta — jim holda o'zi qayta urinadi (ko'p IPTV
    // oqimlari vaqtinchalik xato berib, keyingi urinishda ishlaydi).
    if (autoRetryRef.current < 2) {
      autoRetryRef.current += 1;
      setPlayerLoading(true);
      armLoadingTimeout();
      setTimeout(() => {
        videoRef.current?.replayAsync?.().catch(() => {
          setPlayerError(true);
          setPlayerErrorMsg(msg);
          setPlayerLoading(false);
          clearLoadingTimer();
        });
      }, 800);
      return;
    }
    setPlayerError(true);
    setPlayerErrorMsg(msg);
    setPlayerLoading(false);
    clearLoadingTimer();
  };

  const openChannel = (ch: Channel, list?: Channel[]) => {
    autoRetryRef.current = 0;
    autoSkipCountRef.current = 0;
    setPlayerError(false);
    setPlayerErrorMsg('');
    setPlayerLoading(true);
    setActiveChannel(ch);
    setActiveChannelList(list && list.length > 0 ? list : [ch]);
    armLoadingTimeout();
  };

  const switchChannel = useCallback(
    (direction: 1 | -1) => {
      if (!activeChannel || activeChannelList.length <= 1) return;
      const idx = activeChannelList.findIndex((c) => c.id === activeChannel.id);
      if (idx === -1) return;
      const nextIdx = (idx + direction + activeChannelList.length) % activeChannelList.length;
      const next = activeChannelList[nextIdx];
      autoRetryRef.current = 0;
      setPlayerError(false);
      setPlayerErrorMsg('');
      setPlayerLoading(true);
      setActiveChannel(next);
      armLoadingTimeout();
    },
    [activeChannel, activeChannelList]
  );

  const closePlayer = () => {
    clearLoadingTimer();
    setActiveChannel(null);
  };

  // Kanal ochilmay qolsa (playerError true bo'lsa) — foydalanuvchini
  // kutdirmasdan avtomatik keyingi kanalga o'tkazamiz. Faqat
  // MAX_AUTO_SKIP tagacha — aks holda butun ro'yxat yoki internetning
  // o'zi ishlamasa, cheksiz aylanib qolmasin (xato oynasi ko'rsatiladi).
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

  // Pleyer ekranida bo'lganida ekran o'chib/qulflanib qolmasin (TV
  // tomosha qilayotganda ekran uxlab qolishi yomon tajriba bo'lardi).
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

  // ═══════════════════════════════════════════════════════════════════
  //  PLEYER EKRANI — TO'LIQ EKRAN, JONLI EFIR UCHUN SODDALASHTIRILGAN
  //  (progress-bar, orqaga/oldinga tugmalari YO'Q — faqat jonli TV)
  // ═══════════════════════════════════════════════════════════════════
  if (activeChannel) {
    const canSwitch = activeChannelList.length > 1;
    return (
      <SafeAreaView style={styles.playerRoot}>
        <StatusBar hidden />
        <Pressable style={{ flex: 1 }} onPress={toggleControls}>
          <Video
            // "key" — kanal almashtirilganda pleyer komponenti TO'LIQ
            // qayta yaratiladi (eski oqim holati/buferi qolib
            // ketmaydi). Bu ba'zi qurilmalarda kanal tez-tez
            // almashtirilganda yuzaga keladigan qotish/tovush
            // aralashib ketish muammosining oldini oladi.
            key={activeChannel.url}
            ref={videoRef}
            style={styles.video}
            source={{ uri: activeChannel.url, headers: buildStreamHeaders(activeChannel.url) }}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            isMuted={false}
            volume={1.0}
            progressUpdateIntervalMillis={1000}
            onLoadStart={() => {
              setPlayerLoading(true);
              armLoadingTimeout();
            }}
            onReadyForDisplay={() => {
              autoRetryRef.current = 0;
              autoSkipCountRef.current = 0;
              setPlayerLoading(false);
              clearLoadingTimer();
            }}
            onPlaybackStatusUpdate={(s: any) => {
              if (s?.isLoaded) {
                autoRetryRef.current = 0;
                autoSkipCountRef.current = 0;
                setPlayerLoading(false);
                clearLoadingTimer();
              } else if (s?.error) {
                handlePlayerFail('Oqimda xatolik');
              }
            }}
            onError={() => handlePlayerFail('Kanal ochilmadi')}
          />

          {playerLoading && !playerError && (
            <View style={styles.playerCenterOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#ffffff" />
            </View>
          )}

          <Animated.View
            style={[StyleSheet.absoluteFillObject, { opacity: controlsFade }]}
            pointerEvents={controlsVisible ? 'box-none' : 'none'}
          >
            <View style={styles.playerTopBar}>
              <TouchableOpacity onPress={closePlayer} style={styles.backBtn} hitSlop={{top:10,bottom:10,left:10,right:10}}>
                <Text style={styles.backBtnText}>{'\u2190'}</Text>
              </TouchableOpacity>
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
                {epg && getNowNext(epg, activeChannel).now ? (
                  <Text style={styles.playerEpgText} numberOfLines={1}>
                    {getNowNext(epg, activeChannel).now!.title}
                  </Text>
                ) : null}
              </View>
              {canSwitch && (
                <TouchableOpacity
                  onPress={() => setChannelSwitcherVisible(true)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ marginRight: 14 }}
                >
                  <Text style={styles.playerFav}>{'\u25a4'}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => setEpgModalVisible(true)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={{ marginRight: 14 }}
              >
                <Text style={styles.playerFav}>{'\u2261'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => toggleFavorite(activeChannel.url)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.playerFav}>
                  {favoritesSet.has(activeChannel.url) ? '\u2605' : '\u2606'}
                </Text>
              </TouchableOpacity>
            </View>

            {canSwitch && (
              <>
                <TouchableOpacity
                  style={[styles.sideNavBtn, { left: 8 }]}
                  onPress={() => switchChannel(-1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                >
                  <Text style={styles.sideNavBtnText}>{'\u25c0'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sideNavBtn, { right: 8 }]}
                  onPress={() => switchChannel(1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                >
                  <Text style={styles.sideNavBtnText}>{'\u25b6'}</Text>
                </TouchableOpacity>
              </>
            )}
          </Animated.View>

          {playerError && (
            <View style={styles.playerErrorBox}>
              <Text style={styles.playerErrorText}>
                Bu kanal hozircha ochilmadi{playerErrorMsg ? ` (${playerErrorMsg})` : ''}.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <TouchableOpacity
                  style={styles.retryBtnSmall}
                  onPress={() => {
                    autoRetryRef.current = 0;
                    setPlayerError(false);
                    setPlayerErrorMsg('');
                    setPlayerLoading(true);
                    armLoadingTimeout();
                    videoRef.current?.replayAsync?.().catch(() => {
                      setPlayerError(true);
                      setPlayerLoading(false);
                    });
                  }}
                >
                  <Text style={styles.retryBtnText}>Qayta urinish</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.retryBtnSmall, { backgroundColor: '#334155' }]}
                  onPress={closePlayer}
                >
                  <Text style={styles.retryBtnText}>Orqaga</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </Pressable>

        <EpgGuideModal
          visible={epgModalVisible}
          onClose={() => setEpgModalVisible(false)}
          channel={activeChannel}
          epg={epg}
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
              {status === 'ready' ? `${channels.length} ta kanal \u00b7 ${categories.length} ta kategoriya` : ' '}
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
          <Text style={styles.centerText}>Kanallar yuklanmoqda...</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centerBox}>
          <Text style={styles.centerText}>{'\u26a0\ufe0f'} Yuklab bo'lmadi: {errorMsg}</Text>
          <TouchableOpacity onPress={loadEverything} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Qayta urinish</Text>
          </TouchableOpacity>
        </View>
      )}

      {status === 'ready' && screen === 'categories' && (
        <CategoriesScreen
          categories={categories}
          settings={settings}
          onOpen={openGroup}
        />
      )}

      {status === 'ready' && screen === 'channels' && activeGroup && (
        <ChannelGridScreen
          title={activeGroup}
          channels={channelsInGroup}
          settings={settings}
          favorites={favoritesSet}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, channelsInGroup)}
          onBack={() => {
            setScreen('categories');
            setActiveGroup(null);
          }}
          epg={epg}
        />
      )}

      {status === 'ready' && screen === 'search' && (
        <SearchScreen
          search={search}
          setSearch={setSearch}
          results={searchResults}
          settings={settings}
          favorites={favoritesSet}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, searchResults)}
          epg={epg}
        />
      )}

      {status === 'ready' && screen === 'favorites' && (
        <ChannelGridScreen
          title="Sevimlilar"
          channels={favoriteChannels}
          settings={settings}
          favorites={favoritesSet}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={(ch) => openChannel(ch, favoriteChannels)}
          emptyText="Hali sevimli kanal qo'shmagansiz. Kanal ustidagi {'\u2606'} belgisini bosing."
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
          categoryNames={categories.map((c) => c.name)}
          onClearFavorites={() => {
            Alert.alert('Sevimlilarni tozalash', 'Hammasi o\u2018chirilsinmi?', [
              { text: 'Bekor qilish', style: 'cancel' },
              {
                text: 'O\u2018chirish',
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
        <TabButton label="Kanallar" icon="\u25a4" active={screen === 'categories' || screen === 'channels'} onPress={() => { setScreen('categories'); setActiveGroup(null); }} />
        <TabButton label="Qidiruv" icon="\u2315" active={screen === 'search'} onPress={() => setScreen('search')} />
        <TabButton label="Sevimli" icon="\u2605" active={screen === 'favorites'} onPress={() => setScreen('favorites')} />
        <TabButton label="Sozlama" icon="\u2699" active={screen === 'settings'} onPress={() => setScreen('settings')} />
      </View>

      {/* ── Ota-ona nazorati PIN oynasi ─────────────────────────────── */}
      <Modal visible={pinModalVisible} transparent animationType="fade">
        <View style={styles.pinOverlay}>
          <View style={styles.pinBox}>
            <Text style={styles.pinTitle}>Bu kategoriya qulflangan</Text>
            <Text style={styles.pinSubtitle}>Kirish uchun PIN kodni kiriting</Text>
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
                <Text style={styles.retryBtnText}>Bekor qilish</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pinBtn} onPress={confirmPin}>
                <Text style={styles.retryBtnText}>Tasdiqlash</Text>
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
function TabButton({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.tabBtn} onPress={onPress}>
      <Text style={[styles.tabIcon, active && styles.tabIconActive]}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  KATEGORIYALAR EKRANI
// ═══════════════════════════════════════════════════════════════════════
function CategoriesScreen({
  categories,
  settings,
  onOpen,
}: {
  categories: { name: string; count: number }[];
  settings: AppSettings;
  onOpen: (name: string) => void;
}) {
  return (
    <FlatList
      data={categories}
      keyExtractor={(item) => item.name}
      numColumns={2}
      contentContainerStyle={{ padding: 12, paddingBottom: 90 }}
      columnWrapperStyle={{ gap: 12 }}
      renderItem={({ item }) => {
        const locked = settings.parentalPinEnabled && settings.lockedGroups.includes(item.name);
        return (
          <TouchableOpacity style={styles.catCard} onPress={() => onOpen(item.name)}>
            <View style={[styles.catIconCircle, { backgroundColor: colorFor(item.name) }]}>
              <Text style={styles.catIconText}>{initials(item.name)}</Text>
            </View>
            <Text style={styles.catName} numberOfLines={2}>
              {item.name} {locked ? '\ud83d\udd12' : ''}
            </Text>
            <Text style={styles.catCount}>{item.count} ta kanal</Text>
          </TouchableOpacity>
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
  epg,
}: {
  title: string;
  channels: Channel[];
  settings: AppSettings;
  favorites: Set<string>;
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
  onBack?: () => void;
  emptyText?: string;
  epg?: EpgData | null;
}) {
  const cols = settings.gridColumns;
  const screenW = Dimensions.get('window').width;
  const cardWidth = (screenW - 10 * 2 - (cols - 1) * 10) / cols;

  const renderItem = useCallback(
    ({ item }: { item: Channel }) => (
      <ChannelCard
        channel={item}
        settings={settings}
        isFav={favorites.has(item.url)}
        onToggleFavorite={() => onToggleFavorite(item.url)}
        onPress={() => onOpenChannel(item)}
        cardWidth={cardWidth}
        epg={epg}
      />
    ),
    [settings, favorites, onToggleFavorite, onOpenChannel, cardWidth, epg]
  );


  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subHeader}>
        {onBack && (
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.subHeaderBack}>{'\u2190'}</Text>
          </TouchableOpacity>
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
        renderItem={renderItem}
        // Minglab kanalli ro'yxatlarda tezlik/xotira uchun — bir vaqtda
        // faqat ekranga yaqin elementlar render qilinadi, uzoqdagilar
        // xotiradan olib tashlanadi (ammo tez scroll qilinganda ham
        // "bo'sh joy" ko'rinmasligi uchun yetarlicha zaxira bilan).
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
        updateCellsBatchingPeriod={50}
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>{emptyText || 'Bu yerda hech narsa yo\u2018q'}</Text>
          </View>
        }
      />
    </View>
  );
}

// React.memo — katta ro'yxatda (minglab kanal) faqat HAQIQATDA
// o'zgargan kartochka qayta chiziladi (masalan bitta kanal sevimliga
// qo'shilsa, faqat o'sha bitta kartochka yangilanadi, qolgan minglab
// kartochka tegilmaydi). Bu sezilarli tezlik farqi beradi.
// ═══════════════════════════════════════════════════════════════════════
//  EPG (DASTUR JADVALI) OYNASI
// ═══════════════════════════════════════════════════════════════════════
function ChannelSwitcherModal({
  visible,
  onClose,
  channels,
  activeChannel,
  epg,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  channels: Channel[];
  activeChannel: Channel | null;
  epg: EpgData | null;
  onSelect: (ch: Channel) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.epgOverlay}>
        <View style={styles.epgSheet}>
          <View style={styles.epgSheetHeader}>
            <Text style={styles.epgSheetTitle} numberOfLines={1}>Kanallar</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ color: '#fff', fontSize: 20 }}>{'\u2715'}</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={channels}
            keyExtractor={(c) => c.id}
            initialNumToRender={20}
            renderItem={({ item }) => {
              const isActive = activeChannel?.id === item.id;
              const nn = epg ? getNowNext(epg, item) : { now: null, next: null };
              return (
                <TouchableOpacity style={[styles.epgRow, isActive && styles.epgRowActive]} onPress={() => onSelect(item)}>
                  {item.logo ? (
                    <Image source={{ uri: item.logo, headers: buildStreamHeaders(item.logo) }} style={{ width: 36, height: 36, borderRadius: 6, marginRight: 10 }} />
                  ) : (
                    <View style={{ width: 36, height: 36, marginRight: 10 }} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.epgRowTitle, isActive && styles.epgRowTimeActive]} numberOfLines={1}>{item.name}</Text>
                    {nn.now ? <Text style={styles.epgRowDesc} numberOfLines={1}>{nn.now.title}</Text> : null}
                  </View>
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
}: {
  visible: boolean;
  onClose: () => void;
  channel: Channel | null;
  epg: EpgData | null;
}) {
  const schedule = useMemo(() => {
    if (!epg || !channel) return [];
    return getFullSchedule(epg, channel);
  }, [epg, channel]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.epgOverlay}>
        <View style={styles.epgSheet}>
          <View style={styles.epgSheetHeader}>
            <Text style={styles.epgSheetTitle} numberOfLines={1}>
              {'Dastur jadvali \u2014 '}
              {channel?.name}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ color: '#fff', fontSize: 20 }}>{'\u2715'}</Text>
            </TouchableOpacity>
          </View>

          {schedule.length === 0 ? (
            <View style={[styles.centerBox, { minHeight: 200 }]}>
              <Text style={styles.centerText}>Bu kanal uchun dastur jadvali topilmadi</Text>
            </View>
          ) : (
            <FlatList
              data={schedule}
              keyExtractor={(p, i) => `${p.start}-${i}`}
              contentContainerStyle={{ paddingBottom: 20 }}
              renderItem={({ item }) => {
                const now = Date.now();
                const isLive = now >= item.start && now < item.stop;
                const startDate = new Date(item.start);
                const hh = String(startDate.getHours()).padStart(2, '0');
                const mm = String(startDate.getMinutes()).padStart(2, '0');
                return (
                  <View style={[styles.epgRow, isLive && styles.epgRowActive]}>
                    <Text style={[styles.epgRowTime, isLive && styles.epgRowTimeActive]}>
                      {hh}:{mm}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.epgRowTitle} numberOfLines={1}>{item.title}</Text>
                      {item.desc ? (
                        <Text style={styles.epgRowDesc} numberOfLines={2}>{item.desc}</Text>
                      ) : null}
                    </View>
                    {isLive && (
                      <View style={styles.epgLiveBadge}>
                        <Text style={styles.epgLiveBadgeText}>JONLI</Text>
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

const ChannelCard = React.memo(function ChannelCard({
  channel,
  settings,
  isFav,
  onToggleFavorite,
  onPress,
  cardWidth,
  epg,
}: {
  channel: Channel;
  settings: AppSettings;
  isFav: boolean;
  onToggleFavorite: () => void;
  onPress: () => void;
  cardWidth: number;
  epg?: EpgData | null;
}) {
  const nowNext = useMemo(
    () => (epg ? getNowNext(epg, channel) : { now: null, next: null }),
    [epg, channel]
  );
  return (
    <TouchableOpacity style={[styles.chCard, { width: cardWidth }]} onPress={onPress}>
      <View style={styles.chLogoBox}>
        {settings.showLogos && channel.logo ? (
          <Image
            source={{ uri: channel.logo, headers: buildStreamHeaders(channel.logo) }}
            style={styles.chLogoImg}
            resizeMode="contain"
          />
        ) : (
          <View style={[styles.chLogoFallback, { backgroundColor: colorFor(channel.name) }]}>
            <Text style={styles.chLogoFallbackText}>{initials(channel.name)}</Text>
          </View>
        )}
        <TouchableOpacity
          style={styles.chFavBtn}
          onPress={onToggleFavorite}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.chFavIcon}>{isFav ? '\u2605' : '\u2606'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.chName} numberOfLines={2}>
        {channel.name}
      </Text>
      {nowNext.now ? (
        <Text style={styles.chEpgText} numberOfLines={1}>
          {nowNext.now.title}
        </Text>
      ) : null}
    </TouchableOpacity>
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
  epg,
}: {
  search: string;
  setSearch: (s: string) => void;
  results: Channel[];
  settings: AppSettings;
  favorites: Set<string>;
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
  epg?: EpgData | null;
}) {
  const cols = settings.gridColumns;
  const screenW = Dimensions.get('window').width;
  const cardWidth = (screenW - 10 * 2 - (cols - 1) * 10) / cols;

  const renderItem = useCallback(
    ({ item }: { item: Channel }) => (
      <ChannelCard
        channel={item}
        settings={settings}
        isFav={favorites.has(item.url)}
        onToggleFavorite={() => onToggleFavorite(item.url)}
        onPress={() => onOpenChannel(item)}
        cardWidth={cardWidth}
        epg={epg}
      />
    ),
    [settings, favorites, onToggleFavorite, onOpenChannel, cardWidth, epg]
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Kanal yoki kategoriya qidirish..."
          placeholderTextColor="#64748b"
          style={styles.search}
          autoFocus
        />
      </View>
      <FlatList
        data={results}
        key={cols}
        keyExtractor={(item) => item.id}
        numColumns={cols}
        contentContainerStyle={{ padding: 10, paddingBottom: 90 }}
        columnWrapperStyle={cols > 1 ? { gap: 10 } : undefined}
        renderItem={renderItem}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
        updateCellsBatchingPeriod={50}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>
              {search.trim() ? 'Hech narsa topilmadi' : 'Kanal nomini yozing'}
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
function SettingsScreen({
  settings,
  onSave,
  lastSync,
  onRefresh,
  totalChannels,
  totalCategories,
  categoryNames,
  onClearFavorites,
}: {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  lastSync: number | null;
  onRefresh: () => void;
  totalChannels: number;
  totalCategories: number;
  categoryNames: string[];
  onClearFavorites: () => void;
}) {
  const [pinSetupVisible, setPinSetupVisible] = useState(false);
  const [pinValue, setPinValue] = useState(settings.parentalPin);
  const [lockPickerVisible, setLockPickerVisible] = useState(false);

  const update = (patch: Partial<AppSettings>) => onSave({ ...settings, ...patch });

  const lastSyncText = lastSync
    ? new Date(lastSync).toLocaleString('uz-UZ')
    : 'Hali yangilanmagan';

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
      {/* PLEYLIST */}
      <SectionTitle text="Pleylist" />
      <SettingsRow label="Jami kanallar" value={`${totalChannels}`} />
      <SettingsRow label="Jami kategoriyalar" value={`${totalCategories}`} />
      <SettingsRow label="Oxirgi yangilanish" value={lastSyncText} />
      <TouchableOpacity style={styles.actionBtn} onPress={onRefresh}>
        <Text style={styles.actionBtnText}>{'\u21bb'} Pleylistni hozir yangilash</Text>
      </TouchableOpacity>

      {/* KO'RINISH */}
      <SectionTitle text="Ko'rinish" />
      <SettingsRow label="Ustunlar soni (grid)">
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
      <SettingsRow label="Kanal logotiplarini ko'rsatish">
        <Switch
          value={settings.showLogos}
          onValueChange={(v) => update({ showLogos: v })}
          trackColor={{ false: '#334155', true: '#8b5cf6' }}
        />
      </SettingsRow>

      {/* SEVIMLILAR VA TARIX */}
      <SectionTitle text="Sevimlilar" />
      <SettingsRow label="Sevimlilarni saqlash">
        <Switch
          value={settings.saveHistory}
          onValueChange={(v) => update({ saveHistory: v })}
          trackColor={{ false: '#334155', true: '#8b5cf6' }}
        />
      </SettingsRow>
      <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={onClearFavorites}>
        <Text style={styles.actionBtnText}>Sevimlilarni tozalash</Text>
      </TouchableOpacity>

      {/* OTA-ONA NAZORATI */}
      <SectionTitle text="Ota-ona nazorati" />
      <SettingsRow label="PIN bilan himoyalash">
        <Switch
          value={settings.parentalPinEnabled}
          onValueChange={(v) => {
            if (v && !settings.parentalPin) {
              setPinSetupVisible(true);
            } else {
              update({ parentalPinEnabled: v });
            }
          }}
          trackColor={{ false: '#334155', true: '#8b5cf6' }}
        />
      </SettingsRow>
      {settings.parentalPinEnabled && (
        <>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setPinSetupVisible(true)}>
            <Text style={styles.actionBtnText}>PIN kodni o'zgartirish</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setLockPickerVisible(true)}>
            <Text style={styles.actionBtnText}>
              Qulflangan kategoriyalar ({settings.lockedGroups.length})
            </Text>
          </TouchableOpacity>
        </>
      )}

      {/* ILOVA HAQIDA */}
      <SectionTitle text="Ilova haqida" />
      <SettingsRow label="Versiya" value={APP_VERSION} />
      <SettingsRow label="Sayt" value="mirovoytv.uz" />
      <SettingsRow label="Telegram" value="@mirovoytvuz" />
      <Text style={styles.aboutNote}>
        Muammo yoki taklif bo'lsa — Telegram kanalimizga yozing. Bu ilova
        {'\n'}shaxsiy foydalanish uchun mo'ljallangan pleylistlarni ko'rsatadi.
      </Text>

      {/* PIN o'rnatish oynasi */}
      <Modal visible={pinSetupVisible} transparent animationType="fade">
        <View style={styles.pinOverlay}>
          <View style={styles.pinBox}>
            <Text style={styles.pinTitle}>Yangi PIN kod o'rnating</Text>
            <TextInput
              value={pinValue}
              onChangeText={setPinValue}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              style={styles.pinInput}
              placeholder="4 xonali kod"
              placeholderTextColor="#475569"
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.pinBtn, { backgroundColor: '#334155' }]}
                onPress={() => setPinSetupVisible(false)}
              >
                <Text style={styles.retryBtnText}>Bekor qilish</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pinBtn}
                onPress={() => {
                  if (pinValue.length < 4) {
                    Alert.alert('Juda qisqa', 'Kamida 4 ta raqam kiriting.');
                    return;
                  }
                  update({ parentalPin: pinValue, parentalPinEnabled: true });
                  setPinSetupVisible(false);
                }}
              >
                <Text style={styles.retryBtnText}>Saqlash</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Qulflanadigan kategoriyalarni tanlash oynasi */}
      <Modal visible={lockPickerVisible} transparent animationType="slide">
        <View style={styles.pinOverlay}>
          <View style={[styles.pinBox, { maxHeight: '70%' }]}>
            <Text style={styles.pinTitle}>Qulflanadigan kategoriyalar</Text>
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
                    <Text style={styles.lockRowCheck}>{checked ? '\ud83d\udd12' : '\ud83d\udd13'}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.pinBtn} onPress={() => setLockPickerVisible(false)}>
              <Text style={styles.retryBtnText}>Tayyor</Text>
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

const styles = StyleSheet.create({
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
  chFavIcon: { color: GOLD, fontSize: 18 },
  chName: { color: '#e2e8f0', fontSize: 12.5, fontWeight: '600' },
  chEpgText: { color: '#8b93a7', fontSize: 10.5, marginTop: 2 },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER,
    backgroundColor: '#0d1120',
    paddingBottom: Platform.OS === 'ios' ? 18 : 8,
    paddingTop: 8,
  },
  tabBtn: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 18, color: '#64748b' },
  tabIconActive: { color: ACCENT },
  tabLabel: { fontSize: 10.5, color: '#64748b', fontWeight: '600' },
  tabLabelActive: { color: ACCENT },

  bannerWrap: { alignItems: 'center', backgroundColor: '#0d1120' },

  // Pleyer
  playerRoot: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, backgroundColor: '#000' },
  playerCenterOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  sideNavBtn: { position: 'absolute', top: '50%', marginTop: -22, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  sideNavBtnText: { color: '#fff', fontSize: 18 },
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
  backBtnText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  playerLogo: { width: 26, height: 26, borderRadius: 6 },
  playerTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  playerEpgText: { color: '#94a3b8', fontSize: 11, marginTop: 1 },
  playerFav: { color: GOLD, fontSize: 22 },
  epgOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  epgSheet: { backgroundColor: '#0d1120', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', minHeight: 260, paddingTop: 6 },
  epgSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  epgSheetTitle: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1, marginRight: 10 },
  epgRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  epgRowActive: { backgroundColor: 'rgba(139,92,246,0.12)' },
  epgRowTime: { color: '#94a3b8', fontSize: 12.5, fontWeight: '600', width: 46 },
  epgRowTimeActive: { color: '#8b5cf6' },
  epgRowTitle: { color: '#e2e8f0', fontSize: 13.5, fontWeight: '600' },
  epgRowDesc: { color: '#64748b', fontSize: 11.5, marginTop: 2 },
  epgLiveBadge: { backgroundColor: '#8b5cf6', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  epgLiveBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
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
  actionBtn: { backgroundColor: ACCENT, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginBottom: 8, marginTop: 2 },
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

// ═══════════════════════════════════════════════════════════════════════
//  YAKUNIY EXPORT — butun ilova ErrorBoundary bilan o'ralgan, shunda
//  kutilmagan xato ilovani "urib qo'ymaydi", faqat shu ekran ichida
//  ushlanadi va foydalanuvchi "Qayta boshlash" bosishi kifoya.
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
