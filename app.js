/* 나의 일기장 — 앱 코드
   저장 구조
   - IndexedDB "my-diary"
     · entries : 일기 1편 = 1개 { id, date, title, body(원본 텍스트), mood, weather, tags[], favorite, photos[{id,name,type,size}], createdAt, updatedAt, schemaVersion }
     · files   : 사진·글꼴 원본 { id, blob, name, type, size, kind, addedAt }
     · kv      : "settings"(글꼴·보기·백업 기록), "jp"(일본어 한마디 기록·보관함)
   - localStorage "diary.draft.<id>" : 작성 중 임시본(앱이 갑자기 꺼졌을 때 복원용)
   원고지는 본문 텍스트를 칸에 배치해 보여 주기만 하므로, 보기 모드를 바꿔도 글은 바뀌지 않아요. */
"use strict";
const APP_VERSION = "2.0.0";

/*PURE-START*/
const SCHEMA_VERSION = 1;
const BACKUP_FORMAT = "my-diary-backup";
const pad2 = n => String(n).padStart(2, "0");
const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const isDateKey = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayNumber = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);

function cpLen(text, i) {
  const c = text.charCodeAt(i);
  return (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) ? 2 : 1;
}
/* 원고지 배치: 문단 첫 칸은 비우고(들여쓰기), 줄바꿈은 그 줄의 남은 칸을 비운다. */
function layoutGrid(text, cols, indent) {
  const cells = [], caret = new Array(text.length + 1);
  let para = true, i = 0;
  while (true) {
    if (para) { if (indent) cells.push({ ch: "", i, f: 1 }); para = false; }
    if (i >= text.length) { caret[text.length] = cells.length; break; }
    const ch = text[i];
    if (ch === "\n") {
      caret[i] = cells.length;
      const rem = (cols - (cells.length % cols)) % cols;
      for (let k = 0; k < rem; k++) cells.push({ ch: "", i, e: 1 });
      para = true; i++; continue;
    }
    const n = cpLen(text, i);
    caret[i] = cells.length; if (n === 2) caret[i + 1] = cells.length;
    cells.push({ ch: text.slice(i, i + n), i });
    i += n;
  }
  return { cells, caret, cols, len: text.length };
}
function cellToIndex(L, c, rightHalf) {
  if (c < 0) return 0;
  if (c >= L.cells.length) return L.len;
  const cell = L.cells[c];
  if (cell.f || cell.e) return cell.i;
  return cell.i + (rightHalf ? cell.ch.length : 0);
}
function caretCell(L, idx) {
  let k = Math.max(0, Math.min(idx, L.len));
  while (k > 0 && L.caret[k] === undefined) k--;
  return L.caret[k] ?? 0;
}

const MOODS = ["행복", "설렘", "평온", "뿌듯", "그저 그래", "피곤", "불안", "우울", "화남"];
const WEATHERS = ["맑음", "구름", "흐림", "비", "눈", "바람"];

function newId(prefix) { return (prefix || "e") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function normalizeEntry(e) {
  const tags = Array.isArray(e.tags) ? [...new Set(e.tags.filter(t => typeof t === "string").map(t => t.trim()).filter(Boolean))] : [];
  const photos = Array.isArray(e.photos) ? e.photos.filter(p => p && typeof p.id === "string").map(p => ({
    id: p.id, name: String(p.name || ""), type: String(p.type || ""), size: Number(p.size) || 0, addedAt: Number(p.addedAt) || 0
  })) : [];
  return {
    id: String(e.id), date: e.date, title: String(e.title || ""), body: String(e.body || ""),
    mood: String(e.mood || ""), weather: String(e.weather || ""), tags, favorite: !!e.favorite, photos,
    createdAt: Number(e.createdAt) || Number(e.updatedAt) || 0, updatedAt: Number(e.updatedAt) || 0,
    schemaVersion: SCHEMA_VERSION
  };
}
function entryIsEmpty(e) { return !e.title.trim() && !e.body.trim() && !e.photos.length; }
function collectFileIds(entries, settings) {
  const ids = new Set();
  entries.forEach(e => (e.photos || []).forEach(p => ids.add(p.id)));
  ((settings && settings.fonts) || []).forEach(f => ids.add(f.id));
  return [...ids];
}
function buildBackup({ entries, settings, files, missing, extra, exportedAt }) {
  return {
    format: BACKUP_FORMAT, version: SCHEMA_VERSION, app: "나의 일기장 " + (typeof APP_VERSION === "string" ? APP_VERSION : ""),
    exportedAt: exportedAt || new Date().toISOString(),
    counts: { entries: entries.length, files: Object.keys(files || {}).length },
    settings: settings || null, entries: entries.map(normalizeEntry),
    files: files || {}, missingFiles: missing || [], extra: extra || {}
  };
}
function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["파일 내용을 읽을 수 없어요."] };
  if (obj.format !== BACKUP_FORMAT) errors.push("이 일기장의 백업 파일이 아니에요.");
  if (typeof obj.version !== "number" || obj.version > SCHEMA_VERSION) errors.push("더 새로운 버전에서 만든 백업이에요. 앱을 업데이트한 뒤 복원해 주세요.");
  if (!Array.isArray(obj.entries)) errors.push("일기 목록이 없어요.");
  if (errors.length) return { ok: false, errors };
  const entries = []; let badCount = 0;
  obj.entries.forEach(e => {
    if (e && typeof e.id === "string" && isDateKey(e.date)) entries.push(normalizeEntry(e)); else badCount++;
  });
  return { ok: true, errors, entries, badCount, files: obj.files || {}, settings: obj.settings || null, extra: obj.extra || {}, exportedAt: obj.exportedAt || "" };
}
function mergePlan(incoming, existing) {
  const toWrite = [], kept = [];
  incoming.forEach(e => {
    const cur = existing.get(e.id);
    if (cur && (cur.updatedAt || 0) > (e.updatedAt || 0)) kept.push(e.id); else toWrite.push(e);
  });
  return { toWrite, kept };
}
function remapEntry(e, idMap) {
  return { ...e, photos: e.photos.filter(p => idMap[p.id] !== null).map(p => ({ ...p, id: idMap[p.id] || p.id })) };
}
function searchEntries(list, q, opts) {
  const s = (q || "").trim().toLowerCase();
  return list.filter(e => {
    if (opts && opts.fav && !e.favorite) return false;
    if (opts && opts.tag && !e.tags.includes(opts.tag)) return false;
    if (!s) return true;
    return e.title.toLowerCase().includes(s) || e.body.toLowerCase().includes(s) || e.tags.some(t => t.toLowerCase().includes(s));
  }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}
function charCount(t) { let n = 0; for (const ch of t) if (ch !== "\n") n++; return n; }

/* 히라가나·가타카나 → 한국어 발음 (예: じぶんの ペースで いい → 지분노 페에스데 이이) */
function kanaToHangul(src) {
  const C = { "": 11, k: 15, g: 0, s: 9, z: 12, t: 16, d: 3, n: 2, h: 18, b: 7, p: 17, m: 6, y: 11, r: 5, w: 11, ch: 14, j: 12, ts: 14 };
  const V = { a: 0, i: 20, u: 13, e: 5, o: 8, ya: 2, yu: 17, yo: 12, eu: 18, wa: 9, wi: 16, we: 15, wo: 14 };
  const T = {};
  const add = (kana, list) => [...kana].forEach((k, n) => { T[k] = list[n]; });
  const row = (kana, c, vs) => add(kana, vs.map(v => [c, v]));
  row("あいうえお", "", ["a", "i", "u", "e", "o"]);
  row("かきくけこ", "k", ["a", "i", "u", "e", "o"]);
  row("がぎぐげご", "g", ["a", "i", "u", "e", "o"]);
  add("さしすせそ", [["s", "a"], ["s", "i"], ["s", "eu"], ["s", "e"], ["s", "o"]]);
  add("ざじずぜぞ", [["z", "a"], ["j", "i"], ["z", "eu"], ["z", "e"], ["z", "o"]]);
  add("たちつてと", [["t", "a"], ["ch", "i"], ["ts", "eu"], ["t", "e"], ["t", "o"]]);
  add("だぢづでど", [["d", "a"], ["j", "i"], ["z", "eu"], ["d", "e"], ["d", "o"]]);
  row("なにぬねの", "n", ["a", "i", "u", "e", "o"]);
  row("はひふへほ", "h", ["a", "i", "u", "e", "o"]);
  row("ばびぶべぼ", "b", ["a", "i", "u", "e", "o"]);
  row("ぱぴぷぺぽ", "p", ["a", "i", "u", "e", "o"]);
  row("まみむめも", "m", ["a", "i", "u", "e", "o"]);
  add("やゆよ", [["", "ya"], ["", "yu"], ["", "yo"]]);
  row("らりるれろ", "r", ["a", "i", "u", "e", "o"]);
  add("わを", [["w", "wa"], ["", "o"]]);
  const small = { "ゃ": "ya", "ゅ": "yu", "ょ": "yo" };
  const smallV = { "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o" };
  const plainY = { ya: "a", yu: "u", yo: "o" };
  const punct = { "。": ". ", "、": ", ", "！": "! ", "？": "? ", "「": " '", "」": "'", "　": " ", "〜": "~" };
  let s = src.replace(/は_/g, "わ").replace(/へ_/g, "え").replace(/_/g, "");
  s = s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const out = [];
  const last = () => { const x = out[out.length - 1]; return x && typeof x === "object" ? x : null; };
  for (const ch of s) {
    if (ch === "う") { const L0 = last(); if (L0 && !L0.j && (L0.v === "o" || L0.v === "yo")) { out.push({ c: "", v: "o", j: 0 }); continue; } }
    if (T[ch]) { const [c, v] = T[ch]; out.push({ c, v, j: 0 }); continue; }
    const L = last();
    if (small[ch] && L) { const y = small[ch]; L.v = (L.c === "ch" || L.c === "j" || L.c === "ts" || L.c === "z") ? plainY[y] : y; continue; }
    if (smallV[ch] && L) { L.v = L.c === "h" && L.v === "u" ? ({ a: "wa", i: "wi", e: "we", o: "wo", u: "u" })[smallV[ch]] : smallV[ch]; continue; }
    if (ch === "っ") { if (L) L.j = 19; continue; }
    if (ch === "ん") { if (L && !L.j) L.j = 4; else out.push({ c: "", v: "eu", j: 4 }); continue; }
    if (ch === "ー") { if (L) { const base = { ya: "a", yu: "u", yo: "o", eu: "u", wa: "a" }[L.v] || L.v; out.push({ c: "", v: base, j: 0 }); } continue; }
    out.push(punct[ch] ?? ch);
  }
  return out.map(x => typeof x === "string" ? x : String.fromCharCode(0xAC00 + (C[x.c] * 21 + V[x.v]) * 28 + x.j)).join("")
    .replace(/ +([,.!?'])(?=\s|$)/g, "$1").replace(/\s+/g, " ").replace(/' ([.,!?])/g, "'$1").trim();
}
function buildPhrases(raw) {
  return raw.map((r, i) => ({ i, topic: r[0], jp: r[1], kana: r[2].replace(/_/g, ""), pron: kanaToHangul(r[2]), ko: r[3], words: r[4] || [], note: r[5] || "" }));
}
function seededOrder(n, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const o = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

/* ZIP (무압축) — 사진은 이미 압축된 파일이라 그대로 담는다. 백업 파일을 일반 압축 프로그램으로도 열 수 있다. */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(items, onProgress) {
  const enc = new TextEncoder(), parts = [], central = [];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const blob = typeof it.data === "string" ? new Blob([enc.encode(it.data)]) : (it.data instanceof Blob ? it.data : new Blob([it.data]));
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const size = blob.size, name = enc.encode(it.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
    if (onProgress) onProgress(n + 1, items.length);
  }
  const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, items.length, true); end.setUint16(10, items.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
async function readZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error("zip");
  const count = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder(), files = {};
  let q = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(q, true) !== 0x02014b50) throw new Error("zip");
    const method = cd.getUint16(q + 10, true), size = cd.getUint32(q + 20, true);
    const nl = cd.getUint16(q + 28, true), el = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true), off = cd.getUint32(q + 42, true);
    files[dec.decode(new Uint8Array(cd.buffer, q + 46, nl))] = { method, size, off };
    q += 46 + nl + el + cl;
  }
  return {
    names: Object.keys(files),
    async blob(name, type) {
      const f = files[name]; if (!f) return null;
      if (f.method !== 0) throw new Error("method");
      const lh = new DataView(await blob.slice(f.off, f.off + 30).arrayBuffer());
      const start = f.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      return blob.slice(start, start + f.size, type || "");
    },
    async text(name) { const b = await this.blob(name); return b ? b.text() : null; }
  };
}
/*PURE-END*/

(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const SYS_STACK = 'system-ui, -apple-system, "SamsungOneKorean", "Samsung Sans", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
const now = () => new Date();
const todayKey = () => dateKey(now());
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  keys(prefix) { try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)); } catch { return []; } }
};
const defaultSettings = () => ({ fontId: "system", fonts: [], fontSize: 18, letterSpacing: 0, lineHeight: 1.9, defaultView: "grid", lastBackupAt: 0, backupNudgeAt: 0, schemaVersion: SCHEMA_VERSION });
const PH = buildPhrases(typeof PHRASES_RAW !== "undefined" ? PHRASES_RAW : []);

