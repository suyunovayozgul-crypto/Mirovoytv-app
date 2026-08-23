// ═══════════════════════════════════════════════════════════════════════
//  EPG (Dastur jadvali) — oktv.uz'ning XMLTV (gzip) manbasidan yuklab,
//  tahlil qiladi va pleylist kanallariga moslashtiradi.
//
//  XMLTV formati (soddalashtirilgan misol):
//    <channel id="ctc.ru">
//      <display-name>СТС</display-name>
//    </channel>
//    <programme start="20260806193000 +0500" stop="20260806200000 +0500" channel="ctc.ru">
//      <title>Dastur nomi</title>
//      <desc>Tavsif...</desc>
//    </programme>
//
//  To'liq XML parser ulash (masalan react-native-xml2js) ilova hajmini
//  keraksiz kattalashtiradi — XMLTV struktura juda barqaror bo'lgani
//  uchun bu yerda YENGIL regex-asosli parser ishlatilgan. Bu yondashuv
//  ko'plab ochiq IPTV pleyerlarida (shu jumladan mobil ilovalarda)
//  keng qo'llaniladi.
// ═══════════════════════════════════════════════════════════════════════
import pako from 'pako';

export const EPG_URL = 'https://iptvx.one/epg/epg_lite.xml.gz';

export type EpgProgram = {
  start: number; // unix ms
  stop: number;  // unix ms
  title: string;
  desc: string;
};

export type EpgData = {
  // channel id (xmltv) -> ko'rsatuvlar ro'yxati (vaqt bo'yicha tartiblangan)
  programsById: Map<string, EpgProgram[]>;
  // normallashtirilgan kanal nomi -> xmltv channel id (moslashtirish uchun)
  nameToId: Map<string, string>;
};

// EpgData ichidagi Map'lar to'g'ridan-to'g'ri JSON.stringify bo'lmaydi
// (bo'sh {} bo'lib qoladi) — shuning uchun keshlash uchun oddiy massivga
// aylantirib olamiz, o'qishda esa qaytadan Map'ga tiklaymiz.
export function serializeEpg(epg: EpgData): string {
  return JSON.stringify({
    programsById: Array.from(epg.programsById.entries()),
    nameToId: Array.from(epg.nameToId.entries()),
  });
}

export function deserializeEpg(raw: string): EpgData {
  const obj = JSON.parse(raw);
  return {
    programsById: new Map(obj.programsById),
    nameToId: new Map(obj.nameToId),
  };
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // diakritik belgilarni olib tashlash
    // Qavs ichidagi izohlarni butunlay olib tashlaymiz (masalan "(orig)",
    // "(4K)") — bular pleylistda bor, lekin EPG manbasidagi kanal
    // nomida odatda yo'q, shuning uchun ular solishtirishga xalaqit
    // bermasin.
    .replace(/\([^)]*\)/g, '')
    .replace(/\bhd\b|\bfhd\b|\b4k\b|\buz\b|\bru\b|\borig\b/g, '')
    .replace(/[^a-z0-9\u0400-\u04FF]+/g, '')
    .trim();
}

// XMLTV vaqt format: "20260806193000 +0500" -> unix ms
function parseXmltvTime(raw: string): number {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz) {
    iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
  } else {
    iso += 'Z';
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Ba'zi EPG manbalari matn ichida JS-uslubidagi unicode kodlarni
    // (masalan \u2014 — tire belgisi) xom holda qoldiradi, chunki ular
    // dastlab JSON'dan XML'ga to'g'ridan-to'g'ri ko'chirilgan. Bularni
    // haqiqiy belgiga aylantiramiz — aks holda ekranda "\u2014" deb
    // matn ko'rinib qoladi.
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // XML raqamli belgi havolalari (masalan &#8212; yoki &#x2014;)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

/** EPG'ni yuklab, tahlil qilib beradi. Xato bo'lsa bo'sh natija qaytaradi
 * (EPG bo'lmasa ham ilova ishlashda davom etishi kerak). */
export async function fetchEpg(): Promise<EpgData> {
  const empty: EpgData = { programsById: new Map(), nameToId: new Map() };
  try {
    // MUHIM: ba'zi manba serverlar headersiz so'rovlarni bloklashi
    // mumkin — xuddi video oqimi va logotiplarda bo'lgani kabi. Shu
    // sabab bu yerga ham brauzerga o'xshash User-Agent/Referer qo'shamiz,
    // aks holda EPG butunlay bo'sh qaytishi mumkin. Referer EPG_URL'ning
    // o'z domenidan avtomatik olinadi — manba keyinchalik almashtirilsa,
    // bu yerni qo'lda o'zgartirish shart bo'lmaydi.
    let epgReferer = 'https://iptvx.one/';
    try {
      const u = new URL(EPG_URL);
      epgReferer = `${u.protocol}//${u.host}/`;
    } catch (e) {
      // URL tahlil qilinmasa, standart referer bilan davom etamiz
    }
    const res = await fetch(EPG_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: epgReferer,
      },
    });
    if (!res.ok) return empty;

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);

    let xml: string;
    // gzip magic bayt: 1F 8B — shu bo'lmasa, fayl allaqachon ochilgan
    // (ba'zi serverlar Content-Encoding orqali avtomatik ochib beradi)
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const inflated = pako.ungzip(bytes);
      xml = new TextDecoder('utf-8').decode(inflated);
    } else {
      xml = new TextDecoder('utf-8').decode(bytes);
    }

    return await parseXmltv(xml);
  } catch (e) {
    return empty;
  }
}

