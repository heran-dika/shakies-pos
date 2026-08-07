# Shakies POS

Aplikasi POS sederhana buat **Shakies** (toko roti) & **Dimsum Mentai Galaxy** — input orderan, kelola menu & stok, cek persiapan PO, bagikan menu ke story WA, sampai cetak struk — semuanya gratis dan bisa dipake bareng dari beberapa HP.

![status](https://img.shields.io/badge/status-aktif-2F5D50) ![cost](https://img.shields.io/badge/biaya-gratis-1E3D35)

## Tampilan
<img height="300" alt="image" src="https://github.com/user-attachments/assets/f8f9e75d-d2e0-4fce-b8c1-8d374ff80669" />
<img height="300" alt="image" src="https://github.com/user-attachments/assets/232f814e-dee5-4b74-9e31-3e7848a307b2" />
<img height="300" alt="image" src="https://github.com/user-attachments/assets/0840d61d-1338-4bae-8a8f-ca5437d3436a" />
<img height="300" alt="image" src="https://github.com/user-attachments/assets/78b51d31-66de-4b06-bd0e-5900c9a10d2d" />


<!-- Taruh screenshot di sini — drag & drop gambar langsung ke bagian ini pas edit README di GitHub -->

## Fitur

- 📝 Input orderan (nama, tanggal kirim, item, biaya ekspedisi opsional) — total kehitung otomatis
- 🍞 Kelola menu (kategori & item) langsung dari app, tiap item punya ID permanen jadi aman diubah nama/harga kapan aja
- 📦 Stok per item — **Real** (fisik di dapur, isi manual), **Prep** (kebooking dari orderan 7 hari ke depan), **Tersedia** (Real − Prep) dihitung otomatis; varian produk bisa numpang stok ke item induk (mother/child), item tak terbatas bisa ditandai unlimited
- 📅 Kalender 7 hari ke depan buat cek & checklist persiapan PO, dengan warning warna kalau stok mepet
- 🖨️ Bagikan Menu — generate tampilan menu (kategori, nama, harga) siap discreenshot buat story WhatsApp, auto-centang item yang stoknya masih ada
- 🔗 Publish menu ke link publik yang bisa dibuka siapa aja tanpa perlu dikirimin manual — nggak ada akses ke data order/customer sama sekali
- 🧾 Struk per orderan — bisa di-print atau disalin sebagai teks buat dikirim ke customer
- 🗂️ Riwayat lengkap, bisa dicari & diedit — default nampilin bulan berjalan aja (biar ringan), filter rentang tanggal (Dari–Sampai) buat cari di luar itu, plus total pendapatan yang ngikutin hasil filter; orderan lama otomatis diarsipkan biar app tetap cepat
- 💰 Status Lunas/Belum Lunas per orderan
- 📱 Bisa di-"Add to Home Screen", jalan kayak app beneran
- 🔒 Cuma HP terdaftar yang bisa nyimpen data beneran (HP lain bisa liat-liat & coba-coba doang)
- 💸 Zero-cost — nggak ada biaya hosting/server sama sekali

## Cara Pakai

Buka `index.html` lewat link GitHub Pages repo ini, atau install ke homescreen HP (Safari/Chrome → Add to Home Screen).

Menu publik (tanpa perlu login/whitelist) ada di `menu.html` — dipakai buat share link menu ke customer.

## Setup / Deploy Ulang

Panduan lengkap (arsitektur, struktur data, cara update, troubleshooting) ada di [`DOKUMENTASI-pos-app-shakies.md`](./DOKUMENTASI-pos-app-shakies.md).

Ringkas:
1. `Code_production.gs` di-paste ke [script.google.com](https://script.google.com/), deploy sebagai Web App
2. URL Web App-nya di-paste ke `CONFIG.API_URL` dalam `index.html`
3. Repo ini di-host lewat **Settings → Pages** (branch `main`, folder root)

## Teknologi

- Frontend: HTML/CSS/JS biasa, 1 file, nggak ada build step
- Backend: Google Apps Script
- Database: Google Sheets
- Hosting: GitHub Pages

## Lisensi

Proyek pribadi buat Shakies — bukan buat dipublikasiin/dijual ulang.