const S = {
  ready: false, entries: new Map(), settings: Object.assign(defaultSettings(), ls.get("diary.settings", {})),
  view: "home", month: new Date(now().getFullYear(), now().getMonth(), 1), selDate: todayKey(),
  q: "", filter: { fav: false, tag: "" }, jpTab: "fav", jpQ: "", persistAsked: false
};
const JP = { state: { seed: 0, daily: null, history: [], pos: -1, favs: [] }, revealed: false };
let E = null;

/* ---------- IndexedDB ---------- */
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (!("indexedDB" in window)) { rej(new Error("no-idb")); return; }
      const r = indexedDB.open("my-diary", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("entries")) d.createObjectStore("entries", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" });
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      r.onsuccess = () => {
        IDB.db = r.result;
        IDB.db.onversionchange = () => { IDB.db.close(); banner("앱이 새 버전으로 바뀌었어요. 앱을 닫았다가 다시 열어 주세요."); };
        res(IDB.db);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  done(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("abort")); }); },
  async put(store, val, key) { const t = IDB.db.transaction(store, "readwrite"); t.objectStore(store).put(val, key); await IDB.done(t); },
  async get(store, key) { return IDB.req(IDB.db.transaction(store).objectStore(store).get(key)); },
  async all(store) { return IDB.req(IDB.db.transaction(store).objectStore(store).getAll()); },
  async keys(store) { return IDB.req(IDB.db.transaction(store).objectStore(store).getAllKeys()); },
  async del(store, key) { const t = IDB.db.transaction(store, "readwrite"); t.objectStore(store).delete(key); await IDB.done(t); }
};
function errText(err) {
  const n = err && (err.name || err.code);
  if (n === "QuotaExceededError" || n === "local_full") return "휴대폰 저장 공간이 부족해요";
  return "저장하지 못했어요";
}

/* ---------- 파일(사진·글꼴) ---------- */
const urlCache = new Map();
async function fileUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const f = await IDB.get("files", id).catch(() => null);
  if (!f || !f.blob) return "";
  const u = URL.createObjectURL(f.blob); urlCache.set(id, u); return u;
}
function hydrate(root) {
  root.querySelectorAll("img[data-file]").forEach(async img => {
    const u = await fileUrl(img.dataset.file);
    if (u) img.src = u; else { img.alt = "사진 없음"; img.removeAttribute("data-file"); }
  });
}
async function putFile(id, blob, meta) {
  await IDB.put("files", { id, blob, name: meta.name || "", type: meta.type || blob.type || "", size: blob.size, kind: meta.kind || "photo", addedAt: Date.now() });
  return id;
}
async function deleteFile(id) {
  try { await IDB.del("files", id); } catch {}
  const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
}
async function askPersist() {
  if (S.persistAsked) return; S.persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

/* ---------- 토스트 · 시트 · 배너 ---------- */
let toastT;
function toast(msg, ms) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms || 2400);
}
function sheet({ title, text, ok, okClass, cancel, onOk, extra, actions }) {
  const root = $("overlayRoot");
  const btns = actions
    ? `<div class="stack">${actions.map((a, n) => `<button class="btn ${a.cls || ""}" data-a="${n}">${esc(a.label)}</button>`).join("")}<button class="btn quiet" id="shNo">${esc(cancel || "닫기")}</button></div>`
    : `<div class="row"><button class="btn quiet" id="shNo">${esc(cancel || "취소")}</button><button class="btn ${okClass || ""}" id="shOk">${esc(ok || "확인")}</button></div>`;
  root.innerHTML = `<div class="overlay" id="ov"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shT">
    <h4 id="shT">${esc(title)}</h4>${text ? `<p>${esc(text)}</p>` : ""}${extra || ""}${btns}</div></div>`;
  const close = () => { root.innerHTML = ""; };
  $("ov").addEventListener("click", e => { if (e.target.id === "ov") close(); });
  $("shNo").onclick = close;
  if (actions) root.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { const a = actions[Number(b.dataset.a)]; b.disabled = true; try { await a.run(); } finally { if (!a.keepOpen) close(); else b.disabled = false; } });
  else { $("shOk").onclick = async () => { $("shOk").disabled = true; try { await onOk(); } finally { close(); } }; $("shOk").focus(); }
}
function banner(text, buttons) {
  const b = document.createElement("div"); b.className = "banner";
  const t = document.createElement("div"); t.textContent = text; b.appendChild(t);
  if (buttons && buttons.length) {
    const row = document.createElement("div"); row.className = "row";
    buttons.forEach(x => { const btn = document.createElement("button"); btn.className = "btn " + (x.cls || ""); btn.textContent = x.label; btn.onclick = () => x.run(b); row.appendChild(btn); });
    b.appendChild(row);
  }
  $("banners").appendChild(b); return b;
}

/* ---------- 저장소 ---------- */
const store = {
  async saveEntry(e) { await IDB.put("entries", e); S.entries.set(e.id, e); onEntriesChanged(); askPersist(); },
  async deleteEntry(id) { await IDB.del("entries", id); S.entries.delete(id); onEntriesChanged(); },
  saveSettingsSoon() {
    ls.set("diary.settings", S.settings);
    clearTimeout(store._st);
    store._st = setTimeout(() => { IDB.put("kv", { ...S.settings }, "settings").catch(() => toast("설정을 저장하지 못했어요")); }, 300);
  },
  saveJp() { IDB.put("kv", JSON.parse(JSON.stringify(JP.state)), "jp").catch(() => {}); }
};

/* ---------- 글꼴 ---------- */
const loadedFaces = new Set();
async function ensureFont(f) {
  if (loadedFaces.has(f.id)) return true;
  try {
    const rec = await IDB.get("files", f.id); if (!rec) return false;
    const face = new FontFace("UF-" + f.id, await rec.blob.arrayBuffer());
    await face.load(); document.fonts.add(face); loadedFaces.add(f.id); return true;
  } catch { return false; }
}
async function applyFont() {
  const s = S.settings, r = document.documentElement.style;
  r.setProperty("--fs", s.fontSize + "px");
  r.setProperty("--ls", s.letterSpacing + "em");
  r.setProperty("--lh", String(s.lineHeight));
  let fam = SYS_STACK;
  const f = s.fonts.find(x => x.id === s.fontId);
  if (f && IDB.db) {
    if (await ensureFont(f)) fam = `"UF-${f.id}", ${SYS_STACK}`;
    else toast(`'${f.name}' 글꼴을 불러오지 못해 기본 글꼴로 보여요.`);
  }
  r.setProperty("--uf", fam);
  if (E) renderBody();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (E) renderBody(); });
}

