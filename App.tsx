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
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';

// ─────────────────────────────────────────────────────────────────────────
// SOZLAMALAR — shu havolani almashtirsangiz, ilova boshqa pleylistni
// ko'rsatadi. Foydalanuvchi hech narsa kiritmaydi, avtomatik yuklanadi.
// ─────────────────────────────────────────────────────────────────────────
const PLAYLIST_URL = 'https://mirovoytv.uz/playlists/813bc163.m3u';
const APP_NAME = 'Mirovoy TV';
const UNGROUPED_LABEL = 'Boshqa';

type Channel = {
  id: string;
  name: string;
  url: string;
  group: string;
};

// Oddiy, mustahkam M3U parser — #EXTINF qatoridan group-title va nomni,
// undan keyingi bo'sh bo'lmagan qatordan URL manzilini oladi.
function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let pendingName = '';
  let pendingGroup = '';
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch?.[1]?.trim() || UNGROUPED_LABEL;
      const afterComma = line.split(',').slice(1).join(',').trim();
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      pendingName = afterComma || nameMatch?.[1]?.trim() || `Kanal ${idx + 1}`;
      continue;
    }
    if (line.startsWith('#')) continue;

    idx += 1;
    channels.push({
      id: `${idx}`,
      name: pendingName || `Kanal ${idx}`,
      url: line,
      group: pendingGroup || UNGROUPED_LABEL,
    });
    pendingName = '';
    pendingGroup = '';
  }
  return channels;
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [search, setSearch] = useState('');
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const videoRef = useRef<Video>(null);

  const load = useCallback(() => {
    setStatus('loading');
    fetch(PLAYLIST_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        const parsed = parseM3U(text);
        if (parsed.length === 0) throw new Error('Bo\u2018sh pleylist');
        setChannels(parsed);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Pleyerda orqaga tugmasi ro'yxatga qaytaradi, ilovadan chiqib ketmaydi
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeChannel) {
        setActiveChannel(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [activeChannel]);

  const filtered = useMemo(() => {
    if (!search.trim()) return channels;
    const q = search.trim().toLowerCase();
    return channels.filter(
      (c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [channels, search]);

  const openChannel = (ch: Channel) => {
    setPlayerError(false);
    setActiveChannel(ch);
  };

  // ── Pleyer ekrani ────────────────────────────────────────────────────
  if (activeChannel) {
    return (
      <SafeAreaView style={styles.playerRoot}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <Video
          ref={videoRef}
          style={styles.video}
          source={{ uri: activeChannel.url }}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          useNativeControls
          onError={() => setPlayerError(true)}
        />
        <View style={styles.playerBar}>
          <TouchableOpacity onPress={() => setActiveChannel(null)} style={styles.backBtn}>
            <Text style={styles.backBtnText}>{'\u2190'} Orqaga</Text>
          </TouchableOpacity>
          <Text style={styles.playerTitle} numberOfLines={1}>
            {activeChannel.name}
          </Text>
        </View>
        {playerError && (
          <View style={styles.playerErrorBox}>
            <Text style={styles.playerErrorText}>
              Bu kanal hozircha ochilmadi. Boshqa kanalni tanlab ko'ring.
            </Text>
          </View>
        )}
      </SafeAreaView>
    );
  }

  // ── Ro'yxat ekrani ───────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{APP_NAME}</Text>
        <Text style={styles.headerSubtitle}>{channels.length} ta kanal</Text>
      </View>

      {status === 'ready' && (
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Kanal yoki kategoriya qidirish..."
          placeholderTextColor="#64748b"
          style={styles.search}
        />
      )}

      {status === 'loading' && (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.centerText}>Pleylist yuklanmoqda...</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centerBox}>
          <Text style={styles.centerText}>Pleylistni yuklab bo'lmadi.</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Qayta urinish</Text>
          </TouchableOpacity>
        </View>
      )}

      {status === 'ready' && (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => openChannel(item)}>
              <View style={styles.rowDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowGroup} numberOfLines={1}>
                  {item.group}
                </Text>
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.centerBox}>
              <Text style={styles.centerText}>Hech narsa topilmadi</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e293b',
  },
  headerTitle: { color: '#fff', fontSize: 24, fontWeight: '800' },
  headerSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  search: {
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 6,
    backgroundColor: '#1e293b',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e293b',
  },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#6366f1',
    marginRight: 14,
  },
  rowTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowGroup: { color: '#64748b', fontSize: 12, marginTop: 2 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { color: '#94a3b8', fontSize: 14, textAlign: 'center' },
  retryBtn: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 8,
  },
  retryBtnText: { color: '#fff', fontWeight: '700' },
  playerRoot: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, backgroundColor: '#000' },
  playerBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  backBtn: { marginRight: 14 },
  backBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  playerTitle: { color: '#fff', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  playerErrorBox: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 12,
    padding: 14,
  },
  playerErrorText: { color: '#fff', textAlign: 'center', fontSize: 13 },
});
