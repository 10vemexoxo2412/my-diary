/* 나의 일기장 — 서비스 워커
   앱 화면(코드·아이콘·일본어 문장)을 기기에 저장해 인터넷 없이도 열리게 해요.
   일기·사진은 여기가 아니라 기기의 IndexedDB에 저장되므로, 앱을 업데이트해도 지워지지 않아요.
   ★ 파일을 고쳐서 다시 올릴 때는 아래 VERSION 숫자를 꼭 올려 주세요. */
const VERSION = "diary-v2.0.0";
const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./phrases.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 페이지 열기: 저장해 둔 화면을 먼저 보여 줘서 비행기 모드에서도 바로 열려요.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match("./index.html");
      if (cached) return cached;
      try { return await fetch(req); }
      catch { return new Response("오프라인이에요. 인터넷에 한 번 연결한 뒤 다시 열어 주세요.", { headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    })());
    return;
  }

  // 나머지 파일: 저장본 우선, 없으면 내려받아 저장
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    } catch {
      return new Response("", { status: 504, statusText: "offline" });
    }
  })());
});