/* ---------- 화면 전환 ---------- */
function show(view) {
  S.view = view;
  ["home", "list", "jp", "settings", "editor"].forEach(v => { $("v-" + v).hidden = v !== view; });
  ["home", "jp", "settings"].forEach(v => { if (v !== view) $("v-" + v).innerHTML = ""; }); // 같은 id가 두 화면에 겹치지 않게
  $("nav").hidden = view === "editor";
  $("app").classList.toggle("editing", view === "editor");
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", b.dataset.v === view ? "page" : "false"));
  if (view === "home") renderHome();
  if (view === "list") renderList();
  if (view === "jp") renderJpView();
  if (view === "settings") renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav button").forEach(b => b.onclick = () => show(b.dataset.v));

function entryList() { return [...S.entries.values()]; }
function byDate(k) { return entryList().filter(e => e.date === k).sort((a, b) => a.createdAt - b.createdAt); }
function fmtDate(k, withDow) { const d = parseKey(k); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일` + (withDow ? ` ${DOW[d.getDay()]}요일` : ""); }
function snippet(e) { return e.body.replace(/\s+/g, " ").trim().slice(0, 80); }
function itemHtml(e, showDate) {
  const d = parseKey(e.date);
  const meta = [showDate ? `${d.getFullYear() !== now().getFullYear() ? d.getFullYear() + ". " : ""}${d.getMonth() + 1}. ${d.getDate()}. ${DOW[d.getDay()]}` : "", e.mood, e.weather, ...e.tags.map(t => "#" + t)].filter(Boolean);
  const title = e.title || snippet(e).slice(0, 30) || (e.photos.length ? "사진 일기" : "제목 없음");
  return `<button class="item" data-id="${esc(e.id)}"><div style="min-width:0">
    <div class="t">${e.favorite ? '<span class="star" aria-label="즐겨찾기">★</span> ' : ""}${esc(title)}</div>
    ${e.title && snippet(e) ? `<div class="p">${esc(snippet(e))}</div>` : ""}
    ${meta.length ? `<div class="meta">${meta.map(esc).join(" · ")}</div>` : ""}
  </div>${e.photos[0] ? `<img data-file="${esc(e.photos[0].id)}" alt="">` : ""}</button>`;
}
function bindItems(root) {
  root.querySelectorAll(".item[data-id]").forEach(b => b.onclick = () => openEditor(S.entries.get(b.dataset.id)));
  hydrate(root);
}

/* ---------- 오늘의 일본어 한마디 ---------- */
function jpRoll() {
  if (!PH.length) return false;
  const st = JP.state, tk = todayKey();
  if (!st.seed) st.seed = (Math.random() * 2 ** 31) | 0;
  if (!st.daily || st.daily.date !== tk) {
    const idx = seededOrder(PH.length, st.seed)[dayNumber(now()) % PH.length];
    st.daily = { date: tk, idx }; jpPush(idx); JP.revealed = false; store.saveJp(); return true;
  }
  if (st.pos < 0 || st.pos >= st.history.length) jpPush(st.daily.idx);
  return false;
}
function jpPush(idx) { const h = JP.state.history; h.push(idx); if (h.length > 300) h.splice(0, h.length - 300); JP.state.pos = h.length - 1; }
function jpCur() { return PH[JP.state.history[JP.state.pos] ?? (JP.state.daily ? JP.state.daily.idx : 0)]; }
function jpNext() {
  const st = JP.state;
  if (st.pos < st.history.length - 1) st.pos++;
  else {
    const recent = new Set(st.history.slice(-60)); let idx = 0;
    for (let t = 0; t < 60; t++) { idx = Math.floor(Math.random() * PH.length); if (!recent.has(idx)) break; }
    jpPush(idx);
  }
  JP.revealed = false; store.saveJp();
}
function jpPrev() { if (JP.state.pos > 0) { JP.state.pos--; JP.revealed = false; store.saveJp(); } }
function isFav(i) { return JP.state.favs.some(f => f.i === i); }
function toggleFav(i) {
  const st = JP.state;
  if (isFav(i)) { st.favs = st.favs.filter(f => f.i !== i); toast("보관함에서 뺐어요"); }
  else { st.favs.unshift({ i, at: Date.now() }); toast("일본어 보관함에 담았어요"); }
  store.saveJp();
}
function speak(text) {
  if (!("speechSynthesis" in window)) { toast("이 기기에서는 음성 듣기를 쓸 수 없어요."); return; }
  const synth = window.speechSynthesis;
  const go = () => {
    const voices = synth.getVoices();
    const v = voices.find(x => /^ja([-_]|$)/i.test(x.lang));
    const u = new SpeechSynthesisUtterance(text); u.lang = "ja-JP"; u.rate = 0.9; if (v) u.voice = v;
    synth.cancel(); synth.speak(u);
    if (!v && voices.length) toast("일본어 음성이 없어 소리가 안 날 수 있어요. 휴대폰 설정에서 'TTS'를 검색해 일본어 음성을 받아 주세요.", 5000);
  };
  if (synth.getVoices().length) go(); else { synth.onvoiceschanged = () => { synth.onvoiceschanged = null; go(); }; setTimeout(go, 400); }
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || "복사했어요"); return; } catch {}
  const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  t.remove(); toast(ok ? (okMsg || "복사했어요") : "복사하지 못했어요");
}
function phraseDetailHtml(p) {
  return `<div class="jp-kana" lang="ja">${esc(p.kana)}</div>
    <div class="jp-pron">${esc(p.pron)}</div>
    <div class="jp-ko">${esc(p.ko)}</div>
    ${p.words.length ? `<div class="jp-words">${p.words.map(w => `<div class="jp-w"><b lang="ja">${esc(w[0])}</b>${w[1] && w[1] !== w[0] ? `<span class="r" lang="ja">${esc(w[1])}</span>` : ""} · ${esc(w[2])}${w[3] ? `<span class="n">${esc(w[3])}</span>` : ""}</div>`).join("")}</div>` : ""}
    ${p.note ? `<div class="jp-note">${esc(p.note)}</div>` : ""}`;
}
const IC = {
  speak: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>'
};
function jpCardHtml() {
  const p = jpCur(); if (!p) return "";
  const isDaily = JP.state.daily && p.i === JP.state.daily.idx;
  return `<div class="card jp" id="jpCard">
    <div class="jp-top"><span class="jp-label" lang="ja">${isDaily ? "今日のひとこと" : "ひとこと"}</span><span class="small muted">${esc(PHRASE_TOPICS[p.topic] || "")}</span></div>
    <button class="jp-main" id="jpReveal" aria-expanded="${JP.revealed}"><span class="jp-text" lang="ja">${esc(p.jp)}</span>${JP.revealed ? "" : '<span class="jp-hint">눌러서 읽는 법과 뜻 보기</span>'}</button>
    <div class="jp-detail" ${JP.revealed ? "" : "hidden"}>${phraseDetailHtml(p)}</div>
    <div class="jp-actions">
      <button class="txt" id="jpPrev" ${JP.state.pos > 0 ? "" : "disabled"}>‹ 이전</button>
      <div class="mid">
        <button class="icon" id="jpSpeak" aria-label="일본어로 듣기">${IC.speak}</button>
        <button class="icon ${isFav(p.i) ? "on" : ""}" id="jpFav" aria-label="보관함에 담기" aria-pressed="${isFav(p.i)}">${IC.star}</button>
        <button class="icon" id="jpCopy" aria-label="문장 복사">${IC.copy}</button>
      </div>
      <button class="txt" id="jpNext">다른 문장 ›</button>
    </div>
  </div>`;
}
function bindJpCard() {
  if (!$("jpCard")) return;
  const p = jpCur();
  const repaint = () => { const old = $("jpCard"); old.outerHTML = jpCardHtml(); bindJpCard(); };
  $("jpReveal").onclick = () => { JP.revealed = !JP.revealed; repaint(); };
  $("jpPrev").onclick = () => { jpPrev(); repaint(); };
  $("jpNext").onclick = () => { jpNext(); repaint(); };
  $("jpSpeak").onclick = () => speak(p.jp);
  $("jpFav").onclick = () => { toggleFav(p.i); repaint(); };
  $("jpCopy").onclick = () => copyText(`${p.jp}\n${p.kana}\n${p.pron}\n${p.ko}`, "문장을 복사했어요");
}
function renderJpView() {
  const v = $("v-jp");
  v.innerHTML = `
    <div class="hello"><div class="d">일본어 문장</div><div class="s">마음에 드는 표현을 모아 두는 곳이에요.</div></div>
    <div id="jpCardSlot">${jpCardHtml()}</div>
    <div class="seg" role="group" aria-label="목록" style="justify-self:start" id="jpTabs"></div>
    <input class="search" id="jpQ" type="search" placeholder="일본어, 뜻, 발음으로 찾기" autocomplete="off">
    <div class="card"><div id="jpList"></div></div>`;
  $("jpQ").value = S.jpQ;
  $("jpQ").addEventListener("input", e => { S.jpQ = e.target.value; paintJpList(); });
  bindJpCardInView();
  paintJpList();
}
function bindJpCardInView() {
  bindJpCard();
  ["jpPrev", "jpNext", "jpFav"].forEach(id => { const b = $(id); if (!b) return; const f = b.onclick; b.onclick = () => { f(); bindJpCardInView(); paintJpList(); }; });
  const r = $("jpReveal"); if (r) { const f = r.onclick; r.onclick = () => { f(); bindJpCardInView(); }; }
}
function paintJpList() {
  const favIds = JP.state.favs.map(f => f.i);
  const seen = [], seenSet = new Set();
  for (let k = JP.state.history.length - 1; k >= 0 && seen.length < 60; k--) { const i = JP.state.history[k]; if (!seenSet.has(i)) { seenSet.add(i); seen.push(i); } }
  const src = S.jpTab === "fav" ? favIds : S.jpTab === "seen" ? seen : PH.map(p => p.i);
  const raw = S.jpQ.trim(), q = raw.toLowerCase();
  const list = src.map(i => PH[i]).filter(p => p && (!raw || p.jp.includes(raw) || p.kana.includes(raw) || p.ko.toLowerCase().includes(q) || p.pron.includes(raw)));
  const tabs = [["fav", `보관함 ${favIds.length}`], ["seen", "지난 문장"], ["all", `전체 ${PH.length}`]];
  $("jpTabs").innerHTML = tabs.map(([k, l]) => `<button data-t="${k}" aria-pressed="${S.jpTab === k}">${esc(l)}</button>`).join("");
  $("jpTabs").querySelectorAll("[data-t]").forEach(b => b.onclick = () => { S.jpTab = b.dataset.t; paintJpList(); });
  const box = $("jpList");
  box.innerHTML = list.length ? list.map(p => `
      <details class="jpi" data-i="${p.i}"><summary><span class="s1" lang="ja">${esc(p.jp)}</span><span class="s2">${esc(p.ko)}</span></summary>
        <div class="body">${phraseDetailHtml(p)}
          <div class="jp-actions"><div class="mid">
            <button class="icon" data-act="speak" aria-label="듣기">${IC.speak}</button>
            <button class="icon ${isFav(p.i) ? "on" : ""}" data-act="fav" aria-label="보관함" aria-pressed="${isFav(p.i)}">${IC.star}</button>
            <button class="icon" data-act="copy" aria-label="복사">${IC.copy}</button></div></div>
        </div></details>`).join("") :
    `<div class="empty">${S.jpTab === "fav" ? (raw ? "찾는 문장이 보관함에 없어요." : "아직 담은 문장이 없어요. 마음에 드는 문장에서 별을 눌러 보세요.") : "맞는 문장이 없어요."}</div>`;
  box.querySelectorAll("details.jpi [data-act]").forEach(b => b.onclick = () => {
    const p = PH[Number(b.closest("details").dataset.i)];
    if (b.dataset.act === "speak") speak(p.jp);
    if (b.dataset.act === "copy") copyText(`${p.jp}\n${p.kana}\n${p.pron}\n${p.ko}`, "문장을 복사했어요");
    if (b.dataset.act === "fav") {
      toggleFav(p.i); b.classList.toggle("on", isFav(p.i)); b.setAttribute("aria-pressed", String(isFav(p.i)));
      if (S.jpTab === "fav" && !isFav(p.i)) paintJpList();
      else $("jpTabs").querySelector('[data-t="fav"]').textContent = `보관함 ${JP.state.favs.length}`;
      $("jpCardSlot").innerHTML = jpCardHtml(); bindJpCardInView();
    }
  });
}

/* ---------- 달력(홈) ---------- */
function renderHome() {
  const v = $("v-home");
  if (jpRoll()) {}
  const t = now(), m = S.month, y = m.getFullYear(), mo = m.getMonth();
  const counts = {};
  entryList().forEach(e => { counts[e.date] = (counts[e.date] || 0) + 1; });
  const first = m.getDay(), n = new Date(y, mo + 1, 0).getDate();
  let cells = DOW.map((d, i) => `<div class="dow${i === 0 ? " sun" : ""}">${d}</div>`).join("");
  for (let i = 0; i < first; i++) cells += `<div class="day blank"></div>`;
  for (let d = 1; d <= n; d++) {
    const k = `${y}-${pad2(mo + 1)}-${pad2(d)}`, c = counts[k] || 0;
    const cls = ["day"]; if (k === todayKey()) cls.push("today"); if (k === S.selDate) cls.push("sel");
    cells += `<button class="${cls.join(" ")}" data-k="${k}" aria-label="${mo + 1}월 ${d}일${c ? `, 일기 ${c}편` : ""}"><span class="n">${d}</span><span class="dots">${"<i></i>".repeat(Math.min(c, 3))}</span></button>`;
  }
  const dayList = byDate(S.selDate);
  const recent = entryList().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const monthCount = entryList().filter(e => e.date.startsWith(`${y}-${pad2(mo + 1)}`)).length;
  const s = S.settings, DAY = 864e5;
  const nudge = S.ready && S.entries.size >= 3 && Date.now() - (s.lastBackupAt || 0) > 30 * DAY && Date.now() - (s.backupNudgeAt || 0) > 14 * DAY;
  v.innerHTML = `
    <div class="hello"><div class="d">${t.getMonth() + 1}월 ${t.getDate()}일 ${DOW[t.getDay()]}요일</div><div class="s">오늘도 나의 속도로.</div></div>
    ${jpCardHtml()}
    ${nudge ? `<div class="banner"><div>${s.lastBackupAt ? "마지막 백업 후 한 달이 지났어요." : "아직 백업 파일이 없어요."} 휴대폰을 바꾸거나 브라우저 데이터를 지우면 기록이 사라질 수 있으니, 가끔 백업 파일을 받아 두세요.</div>
      <div class="row"><button class="btn" id="nuGo">지금 백업하기</button><button class="btn quiet" id="nuLater">다음에</button></div></div>` : ""}
    <div class="card">
      <div class="cal-head">
        <button class="icon" id="cPrev" aria-label="지난 달"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="m">${y}년 ${mo + 1}월</div>
        <button class="icon" id="cNext" aria-label="다음 달"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
      <div class="cal-grid" id="cGrid">${cells}</div>
      <div class="small muted" style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span>${!S.ready ? "불러오는 중…" : monthCount ? `이번 달 기록 ${monthCount}편` : "이번 달 기록이 아직 없어요"}</span>
        <button class="linkbtn a" id="cToday" style="padding:4px 0">오늘로</button>
      </div>
    </div>
    <div class="card">
      <h3>${esc(fmtDate(S.selDate, true))}</h3>
      <div class="list" id="dayList">${dayList.length ? dayList.map(e => itemHtml(e, false)).join("") : `<div class="empty">이 날의 기록은 아직 없어요. 쓰고 싶을 때 언제든 남겨요.</div>`}</div>
      <button class="btn block" id="newHere" style="margin-top:12px" ${S.ready ? "" : "disabled"}>＋ 이 날의 일기 쓰기</button>
    </div>
    <div class="card"><h3>최근에 쓴 일기</h3><div class="list">${recent.length ? recent.map(e => itemHtml(e, true)).join("") : `<div class="empty">첫 일기를 쓰면 여기에 모여요.</div>`}</div></div>`;
  bindJpCard();
  $("cPrev").onclick = () => { S.month = new Date(y, mo - 1, 1); renderHome(); };
  $("cNext").onclick = () => { S.month = new Date(y, mo + 1, 1); renderHome(); };
  $("cToday").onclick = () => { S.month = new Date(now().getFullYear(), now().getMonth(), 1); S.selDate = todayKey(); renderHome(); };
  $("cGrid").onclick = e => { const b = e.target.closest(".day[data-k]"); if (b) { S.selDate = b.dataset.k; renderHome(); } };
  $("newHere").onclick = () => openEditor(null, S.selDate);
  if (nudge) {
    $("nuGo").onclick = () => { show("settings"); setTimeout(() => exportBackup(true), 50); };
    $("nuLater").onclick = () => { S.settings.backupNudgeAt = Date.now(); store.saveSettingsSoon(); renderHome(); };
  }
  bindItems(v);
}

/* ---------- 모아보기 ---------- */
function renderList() {
  const v = $("v-list");
  if (!v.dataset.built) {
    v.dataset.built = "1";
    v.innerHTML = `<div class="hello"><div class="d">모아보기</div></div>
      <input class="search" id="q" type="search" placeholder="제목, 내용, 태그로 찾기" autocomplete="off">
      <div class="chips" id="filters"></div><div class="card"><div class="list" id="results"></div></div>`;
    $("q").addEventListener("input", e => { S.q = e.target.value; paintResults(); });
  }
  $("q").value = S.q;
  paintResults();
}
function paintResults() {
  const tags = [...new Set(entryList().flatMap(e => e.tags))].sort((a, b) => a.localeCompare(b, "ko"));
  if (S.filter.tag && !tags.includes(S.filter.tag)) S.filter.tag = "";
  const f = $("filters");
  f.innerHTML = `<button class="chip" data-f="all" aria-pressed="${!S.filter.fav && !S.filter.tag}">전체</button>
    <button class="chip" data-f="fav" aria-pressed="${S.filter.fav}">★ 즐겨찾기</button>` +
    tags.map(t => `<button class="chip" data-t="${esc(t)}" aria-pressed="${S.filter.tag === t}">#${esc(t)}</button>`).join("");
  f.onclick = e => {
    const b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.f === "all") S.filter = { fav: false, tag: "" };
    else if (b.dataset.f === "fav") S.filter.fav = !S.filter.fav;
    else S.filter.tag = S.filter.tag === b.dataset.t ? "" : b.dataset.t;
    paintResults();
  };
  const res = searchEntries(entryList(), S.q, S.filter);
  const r = $("results");
  r.innerHTML = res.length ? res.map(e => itemHtml(e, true)).join("") :
    `<div class="empty">${entryList().length ? "맞는 일기가 없어요. 다른 말로 찾아보세요." : "아직 쓴 일기가 없어요. 달력에서 날짜를 골라 첫 일기를 써 보세요."}</div>`;
  bindItems(r);
}

