// Shakies POS — Service Worker (network-first untuk file app sendiri)
// v1 — 11 Agustus 2026
// v2 — 19 September 2026: tambah handler push + notificationclick (Push Notification Order Baru, lihat PRD).
// TUJUAN: nyelesain masalah "harus uninstall total buat clear cache" — sebelum ini
// gak ada service worker sama sekali, jadi PWA ngandelin cache default browser yang
// nyangkut keras di Android/iOS.
//
// STRATEGI: network-first. Coba network dulu tiap kali, cache cuma dipake kalau device
// offline. Jadi begitu index.html baru di-push ke GitHub Pages, device bakal langsung
// kepakai versi baru di request berikutnya — gak perlu tunggu cache expire.
//
// PENTING: kalau ngedit index.html/menu.html dan push ke GitHub, BUMP CACHE_NAME di bawah
// (v1 -> v2 -> dst) biar service worker lama yang masih nyangkut di beberapa HP tau ada
// versi baru dan bersihin cache lama pas activate.
const CACHE_NAME = 'shakies-pos-v2';

// Halaman yang dibuka pas notif order di-klik dan gak ada tab app yang lagi kebuka.
// Bisa di-override Worker lewat field `url` di payload push. GANTI ke './index.html?tab=besok'
// begitu test.html udah dipromosiin jadi index.html.
const PUSH_OPEN_URL = './test.html?tab=besok';
const APP_SHELL = [
  './',
  './index.html',
  './menu.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // gagal pre-cache bukan fatal — fetch handler tetep jalan network-first
  );
  self.skipWaiting(); // langsung aktif, gak nunggu semua tab lama ditutup
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim(); // langsung ambil alih tab yang lagi kebuka
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST ke Apps Script sama sekali gak disentuh SW

  const url = new URL(req.url);

  // Request ke Apps Script (data POS: order, menu, saldo, dst) TIDAK disentuh SW sama sekali —
  // selalu langsung ke network, gak boleh ke-cache (data harus selalu fresh).
  if (url.hostname.includes('script.google.com')) return;

  // Request cross-origin lain (Google Sign-In, font CDN, dll) dibiarin lewat jalur browser normal.
  if (url.origin !== self.location.origin) return;

  // Network-first buat file app sendiri (index.html, menu.html, manifest, icon).
  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() =>
        // Offline / network gagal — baru fallback ke cache. Kalau path spesifiknya juga
        // gak ada di cache, fallback ke index.html biar app tetep kebuka (bukan blank error).
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});

// ==== PUSH NOTIFICATION (order baru masuk) ====
// Payload dari Worker (JSON): { title, body, tag?, url? }. Kalau payload kosong/rusak tetep munculin
// notif generik — browser (Android Chrome) wajib nampilin notif tiap ada event push (userVisibleOnly).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const options = {
    body: data.body || 'Ada order baru buat hari ini — buka tab Prep.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || PUSH_OPEN_URL }
  };
  if (data.tag) options.tag = data.tag; // sengaja opsional: tanpa tag, tiap order = notif sendiri (gak saling nimpa)

  event.waitUntil(self.registration.showNotification(data.title || 'Order baru masuk', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || PUSH_OPEN_URL,
    self.registration.scope
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Ada tab app yang udah kebuka → fokusin + suruh pindah ke tab Prep (lihat listener 'message' di test.html).
      const open = list.find((c) => new URL(c.url).pathname === target.pathname) || list[0];
      if (open) {
        open.postMessage({ type: 'open-tab', tab: target.searchParams.get('tab') || 'besok' });
        return open.focus();
      }
      return self.clients.openWindow(target.href);
    })
  );
});
