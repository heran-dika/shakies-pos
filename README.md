# Shakies POS

PWA point-of-sale internal untuk **Shakies** (bakery, sistem pre-order / PO). Dipakai harian oleh owner dan staf lewat HP masing-masing. Bukan SaaS multi-tenant: akun, backend, dan database di-deploy per bisnis.

- **Aplikasi:** https://heran-dika.github.io/shakies-pos/
- **Backend API:** https://pos.shakies.workers.dev/
- **Menu publik (repo terpisah):** https://heran-dika.github.io/shakies/menu.html

---

## Daftar isi

1. [Arsitektur](#arsitektur)
2. [Role dan akses](#role-dan-akses)
3. [Fitur](#fitur)
4. [Notifikasi dan job terjadwal](#notifikasi-dan-job-terjadwal)
5. [Struktur repo](#struktur-repo)
6. [Struktur data](#struktur-data)
7. [Deploy dan development](#deploy-dan-development)
8. [Keputusan desain yang sengaja](#keputusan-desain-yang-sengaja)
9. [Batasan](#batasan)

---

## Arsitektur

```
index.html (PWA, vanilla JS)        Cloudflare Worker (worker.js)        Cloudflare D1 (SQLite)
 GitHub Pages                <--->   pos.shakies.workers.dev      <--->   shakies-pos-db
 repo: heran-dika/shakies-pos        JSON API (GET + POST)
```

| Lapisan | Teknologi |
|---|---|
| Frontend | Satu file `index.html` (HTML/CSS/JS, tanpa framework dan tanpa build step) + `sw.js` (service worker) |
| Backend | Cloudflare Worker (`worker.js`, modul `hampers.js`) |
| Database | Cloudflare D1. Single-writer, jadi tanpa lock manual. Idempotency lewat `UNIQUE` di `client_order_id`, `client_item_id`, `client_topup_id` |
| Auth | Google Sign-In (`id_token` diverifikasi), session token di D1 dengan TTL 30 hari |
| Menu publik | Snapshot menu di-commit ke `published-menu.json` di repo `shakies` lewat GitHub Contents API dari Worker |
| Notifikasi | Web Push, di-sign dengan Web Crypto langsung di Worker (tanpa library) |

Backend sebelumnya Google Apps Script + Google Sheets. Cutover ke Cloudflare Workers + D1 dilakukan 26 September 2026.

**Service worker (`sw.js`):** network-first dengan `cache: 'no-cache'`, jadi update `index.html` langsung terpakai di request berikutnya. Cache cuma dipakai saat offline. Setiap mengubah file app, naikkan `CACHE_NAME`.

---

## Role dan akses

Hanya email yang terdaftar di tabel `allowed_emails` yang bisa menulis data. Email lain tetap bisa membuka app dalam **mode coba-coba** (data asli tidak tampil, perubahan hanya lokal).

| Kemampuan | Owner | Chef | Staf |
|---|:-:|:-:|:-:|
| Order, Prep, Riwayat, Menu, Saldo, Struk | ya | ya | ya |
| Lihat Resep dan Bahan | ya | ya (tanpa harga/HPP) | tidak |
| Harga bahan, HPP, tarif, target profit | ya | tidak | tidak |
| Mengatur email dan role | ya | tidak | tidak |
| Notifikasi "Bahan habis" | ya | tidak | tidak |
| PO Hampers (`hampers.html`) | ya | tidak | tidak |

Server menolak akses di sisi backend (`requireRole`), bukan hanya menyembunyikan tombol.

---

## Fitur

### Tab Order
- Input orderan: nama customer (autocomplete dari daftar customer), tanggal kirim, item + qty (stepper), catatan, biaya ekspedisi, diskon.
- Tombol tanggal cepat: toggle hari ini / besok.
- Diskon **Persen** atau **Nominal** dengan stepper. Nilai terakhir per mode diingat. Ekspedisi dan diskon punya tombol hapus cepat.
- Catatan dan Ekspedisi collapsible. Terbuka otomatis saat mengedit order yang sudah berisi.
- Pencarian menu dengan search bar yang menempel di bawah header.
- **Auto Fill Form:** membaca clipboard hasil copy dari halaman menu publik (baris `angka x nama menu`) lalu mengisi form.
- Tombol panah bawah menampilkan total berjalan.
- Simpan bersifat optimistic: UI langsung lanjut, simpan berjalan di background dengan retry. Kegagalan memunculkan notifikasi.
- Edit order dari Prep/Riwayat: banner "Lagi edit orderan", tombol Batal kembali ke tab asal, tombol Hapus Orderan.

### Tab Prep (PO 7 hari)
- Strip 7 hari ke depan, daftar order per hari (terbaru di atas).
- Pill rekap per item, dikelompokkan per kategori. Angkanya hanya menghitung order yang belum dicentang. Klik pill untuk memfilter order yang memesan item itu.
- Warna peringatan stok progresif per hari (permintaan kumulatif dari hari ini sampai hari yang dibuka).
- Checklist **sudah disiapkan** dan toggle **Lunas** per order.
- Total di kartu dihitung live dengan harga menu terkini, termasuk diskon dan ongkir.
- Cache-first (localStorage) dan sync di background.

### Tab Riwayat
- Default: order belum lunas bulan berjalan. Pencarian nama atau rentang tanggal membuka riwayat penuh, termasuk order yang sudah diarsip.
- Total omzet dinamis mengikuti filter.
- Struk per order: **share sebagai gambar** (html2canvas + Web Share) atau **copy teks**, lengkap dengan info rekening dan status saldo.

### Tab Menu
- Kategori dan item: tambah, edit, hapus. ID item permanen (`CCSSSDDDDDDD`: kode kategori, urutan, tanggal) sehingga rename aman.
- **Model 3 stok:**
  - **Real:** stok fisik di dapur, diinput manual.
  - **Prep:** total permintaan dari order di jendela 7 hari.
  - **Tersedia:** Real dikurangi Prep. Boleh negatif sebagai tanda oversell.
- **Mother/child:** item varian numpang stok ke item induk. **Unlimited:** item tanpa batas stok.
- **Available:** tombol centang per item menentukan tampil atau tidaknya di tab Order, terpisah dari stok.
- Menu hamburger berisi Tambah Menu, Stock / Available, Hapus, Bahan. Saat mode Stock atau Hapus aktif, ikon hamburger berubah menjadi centang untuk menyelesaikan.
- Mode Stock: stepper tambah stok dengan tekan-tahan yang makin cepat.
- **Bagikan Menu:** pilih item Tersedia, preview "kertas menu" (rasio story WhatsApp 9:16), publish ke link menu publik, lalu bagikan sebagai gambar. Ada tombol riwayat untuk melihat versi terakhir yang dipublish.

### Resep dan Produksi (owner dan chef)
- Resep menempel di item induk, dibuka dari modal Edit Menu Item.
- **Jangkar** (default tepung) bisa diubah. Mengubah jangkar menskalakan semua bahan.
- Bahan, waktu dan energi, packaging per pcs, hasil adonan (bisa lebih dari satu ukuran), catatan.
- **HPP penuh** (bahan, tenaga kerja, listrik, gas, packaging), **target profit** dan **harga jual** (HPP / (1 - profit)). Bagian harga hanya terlihat oleh owner.
- **Selesai Produksi:** mengurangi stok bahan dan menambah stok Real item sekaligus. Stok bahan hanya dilacak untuk bahan yang sudah di-opname, dan produksi ditolak jika stok bahan kurang.
- Baca resep dari foto tulisan tangan (OCR).

### Bahan (owner dan chef)
- Tiga kelompok: Biaya dasar (tarif), Bahan, Packaging. Urutan bisa diatur, ada garis pemisah.
- Per bahan: harga, berat, satuan, gr per butir dan rendemen untuk bahan butiran, stok fisik (opname), ambang "Mau habis".
- **Bahan olahan** (levain, yudane): komposisi dari bahan biasa (tanpa olahan di dalam olahan), harga per kg dihitung otomatis, tombol "Buat olahan" memotong stok bahan baku dan menambah stok olahan. Levain induk yang dipakai ulang sebagai starter dihitung neto.
- **Tambah stok:** foto struk (OCR) atau isi manual. Hasil baca struk harus di-**Approve** sebelum stok bertambah, atau di-Reject.
- Riwayat stok dan riwayat harga per bahan.

### Saldo dan Customer
- **Saldo deposit:** top up (nilai negatif untuk koreksi), alokasi otomatis FIFO ke order belum lunas berdasarkan tanggal kirim. Label: Saldo Awal / Saldo Jajan / Saldo Sisa. Order yang dilunasi lewat saldo terkunci dari toggle Lunas.
- **Daftar customer** dengan urutan Nama, Total Spend, Last Order, Saldo.
- **Profil customer:** lifespan, total belanja, menu yang pernah dibeli, ringkasan belanja per bulan dan per tahun.
- Ikon **WhatsApp** (buka `wa.me`) dan **alamat** (copy) di profil. Tekan lama ikon untuk mengedit isinya.
- **Edit nama dan Merge** customer. Merge ditolak server jika kedua customer masih punya sisa saldo (keputusan finansial manual). Jika salah satu saldonya 0, penggabungan lanjut dan yang bersaldo dipertahankan.

### Akun dan perangkat
- Sign in Google, tampil alias, email, lama login.
- **Authorize Email:** owner menambah/menghapus email dan mengatur role.
- Banner merah saat sesi habis (dari penolakan server atau umur sesi lokal 30 hari).
- Tombol back Android memakai pola `layarStack`: tab tidak menumpuk history, modal dan sub-layar ya. Back di root menampilkan konfirmasi keluar.

### Shortcut PWA
`manifest.json` mendefinisikan tiga shortcut ikon aplikasi: **Prep Today** (`?tab=besok`), **Create Order** (`?tab=order`), **Share Menu** (`?tab=menu&share=1`).

### PO Hampers (halaman terpisah, owner only)
`hampers.html` mencatat pesanan paket hampers (nama, tanggal kirim, paket + qty, catatan) dan menghitung **total persiapan** per tanggal, dengan tombol salin ringkasan. Data ada di tabel D1 `hampers_order` (snapshot label, harga, isi paket per baris). Tidak masuk Prep, Riwayat, LTV, saldo, atau omzet POS.

---

## Notifikasi dan job terjadwal

**Push (opt-in per akun, di modal Sign in):**

| Jenis | Isi | Default |
|---|---|---|
| Order baru masuk | Order dengan tanggal kirim hari ini | nyala |
| Rekap pagi | Ringkasan semua order tanggal kirim hari ini, 04.00 WIB, hanya jika ada order | mati |
| Bahan habis | Khusus owner | nyala |

Kegagalan simpan di background (order atau top up) memunculkan notifikasi lokal.

**Cron (`wrangler.toml`):**

| Jadwal (WIB) | Pekerjaan |
|---|---|
| 00.05 | `runDailyJobs`: potong stok Real untuk Prep yang tanggal kirimnya lewat, potong saldo, **lalu** arsipkan order lunas lama, refresh data LTV customer |
| 04.00 | Rekap pagi (push) |

Urutan "potong dulu, arsip kemudian" wajib dalam satu handler.

---

## Struktur repo

```
index.html        aplikasi utama (PWA)
hampers.html      halaman PO Hampers (owner only)
sw.js             service worker: network-first + handler push
manifest.json     manifest PWA + 3 shortcut
icon-192.png, icon-512.png, badge-72.png
shortcut-prep.png, shortcut-order.png, shortcut-menu.png
README.md
```

`worker.js`, `hampers.js`, `wrangler.toml`, skema SQL, dan PRD/log berada di luar repo ini (vault dokumentasi internal).

---

## Struktur data

Tabel inti: `menu`, `kategori_kode`, `order_pos`, `archive`, `customer`, `saldo_log`, `sessions`, `published_menu`, `allowed_emails`, `push_subscriptions`.
Modul resep dan bahan menambah tabel resep, bahan, produksi, struk, tarif, dan riwayat harga/stok. Hampers memakai `hampers_order`.

`order_pos` dan `archive` berstruktur kolom identik. Kolom penting: `items_json`, `total`, `shipping_fee`, `discount_type`, `discount_value`, `paid`, `prepared`, `saldo_used`, `client_order_id`.

---

## Deploy dan development

Tidak ada build step.

1. **Backend dulu:** `wrangler deploy` dari folder Worker. Jika ada migrasi SQL, jalankan migrasinya **sebelum** deploy worker.
2. **Frontend kemudian:** push `index.html` (dan file lain yang berubah) ke `main`. GitHub Pages akan menyajikannya.
3. Naikkan `CACHE_NAME` di `sw.js` jika file app berubah.

Aturan:
- Jangan men-deploy `worker.js` dari salinan yang tidak diverifikasi terbaru. Cek ukuran dan tanggal ubah file sebelum deploy.
- Origin yang diizinkan CORS dikonfigurasi di `ALLOWED_ORIGINS` pada Worker.
- Secret (`GITHUB_TOKEN`, kunci VAPID) disimpan lewat `wrangler secret`, bukan di repo.

---

## Keputusan desain yang sengaja

- **Real stock tidak pernah dipotong oleh transaksi order.** Real adalah hitungan fisik manual. Satu-satunya pengurangan otomatis adalah job harian 00.05 untuk Prep yang sudah lewat tanggal kirim, dan Selesai Produksi yang menambah stok. Ini keputusan final, bukan bug.
- Relasi data memakai ID item, bukan nama.
- Total di Prep dihitung dengan harga menu terkini, sedangkan Riwayat memakai total beku saat order dibuat.
- QRIS statis saja, tanpa payment gateway.

---

## Batasan

- Bukan multi-tenant. Untuk bisnis lain, buat deployment Worker + D1 terpisah dan ganti konfigurasi (daftar email, Google Client ID, repo menu).
- Web Share hanya membuka share sheet sistem. Aplikasi tidak bisa langsung menargetkan Status WhatsApp.
- Push di iOS belum terverifikasi (verifikasi produksi baru dilakukan di Android).
- Fitur belum dibuat (hanya rencana): kupon diskon "comeback" untuk customer lama, fitur paket hampers di dalam POS.