/* ---------- 편집기 ---------- */
const ta = $("body");
function openEditor(entry, date) {
  const base = entry ? normalizeEntry(entry) : normalizeEntry({ id: newId("e"), date: date || todayKey(), createdAt: Date.now(), updatedAt: 0 });
  E = { entry: base, isNew: !entry, dirty: false, saving: false, seq: 0, fail: 0, retryT: null, saveT: null,
        view: S.settings.defaultView, H: { stack: [], i: -1, last: 0, group: false }, composing: false };
  fillEditor(); show("editor"); hReset(); paintStatus();
  if (!entry) setTimeout(() => { if (E && E.view === "grid") focusBody(ta.value.length); else ta.focus(); }, 60);
}
function openEditorFromDraft(d) {
  openEditor(S.entries.get(d.entry.id) || null, d.entry.date);
  E.entry = normalizeEntry(d.entry); E.isNew = !S.entries.has(d.entry.id);
  fillEditor(); hReset(); touch(); toast("임시 기록을 되살렸어요. 자동으로 저장할게요.");
}
function fillEditor() {
  const e = E.entry;
  $("eDate").value = e.date; $("eWd").textContent = DOW[parseKey(e.date).getDay()] + "요일";
  $("eTitle").value = e.title; ta.value = e.body;
  paintChips(); paintTags(); paintPhotos(); paintFav(); setMode(E.view, true);
}
function paintFav() { $("eFav").classList.toggle("on", E.entry.favorite); $("eFav").setAttribute("aria-pressed", String(E.entry.favorite)); }
function chipGroup(el, list, field) {
  el.innerHTML = list.map(v => `<button class="chip" type="button" aria-pressed="${E.entry[field] === v}">${esc(v)}</button>`).join("");
  el.onclick = ev => { const b = ev.target.closest(".chip"); if (!b) return; const v = b.textContent; E.entry[field] = E.entry[field] === v ? "" : v; paintChips(); touch(); };
}
function paintChips() { chipGroup($("eMood"), MOODS, "mood"); chipGroup($("eWeather"), WEATHERS, "weather"); }
function paintTags() {
  const box = $("eTags"); box.querySelectorAll(".tag").forEach(x => x.remove());
  E.entry.tags.forEach((t, n) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "tag"; b.setAttribute("aria-label", `태그 ${t} 지우기`);
    b.textContent = "#" + t; const x = document.createElement("b"); x.textContent = "×"; b.append(x);
    b.onclick = () => { E.entry.tags.splice(n, 1); paintTags(); touch(); };
    box.insertBefore(b, $("eTagIn"));
  });
}
function addTag(raw) {
  const t = raw.replace(/^#+/, "").replace(/,/g, "").trim().slice(0, 20);
  if (t && !E.entry.tags.includes(t)) { E.entry.tags.push(t); paintTags(); touch(); }
}
$("eTagIn").addEventListener("keydown", e => {
  if (e.isComposing) return;
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(e.target.value); e.target.value = ""; }
  else if (e.key === "Backspace" && !e.target.value && E.entry.tags.length) { E.entry.tags.pop(); paintTags(); touch(); }
});
$("eTagIn").addEventListener("input", e => { if (e.target.value.includes(",")) { const parts = e.target.value.split(","); parts.slice(0, -1).forEach(addTag); e.target.value = parts.pop(); } });
$("eTagIn").addEventListener("blur", e => { if (e.target.value.trim()) { addTag(e.target.value); e.target.value = ""; } });
$("eTitle").addEventListener("input", e => { E.entry.title = e.target.value; touch(); });
$("eDate").addEventListener("change", e => { if (!isDateKey(e.target.value)) { e.target.value = E.entry.date; return; } E.entry.date = e.target.value; $("eWd").textContent = DOW[parseKey(E.entry.date).getDay()] + "요일"; touch(); });
$("eFav").onclick = () => { E.entry.favorite = !E.entry.favorite; paintFav(); touch(); };
$("eBack").onclick = closeEditor;

