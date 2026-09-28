# Shakies POS

PWA point-of-sale internal untuk Shakies (bakery/food business, sistem PO/pre-order). Dipakai harian oleh owner dan 1 staf lewat HP masing-masing (device-based auth, bukan multi-tenant SaaS).

**Live app:** https://heran-dika.github.io/shakies-pos/
**Backend API:** https://pos.shakies.workers.dev/

---

## Arsitektur

```
index.html (PWA, vanilla JS)          Cloudflare Worker (worker.js)        D1 (SQLite)
  hosted di GitHub Pages      <--->     pos.shakies.workers.dev    <--->   shakies-pos-db
  repo: heran-dika/shakies-pos           REST-ish JSON API                  9 tabel
```

- **Frontend**: single-file `index.html` (HTML/CSS/JS, tanpa framework/bundler), + `sw.js` (service worker untuk push notification & PWA install).
- **Backend**: Cloudflare Worker (`worker.js`), menggantikan Google Apps Script lama.
- **Database**: Cloudflare D1 (SQLite), single-writer, jadi tidak butuh lock manual — idempotency ditangani lewat `UNIQUE` constraint di kolom `client_order_id` / `client_item_id` / `client_topup_id`.
- **Auth**: Google Sign-In (`id_token` diverifikasi via `tokeninfo`), session token disimpan di D1 dengan TTL 30 hari. Device/email yang tidak terdaftar tetap bisa buka app dalam "mode coba-coba" (read-only, semua perubahan cuma lokal).
- **Menu publik**: snapshot menu yang di-publish disimpan sebagai `published-menu.json` di GitHub repo (lewat GitHub API dari Worker), ditampilkan di `heran-dika.github.io/shakies/menu.html` (repo terpisah: `heran-dika/shakies`).

> **Status migrasi:** backend sudah pindah penuh dari Google Apps Script + Google Sheets ke Cloudflare Workers + D1 (cutover 26 Sep 2026). GAS lama masih live tapi sudah tidak menerima write — cuma kena ping monitoring (UptimeRobot) yang belum dipindah.

---

## Fitur

### Tab Order
- Input orderan baru: nama customer (dengan autocomplete + saldo lookup), tanggal kirim, item + qty (stepper), catatan, biaya ekspedisi, diskon (persen/nominal).
- **Auto Fill Form**: baca clipboard hasil copy dari halaman menu publik, parsing baris `angka x nama menu`, isi form otomatis.
- Total dihitung live, termasuk potongan diskon dan biaya ekspedisi.
- Search & sticky search bar untuk cari menu cepat.

### Tab Menu
- CRUD kategori & item menu.
- **3-stock model**:
  - **Real** — stok fisik, input manual (auto-decrement tiap malam via cron `processExpiredPrepDeductions`, bukan dipotong manual per transaksi).
  - **Prep** — total demand dari semua order dalam window 7 hari ke depan.
  - **Tersedia** — Real − Prep (boleh negatif sebagai sinyal oversell).
- Mother/child stock linking (item varian bisa "numpang" stok ke item induk) + flag stok unlimited.
- Toggle "tampil di Order tab" per item (independen dari stok).
- Mode Stock/Available (edit stok massal) dan mode Hapus.
- **Bagikan Menu**: checklist item yang tersedia → generate "kertas menu" (visual untuk story WhatsApp), lalu publish ke `published-menu.json` di GitHub + share sebagai gambar.

### Tab Prep (PO 7 Hari)
- Kalender 7 hari ke depan, per-hari daftar order yang perlu disiapkan.
- Pill filter per item (klik untuk lihat order mana saja yang pesan item itu).
- Checklist "sudah disiapkan" dan toggle "Lunas".
- Retry otomatis untuk order yang gagal tersimpan (optimistic UI + background save).

### Tab Riwayat
- Default menampilkan order belum lunas; search by nama/tanggal untuk buka riwayat penuh (termasuk yang sudah diarsip).
- Struk per-order: share sebagai gambar (html2canvas) atau copy teks, lengkap dengan info rekening & status saldo.

### Saldo Customer
- Top-up saldo, auto-reconcile (FIFO by tanggal kirim) ke order yang belum lunas.
- Histori saldo per customer (top-up + pemakaian).

### Push Notification
- Order baru & kegagalan background-save (order/top-up) memicu push notification ke device staf yang subscribe (Web Push, di-sign pakai Web Crypto langsung di Worker, tanpa library eksternal).
- Terverifikasi jalan di produksi (Android). iOS (Suci) belum diaktifkan.

### Lain-lain
- Android back-button handling (`layarStack` pattern) untuk navigasi modal/sub-layar yang benar, termasuk konfirmasi "Quit POS app?" di root.
- Cache-first loading (localStorage) untuk menu, customer, dan order — app tetap kepake walau koneksi jelek, sync di background.
- Cron harian (`runDailyJobs`): potong stok Real sesuai Prep yang expired, lalu arsipkan order lama yang sudah lunas.

---

## Struktur data (D1)

Tabel utama: `menu`, `kategori_kode`, `order_pos`, `archive`, `customer`, `saldo_log`, `sessions`, `published_menu`, `allowed_emails`.

Detail skema ada di `schema_clean.sql` / vault Obsidian (`POS Shakies/`).

---

## Batasan yang perlu diketahui

- **Bukan multi-tenant SaaS** — `SPREADSHEET_ID`-equivalent (D1 binding), `ALLOWED_EMAILS`, dan Google Client ID di-hardcode per deployment. Untuk dijual ke bisnis lain, tiap klien butuh deployment Worker + D1 terpisah.
- QRIS statis saja, tidak ada payment gateway.
- Real stock tidak pernah auto-decrement dari transaksi order — hanya dari cron harian berdasarkan Prep yang sudah lewat tanggal kirimnya. Ini keputusan final, bukan bug.

---

## Development

Tidak ada build step — `index.html` dan `worker.js` diedit langsung. Deploy Worker pakai `wrangler deploy`. Testing lokal sebelumnya dilakukan lewat `test.html` (salinan `index.html` dengan `API_URL` diarahkan ke Worker) — sudah tidak dipakai lagi setelah cutover, karena `index.html` produksi sekarang langsung memanggil Worker.

Dokumentasi teknis lengkap (PRD migrasi, log sesi, keputusan desain) ada di vault Obsidian `POS Shakies/`, bukan di repo ini.
