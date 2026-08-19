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
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

const TEST_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';
const TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';

// ═══════════════════════════════════════════════════════════════════════
//  TIPLAR
// ═══════════════════════════════════════════════════════════════════════
type Channel = {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
};

type PlaylistSource = { name: string; url: string };

type RemoteConfig = {
  playlists?: PlaylistSource[];
  announcement?: string;
  ads?: {
    enabled?: boolean;
    bannerId?: string;
    interstitialId?: string;
    interstitialEveryNChannels?: number;
  };
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

// Oddiy, mustahkam M3U parser — #EXTINF qatoridan group-title, tvg-logo
// va nomni, undan keyingi bo'sh bo'lmagan qatordan URL manzilini oladi.
function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let pendingName = '';
  let pendingGroup = '';
  let pendingLogo = '';
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch?.[1]?.trim() || UNGROUPED_LABEL;
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      pendingLogo = logoMatch?.[1]?.trim() || '';
      const afterComma = line.split(',').slice(1).join(',').trim();
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      pendingName = afterComma || nameMatch?.[1]?.trim() || `Kanal ${idx + 1}`;
      continue;
    }
    if (line.startsWith('#')) continue;

    idx += 1;
    channels.push({
      id: `${idx}-${line.slice(-24)}`,
      name: pendingName || `Kanal ${idx}`,
      url: line,
      group: pendingGroup || UNGROUPED_LABEL,
      logo: pendingLogo || undefined,
    });
    pendingName = '';
    pendingGroup = '';
    pendingLogo = '';
  }
  return channels;
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
//  YENGIL/XAVFSIZ ADMOB O'RASH (agar modul topilmasa yoki xato bersa,
//  ilova baribir ishlayveradi — reklama shunchaki ko'rinmaydi)
// ═══════════════════════════════════════════════════════════════════════
let MobileAds: any = null;
let BannerAd: any = null;
let BannerAdSize: any = null;
let InterstitialAd: any = null;
let AdEventType: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admob = require('react-native-google-mobile-ads');
  MobileAds = admob.default;
  BannerAd = admob.BannerAd;
  BannerAdSize = admob.BannerAdSize;
  InterstitialAd = admob.InterstitialAd;
  AdEventType = admob.AdEventType;
} catch (e) {
  // AdMob native modul mavjud emas (masalan Expo Go'da) — jim o'tkazamiz.
}