async function closeEditor() {
  if (!E) return;
  clearTimeout(E.saveT);
  if (E.isNew && entryIsEmpty(E.entry)) ls.del("diary.draft." + E.entry.id);
  else if (E.dirty) await flush();
  if (E.dirty) toast("아직 저장되지 않았어요. 임시 기록으로 보관해 두었어요.", 3500);
  const d = E.entry.date; E = null;
  S.selDate = d; S.month = new Date(parseKey(d).getFullYear(), parseKey(d).getMonth(), 1);
  show("home");
}

/* ---- 자동 저장 ---- */
let draftT;
function touch() {
  if (!E) return;
  E.dirty = true; E.seq++;
  clearTimeout(draftT); draftT = setTimeout(writeDraft, 250);
  clearTimeout(E.saveT); E.saveT = setTimeout(flush, 800);
  paintStatus();
}
function writeDraft() {
  if (!E || !E.dirty || (E.isNew && entryIsEmpty(E.entry))) return;
  ls.set("diary.draft." + E.entry.id, { entry: E.entry, at: Date.now() });
}
async function flush() {
  if (!E || !E.dirty || E.saving) return;
  if (!S.ready) { E.saveT = setTimeout(flush, 800); return; }
  if (E.isNew && entryIsEmpty(E.entry)) { paintStatus(); return; }
  const ed = E, seq = ed.seq;
  ed.saving = true; paintStatus();
  const rec = normalizeEntry({ ...ed.entry, updatedAt: Date.now() });
  try {
    await store.saveEntry(rec);
    ed.entry.updatedAt = rec.updatedAt; ed.isNew = false; ed.fail = 0; ed.savedAt = rec.updatedAt;
    if (ed.seq === seq) { ed.dirty = false; ls.del("diary.draft." + rec.id); }
  } catch (err) {
    ed.fail++; ed.err = errText(err);
    clearTimeout(ed.retryT); ed.retryT = setTimeout(() => { if (E === ed) flush(); }, Math.min(30000, 2000 * 2 ** (ed.fail - 1)));
  } finally {
    ed.saving = false;
    if (E === ed) { paintStatus(); if (ed.dirty && !ed.fail) { clearTimeout(ed.saveT); ed.saveT = setTimeout(flush, 400); } }
  }
}
function hm(t) { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function paintStatus() {
  if (!E) return;
  const st = $("eStatus"); st.classList.remove("err");
  if (E.saving) st.textContent = "저장하는 중…";
  else if (E.fail) { st.classList.add("err"); st.textContent = `${E.err} · 임시 보관 중, 다시 시도할게요`; }
  else if (E.dirty) st.textContent = E.isNew && entryIsEmpty(E.entry) ? "쓰기 시작하면 자동 저장돼요" : "저장 대기 중";
  else if (E.isNew) st.textContent = "새 일기 · 쓰면 자동 저장돼요";
  else st.textContent = `저장됨 ${hm(E.savedAt || E.entry.updatedAt)}`;
  $("eDelete").hidden = E.isNew;
  $("eCount").textContent = `글자 수 ${charCount(ta.value).toLocaleString()}`;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { if (E) { writeDraft(); flush(); } }
  else if (S.ready && jpRoll() && S.view === "home") renderHome();
});
window.addEventListener("pagehide", () => { if (E) writeDraft(); });

/* ---- 실행 취소 / 다시 실행 ---- */
function hState() { return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd }; }
function hReset() { E.H = { stack: [hState()], i: 0, last: 0, group: false }; paintUndo(); }
function hRecord() {
  const H = E.H, cur = hState(), t = Date.now();
  if (H.stack[H.i] && H.stack[H.i].v === cur.v) return;
  if (H.group && H.i === H.stack.length - 1 && H.i > 0 && t - H.last < 900) H.stack[H.i] = cur;
  else { H.stack = H.stack.slice(0, H.i + 1); H.stack.push(cur); H.i++; if (H.stack.length > 400) { H.stack.shift(); H.i--; } }
  H.group = true; H.last = t; paintUndo();
}
function hApply(step) {
  const H = E.H, j = H.i + step;
  if (j < 0 || j >= H.stack.length) return;
  H.i = j; H.group = false;
  const st = H.stack[j];
  ta.value = st.v; E.entry.body = st.v;
  try { ta.setSelectionRange(st.s, st.e); } catch {}
  renderBody(); touch(); paintUndo();
}
function paintUndo() { if (!E) return; $("bUndo").disabled = E.H.i <= 0; $("bRedo").disabled = E.H.i >= E.H.stack.length - 1; }
function refocus() { if (E.view === "grid") { ta.focus({ preventScroll: true }); renderCaret(); } }
["bUndo", "bRedo", "bCopy"].forEach(id => $(id).addEventListener("pointerdown", e => e.preventDefault()));
$("bUndo").onclick = () => { hApply(-1); refocus(); };
$("bRedo").onclick = () => { hApply(1); refocus(); };
$("bCopy").onclick = () => {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const text = s !== e ? ta.value.slice(s, e) : ta.value;
  if (!text) { toast("복사할 내용이 없어요"); return; }
  copyText(text, s !== e ? "고른 부분을 복사했어요" : "본문 전체를 복사했어요");
};

/* ---- 본문 입력 ---- */
ta.addEventListener("input", () => {
  if (!E) return;
  E.entry.body = ta.value;
  if (!E.composing) hRecord();
  renderBody(true); touch();
});
ta.addEventListener("compositionstart", () => { if (E) { E.composing = true; renderCaret(); } });
ta.addEventListener("compositionend", () => { if (E) { E.composing = false; E.entry.body = ta.value; hRecord(); renderBody(); } });
ta.addEventListener("beforeinput", e => {
  if (!E) return;
  if (e.inputType === "historyUndo") { e.preventDefault(); hApply(-1); }
  else if (e.inputType === "historyRedo") { e.preventDefault(); hApply(1); }
});
ta.addEventListener("keydown", e => {
  if (!E) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); hApply(e.shiftKey ? 1 : -1); return; }
  if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); hApply(1); return; }
  if (E.view === "grid" && !e.isComposing && (e.key === "ArrowUp" || e.key === "ArrowDown") && G.L) {
    e.preventDefault();
    const c = caretCell(G.L, ta.selectionEnd) + (e.key === "ArrowUp" ? -G.L.cols : G.L.cols);
    const idx = c < 0 ? 0 : cellToIndex(G.L, c, false);
    if (e.shiftKey) ta.setSelectionRange(Math.min(ta.selectionStart, idx), Math.max(ta.selectionStart, idx));
    else ta.setSelectionRange(idx, idx);
    renderBody();
  }
});
ta.addEventListener("focus", () => renderBody());
ta.addEventListener("blur", () => renderCaret());
ta.addEventListener("select", () => renderBody());
ta.addEventListener("keyup", () => renderBody());
let selRaf = 0;
document.addEventListener("selectionchange", () => {
  if (!E || document.activeElement !== ta || E.view !== "grid") return;
  cancelAnimationFrame(selRaf); selRaf = requestAnimationFrame(() => renderBody());
});

/* ---- 원고지 / 줄노트 ---- */
const G = { L: null, cols: 0, cell: 0, prev: [] };
function setMode(mode, quiet) {
  if (!E) return;
  const s = ta.selectionStart, e = ta.selectionEnd, wasFocused = document.activeElement === ta;
  E.view = mode;
  $("mGrid").setAttribute("aria-pressed", String(mode === "grid"));
  $("mLines").setAttribute("aria-pressed", String(mode === "lines"));
  ta.className = mode === "grid" ? "ghost" : "lines";
  ta.style.cssText = "";
  $("mgrid").hidden = mode !== "grid";
  G.prev = []; G.cols = 0; $("mgrid").innerHTML = "";
  renderBody();
  if (!quiet && wasFocused) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(s, e); } catch {} renderBody(); }
  if (!quiet && S.settings.defaultView !== mode) { S.settings.defaultView = mode; store.saveSettingsSoon(); }
}
$("mGrid").onclick = () => setMode("grid");
$("mLines").onclick = () => setMode("lines");