export async function parseXmltv(xml: string): Promise<EpgData> {
  return parseXmltvChunked(xml);
}

// JS ipini bloklamaslik uchun bitta event-loop navbatini bo'shatadi.
function yieldToJs(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** XMLTV'ni BO'LAKLARGA bo'lib tahlil qiladi — har N ta yozuvdan keyin
 * JS ipini bo'shatadi (yieldToJs), shunda katta faylda (o'nlab minglab
 * <programme> bo'lishi mumkin) tahlil paytida ham interfeys "qotib"
 * qolmaydi, tugmalar bosilishda javob berishda davom etadi. */
async function parseXmltvChunked(xml: string): Promise<EpgData> {
  const CHUNK_SIZE = 500; // har 500 ta yozuvdan keyin bir marta "nafas olish"
  const programsById = new Map<string, EpgProgram[]>();
  const nameToId = new Map<string, string>();

  // <channel id="...">...<display-name>...</display-name>...</channel>
  const channelRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let cm: RegExpExecArray | null;
  let count = 0;
  while ((cm = channelRe.exec(xml))) {
    const id = decodeEntities(cm[1]);
    const inner = cm[2];
    const nameM = inner.match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/);
    if (nameM) {
      const norm = normalizeName(decodeEntities(nameM[1]));
      if (norm && !nameToId.has(norm)) nameToId.set(norm, id);
    }
    if (++count % CHUNK_SIZE === 0) await yieldToJs();
  }

  // <programme start="..." stop="..." channel="...">...<title>...</title>...</programme>
  const progRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
  let pm: RegExpExecArray | null;
  count = 0;
  while ((pm = progRe.exec(xml))) {
    const attrs = pm[1];
    const inner = pm[2];

    const chM = attrs.match(/channel="([^"]+)"/);
    const startM = attrs.match(/start="([^"]+)"/);
    const stopM = attrs.match(/stop="([^"]+)"/);
    if (!chM || !startM || !stopM) continue;

    const channelId = decodeEntities(chM[1]);
    const start = parseXmltvTime(startM[1]);
    const stop = parseXmltvTime(stopM[1]);
    if (!start || !stop) continue;

    const titleM = inner.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const descM = inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);

    const program: EpgProgram = {
      start,
      stop,
      title: titleM ? decodeEntities(titleM[1]).trim() : 'Nomsiz dastur',
      desc: descM ? decodeEntities(descM[1]).trim() : '',
    };

    if (!programsById.has(channelId)) programsById.set(channelId, []);
    programsById.get(channelId)!.push(program);

    if (++count % CHUNK_SIZE === 0) await yieldToJs();
  }

  // Har bir kanal uchun vaqt bo'yicha tartiblab qo'yamiz — endi/keyingi
  // dasturni topish uchun tez binary-friendly bo'lishi uchun.
  for (const list of programsById.values()) {
    list.sort((a, b) => a.start - b.start);
  }

  return { programsById, nameToId };
}

/** Berilgan kanal (tvg-id va/yoki nom) uchun mos EPG channel id'ni topadi. */
export function matchEpgChannelId(
  epg: EpgData,
  channel: { tvgId?: string; name: string }
): string | null {
  if (channel.tvgId && epg.programsById.has(channel.tvgId)) return channel.tvgId;
  const norm = normalizeName(channel.name);
  const byName = epg.nameToId.get(norm);
  if (byName) return byName;
  return null;
}

/** Hozir va keyingi dasturni qaytaradi. */
export function getNowNext(
  epg: EpgData,
  channel: { tvgId?: string; name: string },
  at: number = Date.now()
): { now: EpgProgram | null; next: EpgProgram | null } {
  const id = matchEpgChannelId(epg, channel);
  if (!id) return { now: null, next: null };
  const list = epg.programsById.get(id) || [];

  let now: EpgProgram | null = null;
  let next: EpgProgram | null = null;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.start <= at && at < p.stop) {
      now = p;
      next = list[i + 1] || null;
      break;
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { now, next };
}

/** Kanalning butun kun jadvali (EPG ekrani/oynasi uchun). */
export function getFullSchedule(epg: EpgData, channel: { tvgId?: string; name: string }): EpgProgram[] {
  const id = matchEpgChannelId(epg, channel);
  if (!id) return [];
  return epg.programsById.get(id) || [];
}