// ═══════════════════════════════════════════════════════════════════════
//  ASOSIY KOMPONENT
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);

  const [screen, setScreen] = useState<Screen>('categories');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const [playerLoading, setPlayerLoading] = useState(true);
  const videoRef = useRef<Video>(null);

  const [favorites, setFavorites] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);

  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pendingUnlockGroup, setPendingUnlockGroup] = useState<string | null>(null);
  const [unlockedGroups, setUnlockedGroups] = useState<string[]>([]);

  const openCountRef = useRef(0);
  const interstitialRef = useRef<any>(null);

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
      } catch (e) {
        // birinchi marta ishga tushganda xotira bo'sh — muammo emas
      }
      loadEverything();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── AdMob ishga tushirish (mavjud bo'lsa) ────────────────────────────
  useEffect(() => {
    if (MobileAds) {
      MobileAds()
        .initialize()
        .catch(() => {});
    }
  }, []);

  const adsEnabled = remoteConfig?.ads?.enabled !== false; // default: yoqilgan
  const bannerId = remoteConfig?.ads?.bannerId || TEST_BANNER_ID;
  const interstitialId = remoteConfig?.ads?.interstitialId || TEST_INTERSTITIAL_ID;
  const interstitialEvery = remoteConfig?.ads?.interstitialEveryNChannels ?? 4;

  useEffect(() => {
    if (!MobileAds || !InterstitialAd || !adsEnabled) return;
    const ad = InterstitialAd.createForAdRequest(interstitialId);
    interstitialRef.current = ad;
    ad.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interstitialId, adsEnabled]);

  const maybeShowInterstitial = useCallback(() => {
    if (!adsEnabled || !interstitialRef.current || interstitialEvery <= 0) return;
    openCountRef.current += 1;
    if (openCountRef.current % interstitialEvery === 0) {
      try {
        if (interstitialRef.current.loaded !== false) {
          interstitialRef.current.show();
          interstitialRef.current = InterstitialAd?.createForAdRequest(interstitialId);
          interstitialRef.current?.load();
        }
      } catch (e) {
        // reklama ko'rsatilmasa ham ilova davom etaveradi
      }
    }
  }, [adsEnabled, interstitialEvery, interstitialId]);

  // ── Masofaviy config + pleylist(lar)ni yuklash ───────────────────────
  const loadEverything = useCallback(async () => {
    setStatus('loading');
    setErrorMsg('');
    let cfg: RemoteConfig | null = null;
    try {
      const res = await fetch(REMOTE_CONFIG_URL, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.ok) {
        cfg = await res.json();
        setRemoteConfig(cfg);
      }
    } catch (e) {
      // masofaviy config topilmasa — muammo emas, standart pleylistga o'tamiz
    }

    const sources: string[] =
      cfg?.playlists && cfg.playlists.length > 0
        ? cfg.playlists.map((p) => p.url)
        : [DEFAULT_PLAYLIST_URL];

    try {
      const texts = await Promise.all(
        sources.map((url) =>
          fetch(url)
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
  }, []);

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

  const channelsInGroup = useMemo(() => {
    if (!activeGroup) return [];
    return channels.filter((c) => c.group === activeGroup);
  }, [channels, activeGroup]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.trim().toLowerCase();
    return channels.filter(
      (c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [channels, search]);

  const favoriteChannels = useMemo(
    () => channels.filter((c) => favorites.includes(c.url)),
    [channels, favorites]
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

  const openChannel = (ch: Channel) => {
    setPlayerError(false);
    setPlayerLoading(true);
    setActiveChannel(ch);
    maybeShowInterstitial();
  };

  // ═══════════════════════════════════════════════════════════════════
  //  PLEYER EKRANI — TO'LIQ EKRAN, JONLI EFIR UCHUN SODDALASHTIRILGAN
  //  (progress-bar, orqaga/oldinga tugmalari YO'Q — faqat jonli TV)
  // ═══════════════════════════════════════════════════════════════════
  if (activeChannel) {
    return (
      <SafeAreaView style={styles.playerRoot}>
        <StatusBar hidden />
        <Video
          ref={videoRef}
          style={styles.video}
          source={{ uri: activeChannel.url }}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isMuted={false}
          onLoadStart={() => setPlayerLoading(true)}
          onReadyForDisplay={() => setPlayerLoading(false)}
          onPlaybackStatusUpdate={(s: any) => {
            if (s?.isLoaded) setPlayerLoading(false);
          }}
          onError={() => {
            setPlayerError(true);
            setPlayerLoading(false);
          }}
        />

        {playerLoading && !playerError && (
          <View style={styles.playerCenterOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#ffffff" />
          </View>
        )}

        <View style={styles.playerTopBar}>
          <TouchableOpacity onPress={() => setActiveChannel(null)} style={styles.backBtn} hitSlop={{top:10,bottom:10,left:10,right:10}}>
            <Text style={styles.backBtnText}>{'\u2190'}</Text>
          </TouchableOpacity>
          {activeChannel.logo ? (
            <Image source={{ uri: activeChannel.logo }} style={styles.playerLogo} />
          ) : null}
          <Text style={styles.playerTitle} numberOfLines={1}>
            {activeChannel.name}
          </Text>
          <TouchableOpacity
            onPress={() => toggleFavorite(activeChannel.url)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.playerFav}>
              {favorites.includes(activeChannel.url) ? '\u2605' : '\u2606'}
            </Text>
          </TouchableOpacity>
        </View>

        {playerError && (
          <View style={styles.playerErrorBox}>
            <Text style={styles.playerErrorText}>
              Bu kanal hozircha ochilmadi.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <TouchableOpacity
                style={styles.retryBtnSmall}
                onPress={() => {
                  setPlayerError(false);
                  setPlayerLoading(true);
                  videoRef.current?.replayAsync?.().catch(() => {});
                }}
              >
                <Text style={styles.retryBtnText}>Qayta urinish</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.retryBtnSmall, { backgroundColor: '#334155' }]}
                onPress={() => setActiveChannel(null)}
              >
                <Text style={styles.retryBtnText}>Orqaga</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
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
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={openChannel}
          onBack={() => {
            setScreen('categories');
            setActiveGroup(null);
          }}
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
          onOpenChannel={openChannel}
        />
      )}

      {status === 'ready' && screen === 'favorites' && (
        <ChannelGridScreen
          title="Sevimlilar"
          channels={favoriteChannels}
          settings={settings}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenChannel={openChannel}
          emptyText="Hali sevimli kanal qo'shmagansiz. Kanal ustidagi {'\u2606'} belgisini bosing."
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

      {status === 'ready' && adsEnabled && BannerAd && BannerAdSize && screen !== 'settings' && (
        <View style={styles.bannerWrap}>
          <BannerAd unitId={bannerId} size={BannerAdSize.BANNER} />
        </View>
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
}: {
  title: string;
  channels: Channel[];
  settings: AppSettings;
  favorites: string[];
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
  onBack?: () => void;
  emptyText?: string;
}) {
  const cols = settings.gridColumns;
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
        renderItem={({ item }) => (
          <ChannelCard
            channel={item}
            settings={settings}
            isFav={favorites.includes(item.url)}
            onToggleFavorite={() => onToggleFavorite(item.url)}
            onPress={() => onOpenChannel(item)}
            columns={cols}
          />
        )}
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.centerText}>{emptyText || 'Bu yerda hech narsa yo\u2018q'}</Text>
          </View>
        }
      />
    </View>
  );
}

function ChannelCard({
  channel,
  settings,
  isFav,
  onToggleFavorite,
  onPress,
  columns,
}: {
  channel: Channel;
  settings: AppSettings;
  isFav: boolean;
  onToggleFavorite: () => void;
  onPress: () => void;
  columns: number;
}) {
  const screenW = Dimensions.get('window').width;
  const cardW = (screenW - 10 * 2 - (columns - 1) * 10) / columns;
  return (
    <TouchableOpacity style={[styles.chCard, { width: cardW }]} onPress={onPress}>
      <View style={styles.chLogoBox}>
        {settings.showLogos && channel.logo ? (
          <Image source={{ uri: channel.logo }} style={styles.chLogoImg} resizeMode="contain" />
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
    </TouchableOpacity>
  );
}

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
}: {
  search: string;
  setSearch: (s: string) => void;
  results: Channel[];
  settings: AppSettings;
  favorites: string[];
  onToggleFavorite: (url: string) => void;
  onOpenChannel: (ch: Channel) => void;
}) {
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
        keyExtractor={(item) => item.id}
        numColumns={settings.gridColumns}
        contentContainerStyle={{ padding: 10, paddingBottom: 90 }}
        columnWrapperStyle={settings.gridColumns > 1 ? { gap: 10 } : undefined}
        renderItem={({ item }) => (
          <ChannelCard
            channel={item}
            settings={settings}
            isFav={favorites.includes(item.url)}
            onToggleFavorite={() => onToggleFavorite(item.url)}
            onPress={() => onOpenChannel(item)}
            columns={settings.gridColumns}
          />
        )}
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
  playerTitle: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 },
  playerFav: { color: GOLD, fontSize: 22 },
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