let bodyRaf = 0;
function renderBody(scroll) {
  if (!E) return;
  cancelAnimationFrame(bodyRaf);
  bodyRaf = requestAnimationFrame(() => { if (E) (E.view === "grid" ? renderGrid(scroll) : renderLines()); });
}
function renderLines() {
  $("caret").hidden = true; $("gridhint").hidden = true;
  ta.style.height = "auto";
  ta.style.height = Math.max(ta.scrollHeight, 10) + "px";
}
function renderGrid(scroll) {
  const box = $("bodybox"), grid = $("mgrid");
  const W = box.clientWidth - 28;
  if (W <= 0) return;
  const fs = S.settings.fontSize;
  const cols = Math.max(8, Math.min(20, Math.floor(W / (fs * 1.55))));
  const cell = Math.floor((W - 2) / cols * 10) / 10;
  if (cols !== G.cols || cell !== G.cell) { G.prev = []; grid.innerHTML = ""; }
  G.cols = cols; G.cell = cell;
  grid.style.setProperty("--cols", cols);
  grid.style.setProperty("--cell", cell + "px");
  grid.style.setProperty("--gfs", Math.min(fs, Math.floor(cell * 0.68)) + "px");
  grid.style.setProperty("--rowgap", Math.round(cell * 0.22) + "px");
  const text = ta.value, L = layoutGrid(text, cols, true); G.L = L;
  const s = ta.selectionStart, e = ta.selectionEnd, focused = document.activeElement === ta;
  const capCell = caretCell(L, e);
  const used = Math.max(L.cells.length, capCell + 1);
  const rows = Math.max(Math.ceil(used / cols) + 2, 8);
  const compIdx = E.composing && s === e && s > 0 ? s - 1 : -1;
  while (grid.children.length < rows) { const r = document.createElement("div"); r.className = "mrow"; grid.appendChild(r); }
  while (grid.children.length > rows) grid.lastChild.remove();
  for (let r = 0; r < rows; r++) {
    let h = "";
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c, cl = L.cells[k];
      let cls = "";
      if (cl && cl.ch) {
        if (s !== e && cl.i >= s && cl.i < e) cls = "s";
        else if (compIdx >= 0 && cl.i <= compIdx && compIdx < cl.i + cl.ch.length) cls = "k";
      }
      h += `<span data-c="${k}"${cls ? ` class="${cls}"` : ""}>${cl && cl.ch ? esc(cl.ch === "\t" ? " " : cl.ch) : ""}</span>`;
    }
    if (G.prev[r] !== h) { grid.children[r].innerHTML = h; G.prev[r] = h; }
  }
  G.prev.length = rows;
  $("gridhint").hidden = !!text || focused;
  renderCaret(scroll);
}
function caretXY(c) {
  const row = Math.floor(c / G.cols), col = c % G.cols, rowEl = $("mgrid").children[row];
  if (!rowEl) return null;
  return { x: rowEl.offsetLeft + 1 + col * G.cell, y: rowEl.offsetTop + 1 };
}
function renderCaret(scroll) {
  const car = $("caret");
  if (!E || E.view !== "grid" || !G.L) { car.hidden = true; return; }
  const s = ta.selectionStart, e = ta.selectionEnd, focused = document.activeElement === ta;
  const p = caretXY(caretCell(G.L, e));
  if (!p) { car.hidden = true; return; }
  ta.style.left = p.x + "px"; ta.style.top = p.y + "px";
  ta.style.width = G.cell + "px"; ta.style.height = G.cell + "px";
  car.hidden = !focused || s !== e || E.composing;
  car.style.left = (p.x + 1) + "px"; car.style.top = (p.y + G.cell * 0.16) + "px"; car.style.height = (G.cell * 0.68) + "px";
  car.classList.remove("blink"); void car.offsetWidth; car.classList.add("blink");
  $("gridhint").hidden = !!ta.value || focused;
  if (scroll && focused) {
    const r = car.getBoundingClientRect(), vv = window.visualViewport;
    const bottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
    if (r.bottom > bottom - 24 || r.top < 60) car.scrollIntoView({ block: "center" });
  }
}
function focusBody(idx) {
  ta.focus({ preventScroll: true });
  try { ta.setSelectionRange(idx, idx); } catch {}
  renderBody();
}
$("bodybox").addEventListener("pointerdown", e => { if (E && E.view === "grid") e.preventDefault(); });
$("bodybox").addEventListener("click", e => {
  if (!E || E.view !== "grid" || !G.L) return;
  const span = e.target.closest("span[data-c]");
  let idx = ta.value.length;
  if (span) { const rect = span.getBoundingClientRect(); idx = cellToIndex(G.L, Number(span.dataset.c), e.clientX > rect.left + rect.width / 2); }
  focusBody(idx);
});
if ("ResizeObserver" in window) new ResizeObserver(() => { if (E && !$("v-editor").hidden) renderBody(); }).observe($("bodybox"));

/* ---- 사진 ---- */
function paintPhotos() {
  const el = $("ePhotos");
  el.innerHTML = E.entry.photos.map((p, n) => `<button class="ph" data-n="${n}" aria-label="사진 ${n + 1} 크게 보기"><img data-file="${esc(p.id)}" alt=""></button>`).join("") +
    `<button class="add" id="addPh" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>사진 추가</button>`;
  el.querySelectorAll(".ph").forEach(b => b.onclick = () => lightbox(Number(b.dataset.n)));
  $("addPh").onclick = () => $("ePhotoIn").click();
  hydrate(el);
}
const IMG_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", heic: "image/heic", heif: "image/heif" };
$("ePhotoIn").addEventListener("change", async ev => {
  const files = [...ev.target.files]; ev.target.value = "";
  if (!files.length || !E) return;
  const ed = E, msg = $("ePhotoMsg"); msg.hidden = false;
  const problems = [];
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    msg.textContent = `사진 저장 중 ${n + 1}/${files.length}`;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const type = f.type && f.type.startsWith("image/") ? f.type : IMG_EXT[ext];
    if (!type) { problems.push(`${f.name}: 사진 파일이 아니에요`); continue; }
    try {
      const id = await putFile(newId("p"), f, { name: f.name, type, kind: "photo" });
      ed.entry.photos.push({ id, name: f.name, type, size: f.size, addedAt: Date.now() });
      if (E === ed) { paintPhotos(); touch(); }
    } catch (err) { problems.push(`${f.name}: ${errText(err)}`); }
  }
  if (/hei[cf]/i.test(files.map(f => f.type + f.name).join())) problems.push("HEIC 사진은 저장은 되지만 일부 화면에서 안 보일 수 있어요. 카메라 설정에서 '고효율 사진'을 끄면 JPG로 찍혀요.");
  if (problems.length) { msg.textContent = problems.join(" / "); setTimeout(() => { msg.hidden = true; }, 9000); }
  else msg.hidden = true;
});
async function lightbox(n) {
  const p = E.entry.photos[n]; if (!p) return;
  const root = $("overlayRoot"), src = await fileUrl(p.id);
  root.innerHTML = `<div class="overlay lightbox" id="ov">${src ? `<img src="${src}" alt="첨부한 사진">` : `<p style="color:#fff">사진을 찾을 수 없어요.</p>`}
    <div class="row"><button class="btn quiet" id="lbDel">이 사진 빼기</button><button class="btn" id="lbClose">닫기</button></div></div>`;
  const close = () => { root.innerHTML = ""; };
  $("lbClose").onclick = close; $("lbClose").focus();
  $("ov").addEventListener("click", e => { if (e.target.id === "ov") close(); });
  $("lbDel").onclick = () => {
    close();
    sheet({ title: "이 사진을 지울까요?", text: "일기에서 빠지고 저장된 사진 파일도 지워져요. 되돌릴 수 없어요.", ok: "지우기", okClass: "danger",
      onOk: async () => {
        const ed = E; const idx = ed.entry.photos.findIndex(x => x.id === p.id); if (idx < 0) return;
        ed.entry.photos.splice(idx, 1); paintPhotos(); touch(); await flush();
        if (!ed.dirty) await deleteFile(p.id);
      } });
  };
}

/* ---- 일기 지우기 ---- */
$("eDelete").onclick = () => {
  const ed = E;
  sheet({ title: "이 일기를 지울까요?", text: `${fmtDate(ed.entry.date)}의 '${ed.entry.title || snippet(ed.entry).slice(0, 20) || "일기"}'와 첨부한 사진 ${ed.entry.photos.length}장이 지워져요.\n지운 뒤에는 백업 파일로만 되살릴 수 있어요.`,
    ok: "지우기", okClass: "danger",
    onOk: async () => {
      try {
        clearTimeout(ed.saveT); clearTimeout(ed.retryT);
        await store.deleteEntry(ed.entry.id);
        ls.del("diary.draft." + ed.entry.id);
        for (const p of ed.entry.photos) await deleteFile(p.id);
        const d = ed.entry.date; E = null; S.selDate = d; show("home"); toast("일기를 지웠어요");
      } catch { toast("지우지 못했어요. 다시 시도해 주세요.", 3500); }
    } });
};

/* ---------- 설치 · 업데이트 ---------- */
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; if (S.view === "settings") renderSettings(); });
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("홈 화면에 설치했어요"); if (S.view === "settings") renderSettings(); });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let swReg = null;
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").then(reg => {
    swReg = reg;
    const watch = w => w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(); if (w.state === "activated" && S.view === "settings") renderSettings(); });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
    reg.addEventListener("updatefound", () => watch(reg.installing));
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloaded || !S.updating) return; reloaded = true; location.reload(); });
}
let updateShown = false;
function showUpdate() {
  if (updateShown) return; updateShown = true;
  banner("새 버전이 준비됐어요. 일기와 사진은 그대로 유지돼요.", [{ label: "지금 업데이트", run: async () => {
    if (E) { writeDraft(); await flush(); }
    S.updating = true;
    if (swReg && swReg.waiting) swReg.waiting.postMessage("SKIP_WAITING"); else location.reload();
  } }]);
}

/* ---------- 설정 ---------- */
async function renderSettings() {
  const v = $("v-settings"), s = S.settings;
  const fonts = [{ id: "system", name: "휴대폰 기본 글꼴" }, ...s.fonts];
  const pvCols = 10, pvText = "오늘도 나의 속도로 걸었다.";
  const pvL = layoutGrid(pvText, pvCols, true);
  const pvCell = Math.max(26, Math.round(s.fontSize * 1.55));
  const pvCells = Array.from({ length: pvCols * 2 }, (_, k) => `<span>${esc((pvL.cells[k] || {}).ch || "")}</span>`);
  const rowsHtml = [0, 1].map(r => `<div class="mrow">${pvCells.slice(r * pvCols, r * pvCols + pvCols).join("")}</div>`).join("");
  const lastBk = s.lastBackupAt ? new Date(s.lastBackupAt) : null;
  const offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  v.innerHTML = `
    <div class="hello"><div class="d">설정</div></div>
    <div class="card set">
      <h3>앱</h3>
      <div class="okline"><i class="${isStandalone() ? "ok" : ""}"></i>${isStandalone() ? "홈 화면 앱으로 실행 중" : "브라우저에서 실행 중"}</div>
      <div class="okline"><i class="${offline ? "ok" : ""}"></i>${offline ? "인터넷 없이도 열 수 있어요" : "오프라인 준비 중 · 인터넷이 연결된 상태에서 한 번 더 열면 준비돼요"}</div>
      <div class="okline" id="persistLine"><i></i>저장 공간 확인 중…</div>
      ${deferredInstall ? `<button class="btn" id="installBtn">홈 화면에 앱 설치</button>` : (!isStandalone() ? `<p class="note">크롬 오른쪽 위 <b>⋮ → 홈 화면에 추가(또는 앱 설치)</b>를 누르면 앱처럼 쓸 수 있어요.</p>` : "")}
    </div>
    <div class="card set">
      <h3>글꼴</h3>
      <div>${fonts.map(f => `<div class="opt"><input type="radio" name="font" id="f-${esc(f.id)}" value="${esc(f.id)}" ${s.fontId === f.id ? "checked" : ""}><label for="f-${esc(f.id)}">${esc(f.name)}</label>${f.id !== "system" ? `<button class="x" data-del="${esc(f.id)}">삭제</button>` : ""}</div>`).join("")}</div>
      <button class="btn line" id="addFont">TTF · OTF 글꼴 파일 등록</button>
      <div class="progress" id="fontMsg" hidden></div>
      <div class="slider"><div class="top"><label for="sSize">글자 크기</label><b id="vSize">${s.fontSize}px</b></div><input type="range" id="sSize" min="14" max="28" step="1" value="${s.fontSize}"></div>
      <div class="slider"><div class="top"><label for="sLs">글자 간격 <span class="muted small">(줄노트)</span></label><b id="vLs">${s.letterSpacing.toFixed(2)}em</b></div><input type="range" id="sLs" min="-0.05" max="0.2" step="0.01" value="${s.letterSpacing}"></div>
      <div class="slider"><div class="top"><label for="sLh">줄 간격 <span class="muted small">(줄노트)</span></label><b id="vLh">${s.lineHeight.toFixed(1)}</b></div><input type="range" id="sLh" min="1.4" max="2.6" step="0.1" value="${s.lineHeight}"></div>
      <div class="preview">
        <div class="pv-grid"><div class="mgrid" style="--cols:${pvCols};--cell:${pvCell}px;--gfs:${Math.min(s.fontSize, Math.floor(pvCell * 0.68))}px;--rowgap:6px">${rowsHtml}</div></div>
        <div class="pv-lines">${esc(pvText)} 완벽하지 않아도 괜찮은 하루였다.</div>
      </div>
      <button class="btn quiet" id="resetFont">기본 글꼴과 크기로 되돌리기</button>
      <p class="note">휴대폰 설정에서 고른 글꼴(갤럭시 글꼴 스타일)은 웹 앱이 읽어 올 수 없는 경우가 많아요. 그럴 때는 갖고 있는 TTF·OTF 파일을 등록하세요. 등록한 글꼴은 이 휴대폰에 보관되고 전체 백업에도 들어가요. 원고지 칸은 글자 크기에 맞춰 자동으로 커지고, 글자는 칸 안에 맞춰 줄어 잘리거나 겹치지 않아요.</p>
    </div>
    <div class="card set">
      <h3>백업과 복원</h3>
      <div class="note">마지막 백업: <b>${lastBk ? `${lastBk.getFullYear()}. ${lastBk.getMonth() + 1}. ${lastBk.getDate()}. ${hm(lastBk)}` : "아직 없어요"}</b> · 일기 ${S.entries.size}편</div>
      <div class="bk-row">
        <button class="btn" id="bkAll">전체 백업 (사진·글꼴 포함)</button>
        <button class="btn line" id="bkText">글만 백업 (가벼운 파일)</button>
        <button class="btn quiet" id="bkRestore">백업 파일로 복원</button>
      </div>
      <div class="progress" id="bkMsg" hidden></div>
      <p class="note"><b>기록은 어디에 저장되나요?</b> 이 휴대폰 안(크롬의 앱 저장소)에만 저장되고 인터넷으로 보내지 않아요. 그래서 인터넷 없이도 쓰고 볼 수 있어요.<br>
      <b>왜 백업이 꼭 필요한가요?</b> 휴대폰을 바꾸거나, 크롬의 '인터넷 사용 기록 삭제'에서 사이트 데이터를 지우거나, 앱을 삭제하면 기록이 함께 사라져요. 한 달에 한 번쯤 전체 백업 파일(.zip)을 받아 구글 드라이브나 PC에도 보관해 두세요. 새 휴대폰에서는 앱을 설치한 뒤 이 파일로 복원하면 일기·사진·태그·즐겨찾기가 그대로 돌아와요.<br>
      <b>Claude에서 쓰던 일기 옮기기:</b> Claude 일기장의 설정 → 전체 백업으로 받은 .json 파일도 여기서 복원할 수 있어요.</p>
    </div>
    <div class="card"><h3>저장 공간</h3><div class="note" id="usage">확인하는 중…</div></div>
    <p class="note" style="text-align:center">나의 일기장 ${APP_VERSION} · 일본어 문장 ${PH.length}개</p>`;

  v.querySelectorAll('input[name=font]').forEach(r => r.onchange = () => { s.fontId = r.value; store.saveSettingsSoon(); applyFont(); });
  v.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    const f = s.fonts.find(x => x.id === b.dataset.del);
    sheet({ title: `'${f.name}' 글꼴을 지울까요?`, text: "등록한 글꼴 파일이 지워지고, 기본 글꼴로 바뀌어요.", ok: "지우기", okClass: "danger",
      onOk: async () => { s.fonts = s.fonts.filter(x => x.id !== f.id); if (s.fontId === f.id) s.fontId = "system"; store.saveSettingsSoon(); await deleteFile(f.id); applyFont(); renderSettings(); } });
  });
  $("addFont").onclick = () => $("fontIn").click();
  const bindSlider = (id, key, out, fmt) => {
    $(id).addEventListener("input", e => { s[key] = Number(e.target.value); $(out).textContent = fmt(s[key]); applyFont(); store.saveSettingsSoon(); });
    $(id).addEventListener("change", () => renderSettings());
  };
  bindSlider("sSize", "fontSize", "vSize", x => x + "px");
  bindSlider("sLs", "letterSpacing", "vLs", x => x.toFixed(2) + "em");
  bindSlider("sLh", "lineHeight", "vLh", x => x.toFixed(1));
  $("resetFont").onclick = () => { Object.assign(s, { fontId: "system", fontSize: 18, letterSpacing: 0, lineHeight: 1.9 }); store.saveSettingsSoon(); applyFont(); renderSettings(); toast("기본 글꼴로 되돌렸어요"); };
  $("bkAll").onclick = () => exportBackup(true);
  $("bkText").onclick = () => exportBackup(false);
  $("bkRestore").onclick = () => $("restoreIn").click();
  if ($("installBtn")) $("installBtn").onclick = async () => { const d = deferredInstall; deferredInstall = null; d.prompt(); try { await d.userChoice; } catch {} renderSettings(); };

  try {
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const pl = $("persistLine");
    if (pl) pl.innerHTML = persisted ? `<i class="ok"></i>저장 공간이 보호되어 휴대폰이 자동으로 지우지 않아요` : `<i></i><span>휴대폰 공간이 부족하면 자동으로 지워질 수 있어요<br><button class="linkbtn a" id="persistBtn" style="padding:4px 0">저장 공간 보호 요청하기</button></span>`;
    if ($("persistBtn")) $("persistBtn").onclick = async () => { let ok = false; try { ok = await navigator.storage.persist(); } catch {} toast(ok ? "저장 공간을 보호했어요" : "아직 허용되지 않았어요. 홈 화면에 설치하면 허용될 가능성이 높아요.", 3500); renderSettings(); };
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const keys = await IDB.keys("files"); const mb = b => (b / 1048576).toFixed(1);
    if ($("usage")) $("usage").innerHTML = `일기 <b>${S.entries.size}편</b> · 사진·글꼴 파일 <b>${keys.length}개</b>` + (est ? ` · 사용 중 <b>${mb(est.usage || 0)}MB</b> (쓸 수 있는 공간 약 ${mb(est.quota || 0)}MB)` : "");
  } catch { if ($("usage")) $("usage").textContent = "저장 공간 정보를 확인하지 못했어요."; }
}

$("fontIn").addEventListener("change", async ev => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const msg = $("fontMsg"); msg.hidden = false;
  if (ext !== "ttf" && ext !== "otf") { msg.textContent = "TTF 또는 OTF 파일만 등록할 수 있어요."; return; }
  msg.textContent = "글꼴 확인 중…";
  try { const test = new FontFace("UF-test-" + Date.now(), await f.arrayBuffer()); await test.load(); }
  catch { msg.textContent = "글꼴 파일을 읽을 수 없어요. 손상되었거나 지원하지 않는 형식이에요."; return; }
  try {
    const type = ext === "otf" ? "font/otf" : "font/ttf";
    const id = await putFile(newId("font"), f, { name: f.name, type, kind: "font" });
    const name = f.name.replace(/\.(ttf|otf)$/i, "");
    S.settings.fonts.push({ id, name, type, size: f.size });
    S.settings.fontId = id; store.saveSettingsSoon();
    await applyFont(); renderSettings(); toast(`'${name}' 글꼴을 적용했어요`);
  } catch (err) { msg.textContent = errText(err); }
});

/* ---------- 백업 ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function exportBackup(withFiles) {
  if (E) { writeDraft(); await flush(); }
  const msg = $("bkMsg"); if (msg) { msg.hidden = false; msg.textContent = "백업 준비 중…"; }
  const say = t => { if ($("bkMsg")) $("bkMsg").textContent = t; };
  try {
    const entries = entryList().map(normalizeEntry).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
    const files = {}, missing = [], items = [];
    if (withFiles) {
      const ids = collectFileIds(entries, S.settings);
      for (const id of ids) {
        const f = await IDB.get("files", id);
        if (!f || !f.blob) { missing.push(id); continue; }
        files[id] = { type: f.type, name: f.name, size: f.size, kind: f.kind, path: "files/" + id };
        items.push({ name: "files/" + id, data: f.blob });
      }
    }
    const obj = buildBackup({ entries, settings: S.settings, files, missing, extra: { jp: JP.state } });
    items.unshift({ name: "data.json", data: JSON.stringify(obj) });
    items.unshift({ name: "읽어주세요.txt", data: "이 파일은 「나의 일기장」 백업이에요.\n앱의 설정 → 백업 파일로 복원에서 이 zip 파일을 그대로 고르면 되살릴 수 있어요. 압축을 풀지 않아도 돼요.\n" });
    const zip = await makeZip(items, (n, t) => say(`백업 파일 만드는 중 ${n}/${t}`));
    const d = new Date();
    const name = `일기장-백업-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${withFiles ? "" : "-글만"}.zip`;
    const file = new File([zip], name, { type: "application/zip" });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const sizeTxt = zip.size > 1048576 ? (zip.size / 1048576).toFixed(1) + "MB" : Math.ceil(zip.size / 1024) + "KB";
    say(`백업 파일이 준비됐어요 · 일기 ${entries.length}편${withFiles ? `, 파일 ${Object.keys(files).length}개` : ""} · ${sizeTxt}` + (missing.length ? ` (파일 ${missing.length}개는 찾지 못해 빠졌어요)` : ""));
    const done = how => { S.settings.lastBackupAt = Date.now(); store.saveSettingsSoon(); say(how); setTimeout(() => { if (S.view === "settings") renderSettings(); }, 3000); };
    const actions = [{ label: "휴대폰에 저장 (내 파일 → 다운로드)", run: () => { downloadBlob(file, name); done("다운로드 폴더에 저장했어요. 구글 드라이브 등 다른 곳에도 한 부 보관해 두세요."); } }];
    if (canShare) actions.push({ label: "공유해서 보관 (구글 드라이브 등)", cls: "line", run: async () => {
      try { await navigator.share({ files: [file], title: name }); done("공유한 곳에 저장했어요."); }
      catch (err) { if (!err || err.name !== "AbortError") { toast("공유하지 못했어요. 휴대폰에 저장을 이용해 주세요."); } }
    } });
    sheet({ title: "백업 파일을 어디에 둘까요?", text: `${name}\n${sizeTxt}`, actions });
  } catch (err) { say("백업 파일을 만들지 못했어요. " + errText(err) + "."); }
}
function b64ToBlob(b64, type) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}
$("restoreIn").addEventListener("change", async ev => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
  const msg = $("bkMsg"); msg.hidden = false; msg.textContent = "백업 파일 읽는 중…";
  let obj, zip = null;
  try {
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4B) { zip = await readZip(f); obj = JSON.parse(await zip.text("data.json")); }
    else obj = JSON.parse(await f.text());
  } catch { msg.textContent = "백업 파일을 읽을 수 없어요. 이 앱에서 만든 .zip 또는 .json 파일인지 확인해 주세요."; return; }
  const v = validateBackup(obj);
  if (!v.ok) { msg.textContent = v.errors.join(" "); return; }
  const plan = mergePlan(v.entries, S.entries);
  const photoCount = new Set(v.entries.flatMap(e => e.photos.map(p => p.id))).size;
  msg.hidden = true;
  sheet({ title: "이 백업으로 복원할까요?", ok: "복원하기",
    text: `일기 ${v.entries.length}편 · 사진 ${photoCount}장 · 백업 날짜 ${String(v.exportedAt).slice(0, 10)}\n` +
      `${plan.toWrite.length}편을 복원하고, ${plan.kept.length}편은 지금 휴대폰의 일기가 더 최근이라 그대로 둬요.\n지금 있는 다른 일기는 지우지 않아요.` + (v.badCount ? `\n형식이 맞지 않는 ${v.badCount}편은 건너뛰어요.` : ""),
    onOk: () => doRestore(v, plan, zip) });
});
async function doRestore(v, plan, zip) {
  const msg = $("bkMsg"); msg.hidden = false;
  const idMap = {}; let restored = 0, lost = 0;
  const existing = new Set(await IDB.keys("files"));
  const need = collectFileIds(plan.toWrite, v.settings);
  for (let n = 0; n < need.length; n++) {
    const id = need[n];
    msg.textContent = `사진·글꼴 되살리는 중 ${n + 1}/${need.length}`;
    if (existing.has(id)) { idMap[id] = id; continue; }
    const fi = v.files[id];
    try {
      let blob = null;
      if (fi && fi.path && zip) blob = await zip.blob(fi.path, fi.type);
      else if (fi && fi.data) blob = b64ToBlob(fi.data, fi.type);
      if (blob) { blob = new Blob([await blob.arrayBuffer()], { type: fi.type || "" }); await putFile(id, blob, { name: fi.name, type: fi.type, kind: fi.kind || (String(fi.type).startsWith("font") ? "font" : "photo") }); idMap[id] = id; restored++; continue; }
    } catch {}
    idMap[id] = null; lost++;
  }
  let done = 0, failed = 0;
  for (const e of plan.toWrite) {
    msg.textContent = `일기 되살리는 중 ${done + failed + 1}/${plan.toWrite.length}`;
    try { const rec = remapEntry(e, idMap); await IDB.put("entries", rec); S.entries.set(rec.id, rec); done++; } catch { failed++; }
  }
  if (v.settings && Array.isArray(v.settings.fonts)) {
    v.settings.fonts.filter(f => idMap[f.id]).forEach(f => { if (!S.settings.fonts.some(x => x.id === f.id)) S.settings.fonts.push({ ...f, id: idMap[f.id] }); });
    store.saveSettingsSoon();
  }
  const jp = v.extra && v.extra.jp;
  if (jp && Array.isArray(jp.favs)) {
    jp.favs.forEach(f => { if (PH[f.i] && !isFav(f.i)) JP.state.favs.push({ i: f.i, at: f.at || Date.now() }); });
    store.saveJp();
  }
  onEntriesChanged(); askPersist();
  msg.textContent = `복원을 마쳤어요 · 일기 ${done}편` + (restored ? `, 파일 ${restored}개` : "") + (plan.kept.length ? ` · ${plan.kept.length}편은 지금 것을 유지` : "") +
    (failed ? ` · ${failed}편은 저장하지 못했어요(다시 복원하면 이어서 돼요)` : "") + (lost ? ` · 파일 ${lost}개는 백업에 없어 빠졌어요` : "");
}

/* ---------- 임시 기록 복원 안내 ---------- */
function checkDrafts() {
  const drafts = ls.keys("diary.draft.").map(k => ls.get(k, null)).filter(d => d && d.entry && d.entry.id);
  const pending = drafts.filter(d => { const saved = S.entries.get(d.entry.id); return !saved || (saved.updatedAt || 0) < d.at; });
  drafts.filter(d => !pending.includes(d)).forEach(d => ls.del("diary.draft." + d.entry.id));
  if (!pending.length) return;
  const b = banner(`저장되지 않은 임시 기록이 ${pending.length}개 있어요. (${pending.map(d => fmtDate(d.entry.date)).join(", ")})`, [
    { label: "이어서 쓰기", run: el => { const d = pending.shift(); openEditorFromDraft(d); if (!pending.length) el.remove(); else el.firstChild.textContent = `저장되지 않은 임시 기록이 ${pending.length}개 더 있어요.`; } },
    { label: "버리기", cls: "quiet", run: el => sheet({ title: "임시 기록을 버릴까요?", text: "저장되지 않은 내용이 지워져요.", ok: "버리기", okClass: "danger", onOk: () => { pending.forEach(d => ls.del("diary.draft." + d.entry.id)); el.remove(); } }) }
  ]);
  void b;
}

function onEntriesChanged() {
  if (S.view === "home") renderHome();
  else if (S.view === "list") paintResults();
}

/* ---------- 시작 ---------- */
(async () => {
  show("home");
  try {
    await IDB.open();
    const [entries, settings, jp] = await Promise.all([IDB.all("entries"), IDB.get("kv", "settings"), IDB.get("kv", "jp")]);
    entries.forEach(e => S.entries.set(e.id, normalizeEntry(e)));
    if (settings) { S.settings = Object.assign(defaultSettings(), settings); ls.set("diary.settings", S.settings); }
    if (jp) JP.state = Object.assign(JP.state, jp);
    S.ready = true;
    await applyFont();
    jpRoll();
    show(S.view === "editor" ? "editor" : S.view);
    checkDrafts();
  } catch (err) {
    applyFont();
    banner("이 브라우저에서는 일기를 저장할 수 없어요. 크롬 시크릿 모드가 아닌 일반 창이나 홈 화면 앱으로 열어 주세요.");
  }
})();
})();
