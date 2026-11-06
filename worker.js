import { handleHampers, hampersReminders, HAMPERS_GET_ACTIONS, HAMPERS_POST_ACTIONS } from './hampers.js'; // PO Hampers (v2 5 Nov 2026: periode + paket; input semua role, kelola owner)
// ==== Cloudflare Worker — Shakies POS Backend (migrasi dari Code_production.gs) ====

// ============================================================================
// ===== MODUL RESEP (dulu resep.js, digabung ke worker.js 15 Okt 2026) =====
// ============================================================================
// ==== resep.js — Role + Resep & Produksi TAHAP 1 (11 Okt 2026) ====
// Modul TAMBAHAN yang di-import worker.js (lihat apply-patch.mjs). Isi: helper role, set_role,
// get_resep_index / get_resep / get_bahan / get_tarif, save_resep / delete_resep / save_bahan /
// save_tarif, add_produksi, dan guard hapus menu. Spesifikasi: PRD - Resep dan Bahan.md §5.2 +
// Rencana - Role, Shortcut, Menu.md. WAJIB jalanin migrasi-11okt-role.sql dan
// migrasi-11okt-resep-tahap1.sql di D1 SEBELUM deploy.
//
// Keputusan Dika 11 Okt 2026: STOK BAHAN TIDAK BOLEH MINUS. Konsekuensi di Tahap 1 (belum ada
// Opname/Beli): bahan yang belum pernah di-opname (opname_at NULL) TIDAK dilacak — stoknya tidak
// dicek dan tidak dikurangi, produksi tetap tercatat di produksi_bahan. Setelah opname pertama
// (Tahap 2) bahan itu dilacak: produksi ditolak kalau stok kurang. Penjaga akhir: CHECK
// (stok_dg >= 0) di tabel bahan, jadi batch rollback kalau ada race.

const RESEP_GET_ACTIONS = ['get_resep_index', 'get_resep', 'get_bahan', 'get_tarif', 'get_riwayat_bahan', 'get_riwayat_harga', 'get_struk_pending'];
const RESEP_POST_ACTIONS = ['save_resep', 'delete_resep', 'save_bahan', 'save_tarif', 'add_produksi', 'set_role', 'add_stok', 'add_opname', 'save_urutan_bahan', 'baca_struk', 'baca_resep_tulisan', 'approve_struk', 'reject_struk', 'save_olahan', 'buat_olahan'];
const ROLES = ['owner', 'chef', 'staf'];

const todayWIB = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const parseJson = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
const fmtGr = (dg) => (dg / 10).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' gr';
function int(v, name, min = 0) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(name + ' harus bilangan bulat >= ' + min + '.');
  return n;
}
function dec(v, name) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) throw new Error(name + ' harus angka >= 0.');
  return n;
}
const ph = (n) => new Array(n).fill('?').join(',');
// Pembatas basah/kering: maks 3 garis. Disimpan di resep.pemisah_json = [n,...] (n = jumlah baris bahan di atas garis).
// resep.pemisah_setelah (skalar, versi lama) tetap diisi = garis pertama supaya kompatibel.
const MAX_PEMISAH = 3;
function bacaPemisah(r) {
  const a = r.pemisah_json ? parseJson(r.pemisah_json) : (r.pemisah_setelah ? [r.pemisah_setelah] : []);
  return a.map(Number).filter((n) => Number.isInteger(n) && n >= 1);
}

// ---- ROLE ----
// Owner = is_owner=1 (satu sumber kebenaran, kompatibel dengan requireOwner lama). role 'owner'
// selalu disinkronkan oleh set_role. Email yang tidak ada di allowed_emails = 'staf' (tanpa hak).
async function getRole(env, session) {
  const row = await env.myposdb.prepare('SELECT is_owner, role FROM allowed_emails WHERE email = ?').bind(session.email).first();
  if (!row) return 'staf';
  if (Number(row.is_owner) === 1) return 'owner';
  return row.role === 'chef' ? 'chef' : 'staf';
}
// Error izin = Error BIASA (bukan status 'not_registered' — frontend menganggapnya sesi mati dan logout).
async function requireRole(env, session, allowed, msg) {
  const role = await getRole(env, session);
  if (!allowed.includes(role)) throw new Error(msg || 'Role kamu nggak punya akses ke fitur ini.');
  return role;
}

async function setRole(env, session, p) {
  await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengatur role.');
  const email = String((p && p.email) || '').trim().toLowerCase();
  const role = String((p && p.role) || '').trim();
  if (!ROLES.includes(role)) throw new Error('Role nggak valid.');
  const target = await env.myposdb.prepare('SELECT email FROM allowed_emails WHERE email = ?').bind(email).first();
  if (!target) throw new Error('Email ini nggak ada di daftar staff.');
  // Guard owner terakhir DI DALAM WHERE (atomik): turun dari owner hanya jika masih ada owner lain.
  const r = await env.myposdb
    .prepare(
      `UPDATE allowed_emails SET role = ?, is_owner = ?
       WHERE email = ? AND (is_owner = 0 OR ? = 'owner'
         OR (SELECT COUNT(*) FROM allowed_emails WHERE is_owner = 1) > 1)`
    )
    .bind(role, role === 'owner' ? 1 : 0, email, role)
    .run();
  if (!r.meta || r.meta.changes === 0) throw new Error('Nggak bisa menurunkan owner terakhir — jadikan orang lain owner dulu.');
  return { email, role };
}

// ---- GUARD HAPUS MENU (U7) ----
async function assertItemNotUsedByResep(env, itemId) {
  const hit = await env.myposdb
    .prepare('SELECT 1 AS x FROM resep_hasil h JOIN resep r ON r.id = h.resep_id WHERE r.aktif = 1 AND h.item_id = ? LIMIT 1')
    .bind(itemId)
    .first();
  if (hit) throw new Error('Item ini dipakai di resep — ubah atau hapus resepnya dulu.');
}
async function assertCategoryNotUsedByResep(env, kategori) {
  const hit = await env.myposdb
    .prepare(
      `SELECT 1 AS x FROM resep_hasil h JOIN resep r ON r.id = h.resep_id JOIN menu m ON m.item_id = h.item_id
       WHERE r.aktif = 1 AND m.kategori = ? LIMIT 1`
    )
    .bind(kategori)
    .first();
  if (hit) throw new Error('Ada item di kategori ini yang dipakai resep — ubah atau hapus resepnya dulu.');
}

// ---- BACA ----
async function findResepForItem(env, itemId) {
  const q = `SELECT * FROM resep WHERE aktif = 1 AND (item_id = ? OR id IN (SELECT resep_id FROM resep_hasil WHERE item_id = ?))`;
  let row = await env.myposdb.prepare(q).bind(itemId, itemId).first();
  if (!row) {
    // aturan 3.2(c): item child (mother_stock) membuka resep milik induknya
    const m = await env.myposdb.prepare('SELECT mother_stock FROM menu WHERE item_id = ?').bind(itemId).first();
    if (m && m.mother_stock) row = await env.myposdb.prepare(q).bind(m.mother_stock, m.mother_stock).first();
  }
  return row || null;
}

async function getResepIndex(env) {
  const { results: hasil } = await env.myposdb
    .prepare(
      `SELECT h.item_id, r.id AS resep_id, r.versi, r.item_id AS utama_id, mu.nama AS utama_nama
       FROM resep_hasil h JOIN resep r ON r.id = h.resep_id JOIN menu mu ON mu.item_id = r.item_id WHERE r.aktif = 1`
    )
    .all();
  const { results: kids } = await env.myposdb
    .prepare(
      `SELECT m.item_id, r.id AS resep_id, r.versi, r.item_id AS utama_id, mu.nama AS utama_nama
       FROM menu m JOIN resep_hasil h ON h.item_id = m.mother_stock JOIN resep r ON r.id = h.resep_id AND r.aktif = 1
       JOIN menu mu ON mu.item_id = r.item_id WHERE m.mother_stock IS NOT NULL AND m.mother_stock != ''`
    )
    .all();
  const seen = {};
  const out = [];
  for (const r of hasil.concat(kids)) {
    if (seen[r.item_id]) continue;
    seen[r.item_id] = 1;
    out.push({ item_id: r.item_id, resep_id: r.resep_id, versi: r.versi, item_utama_id: r.utama_id, item_utama_nama: r.utama_nama });
  }
  return out;
}

async function getResep(env, role, itemId) {
  const id = String(itemId || '').trim();
  if (!id) throw new Error('item_id kosong.');
  const r = await findResepForItem(env, id);
  if (!r) return null;
  const owner = role === 'owner';
  const { results: bahan } = await env.myposdb
    .prepare(
      `SELECT rb.bahan_id, rb.urut, rb.qty_dg, b.nama, b.berat_per_butir_dg, b.harga_per_kg
       FROM resep_bahan rb JOIN bahan b ON b.id = rb.bahan_id WHERE rb.resep_id = ? ORDER BY rb.urut`
    )
    .bind(r.id)
    .all();
  const { results: hasil } = await env.myposdb
    .prepare(
      `SELECT rh.item_id, rh.urut, rh.gramasi_dg, rh.jumlah_bawaan, m.nama
       FROM resep_hasil rh LEFT JOIN menu m ON m.item_id = rh.item_id WHERE rh.resep_id = ? ORDER BY rh.urut`
    )
    .bind(r.id)
    .all();
  const out = {
    resep_id: r.id, item_id: r.item_id, versi: r.versi,
    jangkar: { bahan_id: r.jangkar_bahan_id, min_dg: r.jangkar_min_dg, max_dg: r.jangkar_max_dg, step_dg: r.jangkar_step_dg },
    kerja_mnt: r.kerja_mnt, proofing: parseJson(r.proofing_json), oven: parseJson(r.oven_json),
    packaging: await resolvePackaging(env, parseJson(r.packaging_json)), catatan: r.catatan || '', pemisah: bacaPemisah(r), pemisah_setelah: r.pemisah_setelah,
    bahan: bahan.map((b) => ({
      bahan_id: b.bahan_id, nama: b.nama, qty_dg: b.qty_dg, berat_per_butir_dg: b.berat_per_butir_dg,
      ...(owner ? { harga_per_kg: b.harga_per_kg } : {}),
    })),
    hasil: hasil.map((h) => ({ item_id: h.item_id, nama: h.nama, gramasi_dg: h.gramasi_dg, jumlah_bawaan: h.jumlah_bawaan })),
  };
  if (!owner) {
    // harga packaging dibuang DI SERVER untuk chef (bukan cuma disembunyikan di UI)
    out.packaging = out.packaging.map((x) => ({ n: x.n, u: x.u, q: x.q }));
  } else {
    out.tarif = await env.myposdb.prepare('SELECT * FROM tarif_non_stok WHERE id = 1').first();
  }
  return out;
}

// Packaging di resep (17 Okt 2026): {b: bahan_id kategori 'packaging', q: pcs per roti, u}. Nama + harga per pcs selalu dibaca dari master bahan.
// Entri lama tanpa b ({n, p, u}) tetap jalan apa adanya.
async function resolvePackaging(env, list) {
  const ids = [...new Set(list.filter((x) => x && x.b).map((x) => Number(x.b)))];
  if (!ids.length) return list;
  const { results } = await env.myposdb.prepare(`SELECT id, nama, harga_per_kg FROM bahan WHERE id IN (${ph(ids.length)})`).bind(...ids).all();
  const m = {};
  for (const b of results) m[b.id] = b;
  return list.map((x) => (x && x.b ? { ...x, n: m[x.b] ? m[x.b].nama : '(packaging dihapus)', p: m[x.b] ? m[x.b].harga_per_kg / 1000 : 0 } : x));
}

async function getBahan(env, role) {
  // Tahap 2 (13 Okt 2026): + urut, pemisah_setelah, produksi_at, need_dg (kebutuhan terbesar bahan di satu resep aktif).
  // Ambang Habis = 1x need_dg, Mau habis = 2x (dihitung di klien dari need_dg). WAJIB migrasi-13okt-bahan-tahap2.sql dulu.
  const { results } = await env.myposdb
    .prepare('SELECT id, nama, berat_per_butir_dg, harga_per_kg, stok_dg, ambang_habis_dg, opname_at, produksi_at, urut, pemisah_setelah, olahan_hasil_dg, rendemen_pct, kategori FROM bahan ORDER BY urut, nama COLLATE NOCASE')
    .all();
  const { results: needs } = await env.myposdb
    .prepare('SELECT rb.bahan_id, MAX(rb.qty_dg) AS need FROM resep_bahan rb JOIN resep r ON r.id = rb.resep_id AND r.aktif = 1 GROUP BY rb.bahan_id')
    .all();
  const needMap = {};
  for (const n of needs) needMap[n.bahan_id] = n.need;
  // Olahan (15 Okt 2026): komposisi per bahan olahan. WAJIB migrasi-15okt-olahan.sql dulu.
  const { results: komp } = await env.myposdb.prepare('SELECT olahan_id, bahan_id, qty_dg FROM olahan_komposisi ORDER BY olahan_id, urut').all();
  const kompMap = {};
  for (const k of komp) (kompMap[k.olahan_id] = kompMap[k.olahan_id] || []).push({ bahan_id: k.bahan_id, qty_dg: k.qty_dg });
  // Harga (owner saja): pembelian terakhir (harga_beli terisi) + input manual terakhir (bahan form edit). WAJIB migrasi-15okt-riwayat-harga.sql.
  const lastBuy = {}, lastManual = {};
  if (role === 'owner') {
    const { results: lb } = await env.myposdb.prepare('SELECT bahan_id, waktu, harga_beli, harga_lama, diterapkan FROM harga_riwayat WHERE id IN (SELECT MAX(id) FROM harga_riwayat WHERE harga_beli IS NOT NULL GROUP BY bahan_id)').all();
    for (const r of lb) lastBuy[r.bahan_id] = { waktu: r.waktu, harga_beli: r.harga_beli, harga_lama: r.harga_lama, diterapkan: r.diterapkan };
    const { results: lm } = await env.myposdb.prepare("SELECT bahan_id, harga_baru, input_harga, input_berat, input_satuan FROM harga_riwayat WHERE id IN (SELECT MAX(id) FROM harga_riwayat WHERE sumber = 'manual' AND input_harga IS NOT NULL GROUP BY bahan_id)").all();
    for (const r of lm) lastManual[r.bahan_id] = r;
  }
  return results.map((b) => {
    const o = {
      id: b.id, nama: b.nama, kategori: b.kategori || 'bahan', rendemen_pct: b.rendemen_pct, berat_per_butir_dg: b.berat_per_butir_dg, stok_dg: b.stok_dg, ambang_habis_dg: b.ambang_habis_dg, opname_at: b.opname_at,
      produksi_at: b.produksi_at, urut: b.urut, pemisah_setelah: b.pemisah_setelah, need_dg: needMap[b.id] || null,
      olahan: kompMap[b.id] ? { hasil_dg: b.olahan_hasil_dg, komp: kompMap[b.id] } : null,
    };
    if (role === 'owner') {
      o.harga_per_kg = b.harga_per_kg;
      o.harga_terakhir = lastBuy[b.id] || null;
      const m = lastManual[b.id]; // dipakai form edit HANYA kalau harga sistem belum berubah sejak input itu
      o.harga_input = m && m.harga_baru === b.harga_per_kg ? { h: m.input_harga, b: m.input_berat, s: m.input_satuan } : null;
    }
    return o;
  });
}

// ---- TULIS: bahan, tarif ----
// ---- Riwayat harga (15 Okt 2026, PRD Olahan Levain dan Riwayat Harga Stok) ----
// Tiap perubahan harga_per_kg menulis satu baris harga_riwayat DI BATCH YANG SAMA dengan UPDATE-nya. INSERT harus sebelum UPDATE
// (harga_lama dibaca dari tabel pada saat eksekusi, jadi benar walau satu batch menyentuh bahan yang sama berkali-kali).
// Baris hanya ditulis kalau harga benar-benar beda. WAJIB migrasi-15okt-riwayat-harga.sql dulu.
function hargaSetStmts(db, bid, baru, sumber, ref, oleh, now, inp) {
  inp = inp || {};
  return [
    db.prepare('INSERT INTO harga_riwayat (bahan_id, waktu, harga_lama, harga_baru, diterapkan, sumber, ref, input_harga, input_berat, input_satuan, oleh) SELECT id, ?, harga_per_kg, ?, 1, ?, ?, ?, ?, ?, ? FROM bahan WHERE id = ? AND harga_per_kg != ?')
      .bind(now, baru, sumber, ref || null, inp.h === undefined ? null : inp.h, inp.b === undefined ? null : inp.b, inp.s || null, oleh || null, bid, baru),
    db.prepare('UPDATE bahan SET harga_per_kg = ? WHERE id = ?').bind(baru, bid),
  ];
}
const fmtG = (dg) => (dg / 10).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' gr';
const optInt = (v, name, min) => (v === null || v === undefined || v === '' ? null : int(v, name, min));

async function saveBahan(env, session, p) {
  const nama = String((p && p.nama) || '').trim();
  if (!nama) throw new Error('Nama bahan kosong.');
  const berat = p.berat_per_butir_dg === null || p.berat_per_butir_dg === undefined || p.berat_per_butir_dg === '' ? null : int(p.berat_per_butir_dg, 'berat_per_butir_dg', 1);
  const harga = int(p.harga_per_kg || 0, 'harga_per_kg');
  const ambang = p.ambang_habis_dg === null || p.ambang_habis_dg === undefined || p.ambang_habis_dg === '' ? null : int(p.ambang_habis_dg, 'ambang_habis_dg');
  const rend = p.rendemen_pct === undefined || p.rendemen_pct === null || p.rendemen_pct === '' ? undefined : int(p.rendemen_pct, 'rendemen_pct', 1);
  if (rend !== undefined && rend > 100) throw new Error('Rendemen maksimal 100%.');
  const cid = String(p.client_bahan_id || '').trim() || null;
  const kat = p.kategori === 'packaging' ? 'packaging' : 'bahan'; // hanya dipakai saat INSERT; packaging: stok 1 pcs = 10 dg, harga_per_kg = Rp per 1000 pcs
  const db = env.myposdb;
  try {
    if (p.id) {
      const id = int(p.id, 'id', 1);
      const old = await db.prepare('SELECT harga_per_kg, ambang_habis_dg, rendemen_pct FROM bahan WHERE id = ?').bind(id).first();
      if (!old) throw new Error('Bahan nggak ketemu — refresh dulu.');
      // parameter yang TIDAK dikirim = nilai lama dipertahankan (dulu ambang selalu terhapus jadi NULL)
      const ambangFinal = p.ambang_habis_dg === undefined ? old.ambang_habis_dg : ambang;
      const rendFinal = rend === undefined ? old.rendemen_pct : rend;
      const now = new Date().toISOString(), stmts = [];
      if (old.harga_per_kg !== harga) {
        stmts.push(...hargaSetStmts(db, id, harga, 'manual', null, session.alias, now, { h: p.input_harga === undefined ? undefined : dec(p.input_harga, 'input_harga'), b: p.input_berat === undefined ? undefined : dec(p.input_berat, 'input_berat'), s: p.input_satuan === 'gr' || p.input_satuan === 'kg' ? p.input_satuan : null }));
      }
      stmts.push(db.prepare('UPDATE bahan SET nama = ?, berat_per_butir_dg = ?, ambang_habis_dg = ?, rendemen_pct = ? WHERE id = ?').bind(nama, berat, ambangFinal, rendFinal, id));
      const res = await db.batch(stmts);
      if (!res[res.length - 1].meta || res[res.length - 1].meta.changes === 0) throw new Error('Bahan nggak ketemu — refresh dulu.');
      return { id, updated: true };
    }
    if (cid) {
      const ex = await env.myposdb.prepare('SELECT id FROM bahan WHERE client_bahan_id = ?').bind(cid).first();
      if (ex) return { id: ex.id, duplicate: true };
    }
    await env.myposdb
      .prepare('INSERT INTO bahan (nama, berat_per_butir_dg, harga_per_kg, stok_dg, ambang_habis_dg, client_bahan_id, rendemen_pct, kategori) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
      .bind(nama, berat, harga, ambang, cid, rend === undefined ? 100 : rend, kat).run();
    const row = await env.myposdb.prepare('SELECT id FROM bahan WHERE nama = ?').bind(nama).first();
    return { id: row.id };
  } catch (err) {
    const m = String(err.message || '').toUpperCase();
    if (m.includes('UNIQUE') && m.includes('NAMA')) throw new Error('Nama bahan "' + nama + '" sudah ada.');
    if (cid && m.includes('UNIQUE') && m.includes('CLIENT_BAHAN_ID')) {
      const ex = await env.myposdb.prepare('SELECT id FROM bahan WHERE client_bahan_id = ?').bind(cid).first();
      if (ex) return { id: ex.id, duplicate: true };
    }
    throw err;
  }
}

async function saveTarif(env, session, p) {
  const v = {
    upah_bulan: int(p.upah_bulan, 'upah_bulan'), upah_pembagi: int(p.upah_pembagi, 'upah_pembagi', 1),
    listrik_per_kwh: dec(p.listrik_per_kwh, 'listrik_per_kwh'), daya_ac_watt: int(p.daya_ac_watt, 'daya_ac_watt'),
    lpg_per_tabung: int(p.lpg_per_tabung, 'lpg_per_tabung'), lpg_kg_per_tabung: dec(p.lpg_kg_per_tabung, 'lpg_kg_per_tabung'), // pecahan boleh (W2, 14 Okt)
    gas_kg_per_jam: dec(p.gas_kg_per_jam, 'gas_kg_per_jam'),
  };
  if (!(v.lpg_kg_per_tabung > 0)) throw new Error('lpg_kg_per_tabung harus lebih dari 0.'); // 0 = harga gas per kg tak terhingga di HPP
  await env.myposdb
    .prepare(
      `UPDATE tarif_non_stok SET upah_bulan=?, upah_pembagi=?, listrik_per_kwh=?, daya_ac_watt=?, lpg_per_tabung=?,
       lpg_kg_per_tabung=?, gas_kg_per_jam=?, updated_at=?, updated_by=? WHERE id = 1`
    )
    .bind(v.upah_bulan, v.upah_pembagi, v.listrik_per_kwh, v.daya_ac_watt, v.lpg_per_tabung, v.lpg_kg_per_tabung, v.gas_kg_per_jam, new Date().toISOString(), session.alias)
    .run();
  return { saved: true };
}

// ---- TULIS: resep ----
async function saveResep(env, session, p) {
  const itemId = String(p.item_id || '').trim();
  const item = await env.myposdb.prepare('SELECT item_id, mother_stock FROM menu WHERE item_id = ?').bind(itemId).first();
  if (!item) throw new Error('Item utama nggak ketemu di Menu — refresh dulu.');
  if (item.mother_stock) throw new Error('Resep hanya menempel di item induk (bukan item yang stoknya ikut item lain).');

  const rows = Array.isArray(p.bahan) ? p.bahan : [];
  if (!rows.length) throw new Error('Resep butuh minimal 1 bahan.');
  const bahanIds = rows.map((r) => int(r.bahan_id, 'bahan_id', 1));
  if (new Set(bahanIds).size !== bahanIds.length) throw new Error('Satu bahan hanya boleh satu baris per resep.');
  const qtys = rows.map((r) => int(r.qty_dg, 'qty_dg'));
  const { results: found } = await env.myposdb.prepare(`SELECT id FROM bahan WHERE id IN (${ph(bahanIds.length)})`).bind(...bahanIds).all();
  if (found.length !== bahanIds.length) throw new Error('Ada bahan yang nggak ketemu — refresh daftar bahan dulu.');

  const jb = int(p.jangkar_bahan_id, 'jangkar_bahan_id', 1);
  const ji = bahanIds.indexOf(jb);
  if (ji < 0) throw new Error('Bahan jangkar harus salah satu bahan di resep.');
  if (qtys[ji] <= 0) throw new Error('Takaran bahan jangkar harus > 0.');
  const jmin = int(p.jangkar_min_dg, 'jangkar min', 1), jmax = int(p.jangkar_max_dg, 'jangkar maks', 1), jstep = int(p.jangkar_step_dg, 'jangkar langkah', 1);
  if (jmin > jmax) throw new Error('Jangkar min nggak boleh lebih besar dari maks.');

  const kerja = p.kerja_mnt === null || p.kerja_mnt === undefined ? null : int(p.kerja_mnt, 'kerja_mnt');
  const rawSep = Array.isArray(p.pemisah) ? p.pemisah : (p.pemisah_setelah === null || p.pemisah_setelah === undefined ? [] : [p.pemisah_setelah]);
  if (rawSep.length > MAX_PEMISAH) throw new Error('Pembatas maksimal ' + MAX_PEMISAH + ' garis.');
  const pemisah = rawSep.map((x) => int(x, 'pemisah', 1)).sort((a, b) => a - b);
  if (pemisah.some((n) => n >= rows.length)) throw new Error('Pembatas harus berada di antara dua bahan.');
  if (new Set(pemisah).size !== pemisah.length) throw new Error('Dua pembatas nggak boleh di posisi yang sama.');

  const hasil = Array.isArray(p.hasil) ? p.hasil : [];
  if (!hasil.length) throw new Error('Hasil adonan minimal 1 item.');
  const hIds = hasil.map((h) => String(h.item_id || '').trim());
  if (hIds[0] !== itemId) throw new Error('Baris hasil pertama harus item utama resep.');
  if (new Set(hIds).size !== hIds.length) throw new Error('Item hasil adonan nggak boleh dobel.');
  const { results: hm } = await env.myposdb.prepare(`SELECT item_id, mother_stock FROM menu WHERE item_id IN (${ph(hIds.length)})`).bind(...hIds).all();
  if (hm.length !== hIds.length) throw new Error('Ada item hasil adonan yang nggak ketemu di Menu — refresh dulu.');
  if (hm.some((m) => m.mother_stock)) throw new Error('Item hasil adonan harus punya stok sendiri (bukan item yang stoknya ikut item lain).');
  const { results: clash } = await env.myposdb
    .prepare(`SELECT h.item_id FROM resep_hasil h JOIN resep r ON r.id = h.resep_id WHERE r.aktif = 1 AND r.item_id != ? AND h.item_id IN (${ph(hIds.length)})`)
    .bind(itemId, ...hIds).all();
  if (clash.length) throw new Error('Item ini sudah jadi hasil di resep lain.');
  const hGram = hasil.map((h) => int(h.gramasi_dg, 'gramasi_dg', 1));
  const hJum = hasil.map((h) => int(h.jumlah_bawaan || 0, 'jumlah_bawaan'));

  const proofing = (Array.isArray(p.proofing) ? p.proofing : []).map((x) => ({ n: String(x.n || '').slice(0, 80), mnt: int(x.mnt || 0, 'menit proofing') }));
  const oven = (Array.isArray(p.oven) ? p.oven : []).map((x) => ({ atas: int(x.atas || 0, 'suhu atas'), bawah: int(x.bawah || 0, 'suhu bawah'), mnt: int(x.mnt || 0, 'menit oven') }));
  const packaging = (Array.isArray(p.packaging) ? p.packaging : []).map((x) => {
    const u = String(x.u || 'all');
    if (u !== 'all' && !hIds.includes(u)) throw new Error('Packaging merujuk item yang bukan hasil adonan.');
    if (x.b) return { b: int(x.b, 'packaging', 1), q: int(x.q || 1, 'jumlah packaging per roti', 1), u };
    return { n: String(x.n || '').slice(0, 80), p: int(x.p || 0, 'harga packaging'), u };
  });
  const pIds = [...new Set(packaging.filter((x) => x.b).map((x) => x.b))];
  if (pIds.length) {
    const { results: pf } = await env.myposdb.prepare(`SELECT id FROM bahan WHERE kategori = 'packaging' AND id IN (${ph(pIds.length)})`).bind(...pIds).all();
    if (pf.length !== pIds.length) throw new Error('Ada packaging yang nggak ketemu — refresh daftar bahan dulu.');
  }

  const now = new Date().toISOString();
  const ex = await env.myposdb.prepare('SELECT id, versi FROM resep WHERE item_id = ?').bind(itemId).first();
  let newVersi = 1;
  const stmts = [];
  const cols = [jb, jmin, jmax, jstep, kerja, JSON.stringify(proofing), JSON.stringify(oven), JSON.stringify(packaging), String(p.catatan || ''), pemisah.length ? pemisah[0] : null, pemisah.length ? JSON.stringify(pemisah) : null];
  if (ex) {
    if (p.versi !== null && p.versi !== undefined && Number(p.versi) !== ex.versi) throw new Error('Resep berubah dari device lain, refresh dulu.');
    newVersi = ex.versi + 1;
    stmts.push(
      env.myposdb.prepare(
        `UPDATE resep SET jangkar_bahan_id=?, jangkar_min_dg=?, jangkar_max_dg=?, jangkar_step_dg=?, kerja_mnt=?, proofing_json=?,
         oven_json=?, packaging_json=?, catatan=?, pemisah_setelah=?, pemisah_json=?, versi=?, aktif=1, updated_at=?, updated_by=? WHERE item_id=? AND versi=?`
      ).bind(...cols, newVersi, now, session.alias, itemId, ex.versi)
    );
  } else {
    stmts.push(
      env.myposdb.prepare(
        `INSERT INTO resep (jangkar_bahan_id, jangkar_min_dg, jangkar_max_dg, jangkar_step_dg, kerja_mnt, proofing_json, oven_json,
         packaging_json, catatan, pemisah_setelah, pemisah_json, item_id, versi, aktif, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)`
      ).bind(...cols, itemId, now, session.alias)
    );
  }
  // Anak-anak resep dikunci ke versi baru: kalau UPDATE di atas ditolak (versi bentrok), semuanya jadi no-op.
  stmts.push(env.myposdb.prepare('DELETE FROM resep_bahan WHERE resep_id = (SELECT id FROM resep WHERE item_id = ? AND versi = ?)').bind(itemId, newVersi));
  stmts.push(env.myposdb.prepare('DELETE FROM resep_hasil WHERE resep_id = (SELECT id FROM resep WHERE item_id = ? AND versi = ?)').bind(itemId, newVersi));
  rows.forEach((r, i) =>
    stmts.push(env.myposdb.prepare('INSERT INTO resep_bahan (resep_id, bahan_id, urut, qty_dg) SELECT id, ?, ?, ? FROM resep WHERE item_id = ? AND versi = ?').bind(bahanIds[i], i, qtys[i], itemId, newVersi))
  );
  hIds.forEach((id, i) =>
    stmts.push(env.myposdb.prepare('INSERT INTO resep_hasil (resep_id, item_id, urut, gramasi_dg, jumlah_bawaan) SELECT id, ?, ?, ?, ? FROM resep WHERE item_id = ? AND versi = ?').bind(id, i, hGram[i], hJum[i], itemId, newVersi))
  );
  const res = await env.myposdb.batch(stmts);
  if (ex && (!res[0].meta || res[0].meta.changes === 0)) throw new Error('Resep berubah dari device lain, refresh dulu.');
  const row = await env.myposdb.prepare('SELECT id FROM resep WHERE item_id = ?').bind(itemId).first();
  return { resep_id: row.id, versi: newVersi };
}

async function deleteResep(env, session, p) {
  const id = int(p && p.resep_id, 'resep_id', 1);
  const r = await env.myposdb.prepare('UPDATE resep SET aktif = 0, versi = versi + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(new Date().toISOString(), session.alias, id).run();
  if (!r.meta || r.meta.changes === 0) throw new Error('Resep nggak ketemu.');
  return { deleted: true };
}

// ---- PRODUKSI ----
// Hitung ulang SEMUANYA di server (angka klien selain jangkar/gramasi/jumlah diabaikan). Diekspor buat test vector.
function computeProduksi(resep, rows, hasilDef, tarif, input) {
  const base = rows.find((r) => r.bahan_id === resep.jangkar_bahan_id).qty_dg;
  const jangkar = input.jangkar_dg;
  if (jangkar !== base && (jangkar < resep.jangkar_min_dg || jangkar > resep.jangkar_max_dg)) throw new Error('Jangkar di luar kisaran resep.');
  const k = jangkar / base;
  const bahan = rows.map((r) => ({ ...r, used_dg: Math.round(r.qty_dg * k) }));
  const total = bahan.reduce((s, b) => s + b.used_dg, 0);
  const biayaBahan = Math.round(bahan.reduce((s, b) => s + (b.used_dg / 10) * (b.harga_per_kg / 1000), 0));
  const proof = parseJson(resep.proofing_json).reduce((s, x) => s + (Number(x.mnt) || 0), 0);
  const kerjaBase = resep.kerja_mnt === null || resep.kerja_mnt === undefined ? proof : resep.kerja_mnt;
  const ovenBase = parseJson(resep.oven_json).reduce((s, x) => s + (Number(x.mnt) || 0), 0);
  const kerja = kerjaBase * k, oven = ovenBase * k;
  const energi = Math.round(
    (kerja / 60) * (tarif.upah_bulan / tarif.upah_pembagi) +
    (kerja / 60) * (tarif.daya_ac_watt / 1000) * tarif.listrik_per_kwh +
    (oven / 60) * tarif.gas_kg_per_jam * (tarif.lpg_per_tabung / tarif.lpg_kg_per_tabung)
  );
  const pack = parseJson(resep.packaging_json);
  const biayaPack = input.hasil.reduce((s, h) => s + h.jumlah * pack.filter((x) => x.u === 'all' || x.u === h.item_id).reduce((a, x) => a + (Number(x.p) || 0), 0), 0);
  return { k, bahan, total_adonan_dg: total, biaya_bahan: biayaBahan, biaya_energi: energi, biaya_packaging: Math.round(biayaPack), kerja_mnt: Math.round(kerja), oven_mnt: Math.round(oven) };
}

async function stokSnapshot(env, produksiId) {
  const { results: keys } = await env.myposdb
    .prepare(`SELECT DISTINCT COALESCE(NULLIF(m.mother_stock, ''), h.item_id) AS k FROM produksi_hasil h LEFT JOIN menu m ON m.item_id = h.item_id WHERE h.produksi_id = ?`)
    .bind(produksiId).all();
  const stok_akhir = {};
  if (keys.length) {
    const ids = keys.map((x) => x.k);
    const { results } = await env.myposdb.prepare(`SELECT item_id, stok_real FROM menu WHERE item_id IN (${ph(ids.length)})`).bind(...ids).all();
    for (const r of results) stok_akhir[r.item_id] = Number(r.stok_real) || 0;
  }
  const { results: bs } = await env.myposdb.prepare('SELECT pb.bahan_id, b.stok_dg FROM produksi_bahan pb JOIN bahan b ON b.id = pb.bahan_id WHERE pb.produksi_id = ?').bind(produksiId).all();
  const bahan_stok = {};
  for (const r of bs) bahan_stok[r.bahan_id] = r.stok_dg;
  return { stok_akhir, bahan_stok };
}

async function addProduksi(env, session, p, deps) {
  const cid = String((p && p.client_produksi_id) || '').trim();
  if (!cid) throw new Error('client_produksi_id kosong.');
  const dup = await env.myposdb.prepare('SELECT produksi_id FROM produksi WHERE client_produksi_id = ?').bind(cid).first();
  if (dup) return { produksi_id: dup.produksi_id, duplicate: true, ...(await stokSnapshot(env, dup.produksi_id)) };

  const resep = await env.myposdb.prepare('SELECT * FROM resep WHERE id = ? AND aktif = 1').bind(int(p.resep_id, 'resep_id', 1)).first();
  if (!resep) throw new Error('Resep nggak ketemu atau sudah dihapus — refresh dulu.');
  if (p.versi !== null && p.versi !== undefined && Number(p.versi) !== resep.versi) throw new Error('Resep berubah, refresh dulu.');

  const { results: rows } = await env.myposdb
    .prepare(
      `SELECT rb.bahan_id, rb.qty_dg, b.nama, b.harga_per_kg, b.stok_dg, b.opname_at
       FROM resep_bahan rb JOIN bahan b ON b.id = rb.bahan_id WHERE rb.resep_id = ? ORDER BY rb.urut`
    ).bind(resep.id).all();
  const { results: hasilDef } = await env.myposdb.prepare('SELECT item_id FROM resep_hasil WHERE resep_id = ?').bind(resep.id).all();
  const allowed = new Set(hasilDef.map((h) => h.item_id));
  const tarif = await env.myposdb.prepare('SELECT * FROM tarif_non_stok WHERE id = 1').first();

  const seen = new Set();
  const hasil = (Array.isArray(p.hasil) ? p.hasil : [])
    .map((h) => ({ item_id: String(h.item_id || '').trim(), gramasi_dg: int(h.gramasi_dg, 'gramasi_dg', 1), jumlah: int(h.jumlah || 0, 'jumlah') }))
    .filter((h) => h.jumlah > 0);
  if (!hasil.length) throw new Error('Isi jumlah jadi minimal 1 item.');
  for (const h of hasil) {
    if (!allowed.has(h.item_id)) throw new Error('Item hasil bukan bagian dari resep ini.');
    if (seen.has(h.item_id)) throw new Error('Item hasil dobel.');
    seen.add(h.item_id);
  }

  // Packaging: harga dari master (Rp per pcs x pcs per roti); stok packaging ikut berkurang (1 pcs = 10 dg, lewat jalur yang sama dengan bahan)
  const packList = await resolvePackaging(env, parseJson(resep.packaging_json));
  const resepC = { ...resep, packaging_json: JSON.stringify(packList.map((x) => (x.b ? { ...x, p: x.p * (Number(x.q) || 1) } : x))) };
  const c = computeProduksi(resepC, rows, hasilDef, tarif, { jangkar_dg: int(p.jangkar_dg, 'jangkar_dg', 1), hasil });
  const terpakai = hasil.reduce((s, h) => s + h.gramasi_dg * h.jumlah, 0);
  if (terpakai > c.total_adonan_dg) throw new Error('Melebihi adonan.');

  const packUse = {};
  for (const x of packList) {
    if (!x.b) continue;
    const pcs = hasil.filter((h) => x.u === 'all' || x.u === h.item_id).reduce((a, h) => a + h.jumlah, 0);
    if (pcs > 0) packUse[x.b] = (packUse[x.b] || 0) + pcs * (Number(x.q) || 1);
  }
  const pIds = Object.keys(packUse).map(Number);
  if (pIds.length) {
    const { results: pr } = await env.myposdb.prepare(`SELECT id, nama, harga_per_kg, stok_dg, opname_at FROM bahan WHERE id IN (${ph(pIds.length)})`).bind(...pIds).all();
    for (const b of pr) c.bahan.push({ bahan_id: b.id, qty_dg: packUse[b.id] * 10, nama: b.nama, harga_per_kg: b.harga_per_kg, stok_dg: b.stok_dg, opname_at: b.opname_at, used_dg: packUse[b.id] * 10, kat: 'packaging' });
  }

  // Stok bahan nggak boleh minus — hanya bahan yang SUDAH di-opname yang dilacak (lihat kepala file).
  const kurang = c.bahan.filter((b) => b.opname_at && b.stok_dg < b.used_dg);
  if (kurang.length) {
    throw new Error('Stok bahan tidak cukup: ' + kurang.map((b) => b.nama + ' (sisa ' + (b.kat === 'packaging' ? Math.round(b.stok_dg / 10) + ' pcs' : fmtGr(b.stok_dg)) + ', butuh ' + (b.kat === 'packaging' ? Math.round(b.used_dg / 10) + ' pcs' : fmtGr(b.used_dg)) + ')').join('; ') + '.');
  }

  const { results: menuRows } = await env.myposdb
    .prepare(`SELECT item_id, mother_stock, unlimited_stock FROM menu WHERE item_id IN (${ph(hasil.length)})`)
    .bind(...hasil.map((h) => h.item_id)).all();
  if (menuRows.length !== hasil.length) throw new Error('Ada item hasil yang nggak ketemu lagi di Menu — refresh dulu.');
  const tambah = {};
  for (const m of menuRows) {
    if (m.unlimited_stock === 1) continue; // stok tidak berubah, bahan tetap berkurang
    const key = m.mother_stock || m.item_id; // aturan kunci sama dengan processExpiredPrepDeductions
    tambah[key] = (tambah[key] || 0) + hasil.find((h) => h.item_id === m.item_id).jumlah;
  }

  const { nama: judulProd } = (await env.myposdb.prepare('SELECT nama FROM menu WHERE item_id = ?').bind(resep.item_id).first()) || { nama: resep.item_id };
  const pid = 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const now = new Date().toISOString();
  const db = env.myposdb;
  const stmts = [
    db.prepare(
      `INSERT INTO produksi (produksi_id, resep_id, created_at, tanggal, jangkar_dg, total_adonan_dg, kerja_mnt, oven_mnt,
       biaya_bahan, biaya_energi, biaya_packaging, device_label, created_by, client_produksi_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(pid, resep.id, now, todayWIB(), p.jangkar_dg, c.total_adonan_dg, c.kerja_mnt, c.oven_mnt, c.biaya_bahan, c.biaya_energi, c.biaya_packaging, String(p.device_label || ''), session.alias, cid),
  ];
  for (const b of c.bahan) stmts.push(db.prepare('INSERT INTO produksi_bahan (produksi_id, bahan_id, qty_dg) VALUES (?,?,?)').bind(pid, b.bahan_id, b.used_dg));
  for (const h of hasil) stmts.push(db.prepare('INSERT INTO produksi_hasil (produksi_id, item_id, gramasi_dg, jumlah) VALUES (?,?,?,?)').bind(pid, h.item_id, h.gramasi_dg, h.jumlah));
  for (const b of c.bahan) if (b.opname_at) stmts.push(db.prepare('UPDATE bahan SET stok_dg = stok_dg - ? WHERE id = ?').bind(b.used_dg, b.bahan_id));
  // Tahap 2: ledger Riwayat (sisa diambil SETELAH update di atas, batch berjalan berurutan) + tanggal produksi di baris bahan.
  for (const b of c.bahan) {
    stmts.push(db.prepare('UPDATE bahan SET produksi_at = ? WHERE id = ?').bind(now, b.bahan_id));
    stmts.push(
      b.opname_at
        ? db.prepare("INSERT INTO mutasi_bahan (bahan_id, waktu, jenis, grup_id, judul, delta_dg, sisa_dg, created_by) VALUES (?, ?, 'produksi', ?, ?, ?, (SELECT stok_dg FROM bahan WHERE id = ?), ?)").bind(b.bahan_id, now, pid, judulProd, -b.used_dg, b.bahan_id, session.alias)
        : db.prepare("INSERT INTO mutasi_bahan (bahan_id, waktu, jenis, grup_id, judul, delta_dg, sisa_dg, created_by) VALUES (?, ?, 'produksi', ?, ?, ?, NULL, ?)").bind(b.bahan_id, now, pid, judulProd, -b.used_dg, session.alias)
    );
  }
  for (const [key, qty] of Object.entries(tambah)) stmts.push(db.prepare('UPDATE menu SET stok_real = stok_real + ? WHERE item_id = ?').bind(qty, key));

  try {
    await db.batch(stmts);
  } catch (err) {
    const m = String(err.message || '').toUpperCase();
    if (m.includes('UNIQUE') && m.includes('CLIENT_PRODUKSI_ID')) {
      const ex = await db.prepare('SELECT produksi_id FROM produksi WHERE client_produksi_id = ?').bind(cid).first();
      if (ex) return { produksi_id: ex.produksi_id, duplicate: true, ...(await stokSnapshot(env, ex.produksi_id)) };
    }
    if (m.includes('CHECK')) throw new Error('Stok bahan baru saja berubah (device lain) dan tidak cukup — refresh lalu coba lagi.');
    throw err;
  }
  await notifHabis(env, deps, c.bahan.map((b) => ({ bahan_id: b.bahan_id, sebelum: b.opname_at ? b.stok_dg : null, sesudah: b.opname_at ? b.stok_dg - b.used_dg : null })));
  return { produksi_id: pid, ...(await stokSnapshot(env, pid)) };
}

// ---- OLAHAN (levain, yudane) — 15 Okt 2026 ----
// Olahan = bahan biasa di daftar Bahan (stok sendiri, dipakai di resep seperti bahan lain) yang punya komposisi bahan baku.
// Tidak ada olahan di dalam olahan. Pelacakan stok sama dengan bahan lain: baru dipotong/ditambah kalau sudah di-opname.
// mutasi_bahan.jenis memakai ulang nilai yang sudah ada: 'produksi' (bahan baku terpakai) dan 'stok' (hasil olahan), dibedakan lewat judul.
const MAX_KOMP = 20;
function hargaOlahan(kom, setDg) {
  // kom: bahan baku SEGAR saja [{qty_dg, harga_per_kg}] (starter tidak ikut); setDg = hasil set dikurangi bagian starter. Hasil Rp per kg olahan
  const cost = kom.reduce((s, k) => s + (k.qty_dg / 10) * (k.harga_per_kg / 1000), 0);
  return Math.round((cost / (setDg / 10)) * 1000);
}
async function saveOlahan(env, session, p) {
  const db = env.myposdb;
  const oid = int(p && p.olahan_id, 'olahan_id', 1);
  if (!(await db.prepare('SELECT 1 AS x FROM bahan WHERE id = ?').bind(oid).first())) throw new Error('Bahan nggak ketemu — refresh dulu.');
  const rows = Array.isArray(p.komposisi) ? p.komposisi : [];
  if (!rows.length) { // kosong = jadikan bahan biasa lagi
    await db.batch([db.prepare('DELETE FROM olahan_komposisi WHERE olahan_id = ?').bind(oid), db.prepare('UPDATE bahan SET olahan_hasil_dg = NULL WHERE id = ?').bind(oid)]);
    return { olahan: false };
  }
  if (rows.length > MAX_KOMP) throw new Error('Maksimal ' + MAX_KOMP + ' bahan baku per olahan.');
  const ids = rows.map((r) => int(r.bahan_id, 'bahan_id', 1));
  const qtys = rows.map((r) => int(r.qty_dg, 'qty_dg', 1));
  if (new Set(ids).size !== ids.length) throw new Error('Satu bahan baku hanya boleh satu baris.');
  // Satu baris boleh bahan_id = olahan_id ("starter", mis. levain induk). Selebihnya = bahan baku segar yang bukan olahan.
  const fresh = ids.map((id, i) => ({ id, q: qtys[i] })).filter((x) => x.id !== oid), starterQ = qtys[ids.indexOf(oid)] || 0, fids = fresh.map((x) => x.id);
  if (!fids.length) throw new Error('Olahan butuh minimal satu bahan baku selain starter.');
  const { results: bs } = await db.prepare(`SELECT id, harga_per_kg FROM bahan WHERE id IN (${ph(fids.length)})`).bind(...fids).all();
  if (bs.length !== fids.length) throw new Error('Ada bahan baku yang nggak ketemu — refresh dulu.');
  if (await db.prepare(`SELECT 1 AS x FROM olahan_komposisi WHERE olahan_id IN (${ph(fids.length)}) LIMIT 1`).bind(...fids).first()) throw new Error('Bahan baku nggak boleh berupa olahan lain.');
  if (await db.prepare('SELECT 1 AS x FROM olahan_komposisi WHERE bahan_id = ? AND olahan_id != ? LIMIT 1').bind(oid, oid).first()) throw new Error('Bahan ini dipakai sebagai bahan baku olahan lain, jadi nggak bisa dijadikan olahan.');
  const sum = qtys.reduce((a, b) => a + b, 0);
  const hasil = p.hasil_dg === null || p.hasil_dg === undefined || p.hasil_dg === '' ? null : int(p.hasil_dg, 'hasil_dg', 1);
  if (starterQ && (hasil || sum) <= starterQ) throw new Error('Hasil per set harus lebih besar dari jumlah starter.');
  const hargaById = {};
  for (const b of bs) hargaById[b.id] = b.harga_per_kg;
  const harga = hargaOlahan(fresh.map((x) => ({ qty_dg: x.q, harga_per_kg: hargaById[x.id] })), (hasil || sum) - starterQ);
  const stmts = [db.prepare('DELETE FROM olahan_komposisi WHERE olahan_id = ?').bind(oid)];
  ids.forEach((id, i) => stmts.push(db.prepare('INSERT INTO olahan_komposisi (olahan_id, bahan_id, urut, qty_dg) VALUES (?,?,?,?)').bind(oid, id, i, qtys[i])));
  stmts.push(...hargaSetStmts(db, oid, harga, 'olahan', 'komposisi', session.alias, new Date().toISOString()));
  stmts.push(db.prepare('UPDATE bahan SET olahan_hasil_dg = ? WHERE id = ?').bind(hasil, oid));
  await db.batch(stmts);
  return { olahan: true, harga_per_kg: harga };
}
async function buatOlahan(env, session, p, deps) {
  const db = env.myposdb;
  const cid = String((p && p.client_olahan_id) || '').trim();
  if (!cid) throw new Error('client_olahan_id kosong.');
  if (await db.prepare('SELECT 1 AS x FROM mutasi_bahan WHERE grup_id = ? LIMIT 1').bind(cid).first()) return { duplicate: true };
  const oid = int(p.olahan_id, 'olahan_id', 1), hasil = int(p.hasil_dg, 'hasil_dg', 1);
  const o = await db.prepare('SELECT id, nama, stok_dg, opname_at, olahan_hasil_dg FROM bahan WHERE id = ?').bind(oid).first();
  if (!o) throw new Error('Bahan nggak ketemu — refresh dulu.');
  const { results: kom } = await db
    .prepare('SELECT k.bahan_id, k.qty_dg, b.nama, b.stok_dg, b.opname_at, b.harga_per_kg FROM olahan_komposisi k JOIN bahan b ON b.id = k.bahan_id WHERE k.olahan_id = ? ORDER BY k.urut')
    .bind(oid).all();
  if (!kom.length) throw new Error('Bahan ini belum punya komposisi olahan.');
  const setDg = o.olahan_hasil_dg || kom.reduce((s, k) => s + k.qty_dg, 0), f = hasil / setDg;
  const starter = kom.find((k) => k.bahan_id === oid), starterUsed = starter ? Math.round(starter.qty_dg * f) : 0; // levain induk yang dipakai ulang
  const segar = kom.filter((k) => k.bahan_id !== oid);
  const baku = segar.map((k) => ({ ...k, used: Math.round(k.qty_dg * f) })).filter((k) => k.used > 0);
  if (!baku.length) throw new Error('Jumlah terlalu kecil.');
  if (starterUsed > 0 && o.opname_at && o.stok_dg < starterUsed) throw new Error('Stok ' + o.nama + ' kurang untuk starter (sisa ' + fmtGr(o.stok_dg) + ', butuh ' + fmtGr(starterUsed) + ').');
  const kurang = baku.filter((k) => k.opname_at && k.stok_dg < k.used);
  if (kurang.length) throw new Error('Stok bahan tidak cukup: ' + kurang.map((k) => k.nama + ' (sisa ' + fmtGr(k.stok_dg) + ', butuh ' + fmtGr(k.used) + ')').join('; ') + '.');
  const neto = hasil - starterUsed; // stok olahan berubah neto: hasil - starter
  const now = new Date().toISOString(), judul = 'Buat ' + o.nama + (starterUsed ? ' ' + fmtG(hasil) + ' (starter ' + fmtG(starterUsed) + ')' : '');
  const ins = "INSERT INTO mutasi_bahan (bahan_id, waktu, jenis, grup_id, judul, delta_dg, sisa_dg, created_by) VALUES (?, ?, ?, ?, ?, ?, ";
  const stmts = [];
  for (const k of baku) {
    if (k.opname_at) stmts.push(db.prepare('UPDATE bahan SET stok_dg = stok_dg - ? WHERE id = ?').bind(k.used, k.bahan_id));
    stmts.push(db.prepare('UPDATE bahan SET produksi_at = ? WHERE id = ?').bind(now, k.bahan_id));
    stmts.push(k.opname_at
      ? db.prepare(ins + "(SELECT stok_dg FROM bahan WHERE id = ?), ?)").bind(k.bahan_id, now, 'produksi', cid, judul, -k.used, k.bahan_id, session.alias)
      : db.prepare(ins + "NULL, ?)").bind(k.bahan_id, now, 'produksi', cid, judul, -k.used, session.alias));
  }
  if (o.opname_at) stmts.push(db.prepare('UPDATE bahan SET stok_dg = stok_dg + ? WHERE id = ?').bind(neto, oid));
  // jenis 'produksi' juga untuk baris hasil olahan (16 Okt 2026): satu kejadian, satu pil di Riwayat (dulu 'stok' jadi dua kejadian)
  stmts.push(o.opname_at // satu baris neto (bukan -starter dan +hasil), supaya riwayat tampil sebagai satu kejadian
    ? db.prepare(ins + "(SELECT stok_dg FROM bahan WHERE id = ?), ?)").bind(oid, now, 'produksi', cid, judul, neto, oid, session.alias)
    : db.prepare(ins + "NULL, ?)").bind(oid, now, 'produksi', cid, judul, neto, session.alias));
  stmts.push(...hargaSetStmts(db, oid, hargaOlahan(segar, setDg - (starter ? starter.qty_dg : 0)), 'olahan', cid, session.alias, now));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('CHECK')) throw new Error('Stok bahan baru saja berubah (device lain) dan tidak cukup — refresh lalu coba lagi.');
    throw err;
  }
  await notifHabis(env, deps, baku.map((k) => ({ bahan_id: k.bahan_id, sebelum: k.opname_at ? k.stok_dg : null, sesudah: k.opname_at ? k.stok_dg - k.used : null })));
  return { olahan_id: oid, hasil_dg: hasil };
}

// ---- TAHAP 2: + Stok, opname, urutan, riwayat (13 Okt 2026) ----
// Aturan: bahan "dilacak" = opname_at terisi (stok awal sudah dimasukkan lewat sheet item). Bahan belum dilacak:
// + Stok hanya memperbarui harga (U18), stok tidak berubah. Stok tidak boleh minus (CHECK di tabel bahan).
// Satu baris tambah-stok -> statement. Dipakai add_stok (manual) dan approve_struk (foto). tracked = bahan sudah punya stok awal (opname_at).
function stokRowStmts(db, session, now, brow, row, key, grup, judul, sumber) {
  const tracked = !!brow.opname_at, rend = brow.rendemen_pct || 100;
  const bid = int(row.bahan_id, 'bahan_id', 1), qty = dec(row.qty_beli, 'jumlah'), isi = dec(row.isi_gr, 'isi (gr)'), total = int(row.total_harga || 0, 'total harga');
  // Rendemen (jalur B, 15 Okt 2026): stok dan harga dihitung dari gram BERSIH = gram bruto x rendemen (telur 80%: 1 kg beli = 800 gr)
  const gram = Math.round(qty * isi * 10 * rend / 100);
  if (gram <= 0) throw new Error('Jumlah x isi harus lebih dari 0.');
  const hargaKg = total > 0 ? Math.round(total / (gram / 10 / 1000)) : null; // harga beli per kg bersih
  const out = [
    db.prepare('INSERT INTO pembelian_bahan (bahan_id, tanggal, qty_beli, satuan_beli, isi_per_satuan_dg, qty_dasar_dg, total_harga, created_at, created_by, client_beli_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(bid, todayWIB(), qty, 'unit', Math.round(isi * 10), gram, total, now, session.alias, key),
  ];
  if (hargaKg !== null) {
    // Kebijakan harga (15 Okt 2026): harga sistem HANYA naik karena pembelian. Harga beli lebih rendah dicatat (diterapkan = 0), harga sistem tetap.
    out.push(db.prepare('INSERT INTO harga_riwayat (bahan_id, waktu, harga_lama, harga_baru, harga_beli, diterapkan, sumber, ref, oleh) SELECT id, ?, harga_per_kg, CASE WHEN ? > harga_per_kg THEN ? ELSE harga_per_kg END, ?, CASE WHEN ? > harga_per_kg THEN 1 ELSE 0 END, ?, ?, ? FROM bahan WHERE id = ? AND harga_per_kg != ?')
      .bind(now, hargaKg, hargaKg, hargaKg, hargaKg, sumber, grup, session.alias, bid, hargaKg));
  }
  out.push(db.prepare('UPDATE bahan SET stok_dg = stok_dg + ?, harga_per_kg = CASE WHEN ? IS NOT NULL AND ? > harga_per_kg THEN ? ELSE harga_per_kg END WHERE id = ?').bind(tracked ? gram : 0, hargaKg, hargaKg, hargaKg, bid));
  if (tracked) {
    out.push(db.prepare("INSERT INTO mutasi_bahan (bahan_id, waktu, jenis, grup_id, judul, delta_dg, sisa_dg, created_by) VALUES (?, ?, 'stok', ?, ?, ?, (SELECT stok_dg FROM bahan WHERE id = ?), ?)").bind(bid, now, grup, rend < 100 ? judul + ' (rendemen ' + rend + '%)' : judul, gram, bid, session.alias));
  }
  return out;
}

async function addStok(env, session, p) {
  const cid = String((p && p.client_beli_id) || '').trim();
  if (!cid) throw new Error('client_beli_id kosong.');
  const dup = await env.myposdb.prepare('SELECT 1 AS x FROM pembelian_bahan WHERE client_beli_id = ?').bind(cid + ':0').first();
  if (dup) return { duplicate: true };
  const baris = Array.isArray(p.baris) ? p.baris : [];
  if (!baris.length) throw new Error('Belum ada baris yang ditambahkan.');
  if (baris.length > 40) throw new Error('Maksimal 40 baris per struk.');
  const ids = [...new Set(baris.map((b) => int(b.bahan_id, 'bahan_id', 1)))];
  const { results: found } = await env.myposdb.prepare(`SELECT id, opname_at, rendemen_pct FROM bahan WHERE id IN (${ph(ids.length)})`).bind(...ids).all();
  if (found.length !== ids.length) throw new Error('Ada bahan yang nggak ketemu — refresh dulu.');
  const byRow = {};
  for (const f of found) byRow[f.id] = f;
  const now = new Date().toISOString(), db = env.myposdb, stmts = [];
  baris.forEach((b, i) => stmts.push(...stokRowStmts(db, session, now, byRow[Number(b.bahan_id)], b, cid + ':' + i, cid, 'Tambah stok', 'pembelian')));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('UNIQUE')) return { duplicate: true };
    throw err;
  }
  return { saved: baris.length };
}

async function addOpname(env, session, p, deps) {
  const cid = String((p && p.client_opname_id) || '').trim();
  if (!cid) throw new Error('client_opname_id kosong.');
  const dup = await env.myposdb.prepare('SELECT 1 AS x FROM opname_bahan WHERE client_opname_id = ?').bind(cid).first();
  if (dup) return { duplicate: true };
  const bid = int(p.bahan_id, 'bahan_id', 1), fisik = int(p.fisik_dg, 'fisik_dg');
  const b = await env.myposdb.prepare('SELECT id, stok_dg, opname_at FROM bahan WHERE id = ?').bind(bid).first();
  if (!b) throw new Error('Bahan nggak ketemu — refresh dulu.');
  const pertama = !b.opname_at, sebelum = pertama ? 0 : b.stok_dg, selisih = fisik - sebelum;
  const now = new Date().toISOString(), db = env.myposdb;
  try {
    await db.batch([
      db.prepare('INSERT INTO opname_bahan (bahan_id, tanggal, teoritis_sebelum_dg, fisik_dg, selisih_dg, created_at, created_by, client_opname_id) VALUES (?,?,?,?,?,?,?,?)').bind(bid, todayWIB(), sebelum, fisik, selisih, now, session.alias, cid),
      // opname TIDAK menyentuh produksi_at (tanggal di baris bahan hanya berubah oleh produksi, PRD §9 #26)
      db.prepare('UPDATE bahan SET stok_dg = ?, opname_at = ?, opname_dg = ? WHERE id = ?').bind(fisik, now, fisik, bid),
      db.prepare("INSERT INTO mutasi_bahan (bahan_id, waktu, jenis, grup_id, judul, delta_dg, sisa_dg, created_by) VALUES (?, ?, 'opname', ?, ?, ?, ?, ?)").bind(bid, now, cid, pertama ? 'Stok awal' : 'Hitung fisik', pertama ? null : selisih, fisik, session.alias),
    ]);
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('UNIQUE')) return { duplicate: true };
    throw err;
  }
  if (!pertama) await notifHabis(env, deps, [{ bahan_id: bid, sebelum: sebelum, sesudah: fisik }]);
  return { bahan_id: bid, stok_dg: fisik, pertama };
}

async function saveUrutanBahan(env, p) {
  const list = Array.isArray(p && p.urutan) ? p.urutan : [];
  if (!list.length) throw new Error('Urutan kosong.');
  const ids = list.map((x) => int(x.bahan_id, 'bahan_id', 1));
  if (new Set(ids).size !== ids.length) throw new Error('Bahan dobel di urutan.');
  const db = env.myposdb;
  await db.batch(list.map((x, i) => db.prepare('UPDATE bahan SET urut = ?, pemisah_setelah = ? WHERE id = ?').bind(i, Number(x.pemisah_setelah) ? 1 : 0, ids[i])));
  return { saved: list.length };
}

// Riwayat: per KEJADIAN (grup_id), terbaru dulu, cursor "waktu|grup_id". Satu produksi/struk = satu kejadian.
async function getRiwayatBahan(env, p) {
  const limit = Math.min(50, Math.max(1, parseInt(p.limit, 10) || 20));
  const bid = p.bahan_id ? int(p.bahan_id, 'bahan_id', 1) : null;
  const where = [], bind = [];
  if (bid) { where.push('bahan_id = ?'); bind.push(bid); }
  if (p.cursor) {
    const [w, g] = String(p.cursor).split('|');
    where.push('(waktu < ? OR (waktu = ? AND grup_id < ?))'); bind.push(w, w, g || '');
  }
  const { results: ev } = await env.myposdb
    .prepare(`SELECT grup_id, jenis, MAX(judul) AS judul, MAX(waktu) AS waktu FROM mutasi_bahan ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY grup_id, jenis ORDER BY waktu DESC, grup_id DESC LIMIT ?`)
    .bind(...bind, limit + 1).all();
  const more = ev.length > limit;
  const page = ev.slice(0, limit);
  let rows = [];
  if (page.length) {
    const q = `SELECT grup_id, bahan_id, delta_dg, sisa_dg FROM mutasi_bahan WHERE grup_id IN (${ph(page.length)})${bid ? ' AND bahan_id = ?' : ''} ORDER BY id`;
    ({ results: rows } = await env.myposdb.prepare(q).bind(...page.map((e) => e.grup_id), ...(bid ? [bid] : [])).all());
  }
  const by = {};
  for (const r of rows) (by[r.grup_id] = by[r.grup_id] || []).push({ bahan_id: r.bahan_id, delta_dg: r.delta_dg, sisa_dg: r.sisa_dg });
  const last = page[page.length - 1];
  const out = {
    kejadian: page.map((e) => ({ jenis: e.jenis, judul: e.judul, waktu: e.waktu, baris: by[e.grup_id] || [] })),
    next_cursor: more && last ? last.waktu + '|' + last.grup_id : null,
  };
  if (bid && !p.cursor) out.ringkasan = await ringkasanStok(env, bid);
  return out;
}

// Ringkasan hitungan stok sejak opname terakhir (PRD Bagian C): awal + masuk - keluar = sistem, dibanding stok tercatat.
// Baris opname ditulis dengan waktu yang sama dengan bahan.opname_at, jadi "sejak opname" = waktu > opname_at.
async function ringkasanStok(env, bid) {
  const db = env.myposdb;
  const b = await db.prepare('SELECT stok_dg, opname_at, opname_dg FROM bahan WHERE id = ?').bind(bid).first();
  if (!b) return null;
  if (!b.opname_at) return { dilacak: false };
  const s = await db.prepare("SELECT COALESCE(SUM(CASE WHEN delta_dg > 0 THEN delta_dg ELSE 0 END), 0) AS masuk, COALESCE(SUM(CASE WHEN delta_dg < 0 THEN delta_dg ELSE 0 END), 0) AS keluar FROM mutasi_bahan WHERE bahan_id = ? AND jenis != 'opname' AND waktu > ?").bind(bid, b.opname_at).first();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const k = await db.prepare("SELECT COALESCE(SUM(delta_dg), 0) AS total, COALESCE(SUM(CASE WHEN waktu >= ? THEN delta_dg ELSE 0 END), 0) AS d30 FROM mutasi_bahan WHERE bahan_id = ? AND jenis = 'opname'").bind(since30, bid).first();
  const awal = b.opname_dg || 0, sistem = awal + s.masuk + s.keluar;
  return { dilacak: true, opname_at: b.opname_at, awal_dg: awal, masuk_dg: s.masuk, keluar_dg: -s.keluar, sistem_dg: sistem, tercatat_dg: b.stok_dg, selisih_dg: b.stok_dg - sistem, koreksi_opname_30h_dg: k.d30, koreksi_opname_total_dg: k.total };
}

// Riwayat harga (owner saja), cursor "waktu|id". Satu baris = satu perubahan harga atau penurunan-saat-beli yang tidak diterapkan.
async function getRiwayatHarga(env, p) {
  const limit = Math.min(50, Math.max(1, parseInt(p.limit, 10) || 20));
  const bid = p.bahan_id ? int(p.bahan_id, 'bahan_id', 1) : null;
  const where = [], bind = [];
  if (bid) { where.push('bahan_id = ?'); bind.push(bid); }
  if (p.cursor) {
    const [w, i] = String(p.cursor).split('|');
    where.push('(waktu < ? OR (waktu = ? AND id < ?))'); bind.push(w, w, parseInt(i, 10) || 0);
  }
  const { results } = await env.myposdb
    .prepare(`SELECT id, bahan_id, waktu, harga_lama, harga_baru, harga_beli, diterapkan, sumber, ref, input_harga, input_berat, input_satuan, oleh FROM harga_riwayat ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY waktu DESC, id DESC LIMIT ?`)
    .bind(...bind, limit + 1).all();
  const more = results.length > limit, page = results.slice(0, limit), last = page[page.length - 1];
  // Beli/Struk: jumlah beli + total dari pembelian_bahan (created_at = waktu, bahan sama) supaya riwayat bisa menampilkan "5 kg · Rp X" di kiri
  const bel = page.filter((e) => e.sumber === 'pembelian' || e.sumber === 'struk');
  if (bel.length) {
    const ws = [...new Set(bel.map((e) => e.waktu))];
    const { results: pb } = await env.myposdb.prepare(`SELECT bahan_id, created_at, qty_beli, isi_per_satuan_dg, qty_dasar_dg, total_harga FROM pembelian_bahan WHERE created_at IN (${ph(ws.length)})`).bind(...ws).all();
    for (const e of bel) {
      const cand = pb.filter((x) => x.bahan_id === e.bahan_id && x.created_at === e.waktu);
      if (!cand.length) continue;
      const selisih = (x) => Math.abs((x.total_harga * 10000) / (x.qty_dasar_dg || 1) - (e.harga_beli || 0)); // bahan sama dobel di satu struk: ambil yang harga per kg-nya cocok
      const hit = cand.reduce((a, x) => (selisih(x) < selisih(a) ? x : a));
      e.beli = { qty: hit.qty_beli, isi_dg: hit.isi_per_satuan_dg, total: hit.total_harga };
    }
  }
  return { kejadian: page, next_cursor: more && last ? last.waktu + '|' + last.id : null };
}

// ---- TAHAP 2b: foto struk -> Pending Review (14 Okt 2026, keputusan U17) ----
// Pola Cost Tracker, tapi jalan di Worker: key = secret GEMINI_API_KEY, nama model = variabel OCR_MODEL (jangan hardcode),
// batas panggilan per hari = variabel OCR_LIMIT_HARIAN (default 30). Stok TIDAK berubah sampai approve_struk.
const OCR_MODEL_DEFAULT = 'gemini-3.5-flash-lite'; // sama dengan Cost Tracker; BELUM diverifikasi masih tersedia, ganti lewat OCR_MODEL
const OCR_MAX_B64 = 3500000; // ~2,6 MB; klien sudah resize ke sisi panjang ~1280px

function promptStruk(daftar) {
  return [
    'Kamu membaca struk belanja bahan baku toko roti di Indonesia (minimarket/toko grosir). Baca gambar struk dan keluarkan HANYA JSON (tanpa markdown, tanpa penjelasan) dengan struktur persis ini:',
    '{"toko": string atau null, "tanggal": "YYYY-MM-DD" atau null, "jam": "HH:MM" atau null, "id_transaksi": string atau null, "total": angka atau null, "items": [{"nama_raw": string, "bahan_id": angka atau null, "qty": angka, "satuan": string, "isi_gr": angka atau null, "harga_total": angka}]}',
    '',
    '"items" hanya barang yang dibeli. JANGAN masukkan baris diskon, pajak, biaya, subtotal, total, tunai, atau kembalian.',
    '"nama_raw" diisi PERSIS seperti tertulis di struk (biasanya disingkat).',
    '"qty" = jumlah satuan yang dibeli (angka). "satuan" = satuan beli singkat (pcs, kg, sak, dll), kosongkan kalau tidak jelas.',
    '"isi_gr" = isi per SATU satuan dalam gram, dibaca dari nama barang (misal "1KG" = 1000, "500G" = 500, "400G" = 400). Cairan dalam ml isi dengan angka ml. Kalau tidak tertera, isi null, jangan mengarang.',
    'Untuk bahan di daftar dengan "kategori": "packaging" (plastik, sticker, cable ties), hitungannya PER PCS: "qty" = jumlah pak/bungkus yang dibeli, "isi_gr" = jumlah pcs per pak dari nama barang (misal "OPP 15x25 isi 100" = 100; kalau dijual satuan tanpa isi, isi 1), bukan gram.',
    '"harga_total" = harga total baris itu (qty x harga satuan) dalam rupiah, bilangan bulat, sesuai angka di struk.',
    '"total" = total yang dibayar di struk (grand total). "jam" dan "id_transaksi" diambil dari yang tercetak; kalau tidak ada isi null.',
    '"bahan_id": cocokkan tiap item ke satu "id" di daftar bahan di bawah (nama atau alias yang cocok; singkatan struk boleh, misal "ROSE B GL 1KG" untuk gula Rosebrand). Kalau tidak ada yang cocok, isi null. Jangan mengarang id.',
    '',
    'Daftar bahan:',
    JSON.stringify(daftar),
  ].join('\n');
}

async function panggilGemini(env, b64, mime, prompt) {
  const model = env.OCR_MODEL || OCR_MODEL_DEFAULT;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { responseMimeType: 'application/json' } }),
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) throw new Error('Baca struk gagal: ' + ((json && json.error && json.error.message) || 'HTTP ' + res.status));
  const t = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
  if (!t) throw new Error('Baca struk gagal: tidak ada hasil dari model.');
  try { return JSON.parse(t); } catch (e) { throw new Error('Baca struk gagal: hasil model bukan JSON yang valid.'); }
}

// Sebar selisih (diskon/pajak/biaya) proporsional ke harga item; pembulatan sisa terbesar supaya jumlah item = total struk persis.
function sebarHarga(harga, total) {
  const sum = harga.reduce((a, b) => a + b, 0);
  const raw = harga.map((h) => (h / sum) * total), fl = raw.map(Math.floor);
  let rem = total - fl.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rem > 0) { fl[i]++; rem--; } });
  return fl;
}

// ---- OCR tulisan tangan -> daftar bahan resep (15 Okt 2026) ----
// Dipanggil editor resep (tombol foto di kanan Batal). TIDAK menyimpan apa pun: cuma balikin {bahan:[{nama, gram}]};
// klien memasukkannya ke editor sebagai baris belum tersimpan. Berbagi kuota harian dengan baca_struk (tabel ocr_kuota).
function promptResepTulisan(daftar) {
  return [
    'Kamu membaca foto resep TULISAN TANGAN untuk toko roti di Indonesia. Ambil HANYA daftar bahan beserta takarannya dan keluarkan HANYA JSON (tanpa markdown, tanpa penjelasan) dengan struktur persis ini:',
    '{"bahan": [{"nama": string, "gram": angka}]}',
    '',
    'Aturan:',
    '- Urutan bahan sama seperti di tulisan. Abaikan judul, langkah/cara membuat, suhu oven, waktu, dan catatan.',
    '- "gram" = takaran dalam GRAM. Konversi: kg x 1000, ons x 100. Cairan (ml) isi angka ml apa adanya. Kalau takaran bukan berat/volume (misal "2 butir", "secukupnya") atau tidak terbaca, JANGAN masukkan bahan itu.',
    '- Angka desimal pakai titik (1,5 kg = 1500). Jangan mengarang angka yang tidak terbaca.',
    '- "nama": kalau cocok dengan satu bahan di daftar bawah (nama atau alias, ejaan tulisan tangan boleh beda), pakai PERSIS nama di daftar. Kalau tidak ada yang cocok, tulis nama seperti terbaca (huruf kapital di awal kata).',
    '',
    'Daftar bahan:',
    JSON.stringify(daftar),
  ].join('\n');
}

async function bacaResepTulisan(env, p) {
  const db = env.myposdb;
  const mime = String((p && p.mime) || 'image/jpeg');
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error('Format foto nggak didukung.');
  const b64 = String((p && p.image_base64) || '');
  if (b64.length < 100) throw new Error('Foto kosong.');
  if (b64.length > OCR_MAX_B64) throw new Error('Foto terlalu besar, kecilkan dulu.');
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY belum di-set di worker (wrangler secret put GEMINI_API_KEY).');
  const limit = parseInt(env.OCR_LIMIT_HARIAN, 10) || 30, hari = todayWIB();
  const k = await db.prepare('SELECT jumlah FROM ocr_kuota WHERE tanggal = ?').bind(hari).first();
  if (k && k.jumlah >= limit) throw new Error('Batas baca foto hari ini (' + limit + ') sudah habis. Isi manual atau coba besok.');
  await db.prepare('INSERT INTO ocr_kuota (tanggal, jumlah) VALUES (?, 1) ON CONFLICT(tanggal) DO UPDATE SET jumlah = jumlah + 1').bind(hari).run();

  const { results: bahan } = await db.prepare('SELECT nama, alias FROM bahan WHERE kategori != \'packaging\' ORDER BY nama COLLATE NOCASE').all();
  const hasil = await panggilGemini(env, b64, mime, promptResepTulisan(bahan.map((b) => ({ nama: b.nama, alias: String(b.alias || '').split('|').filter(Boolean) }))));
  const out = (Array.isArray(hasil.bahan) ? hasil.bahan : []).slice(0, 40)
    .map((x) => ({ nama: String((x && x.nama) || '').trim().slice(0, 80), gram: Math.round(Number(x && x.gram) * 10) / 10 }))
    .filter((x) => x.nama && x.gram > 0 && x.gram <= 100000);
  if (!out.length) throw new Error('Tulisan nggak terbaca (tidak ada bahan). Foto ulang lebih dekat dan terang.');
  return { bahan: out };
}

async function bacaStruk(env, session, p) {
  const db = env.myposdb;
  const cid = String((p && p.client_struk_id) || '').trim();
  if (!cid) throw new Error('client_struk_id kosong.');
  const ex = await db.prepare('SELECT id FROM struk_bahan WHERE client_struk_id = ?').bind(cid).first();
  if (ex) return strukDetail(env, ex.id); // unggah ulang dari antrean HP: balikin yang sudah ada, tanpa panggil model lagi
  const mime = String(p.mime || 'image/jpeg');
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error('Format foto nggak didukung.');
  const b64 = String(p.image_base64 || '');
  if (b64.length < 100) throw new Error('Foto kosong.');
  if (b64.length > OCR_MAX_B64) throw new Error('Foto terlalu besar, kecilkan dulu.');
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY belum di-set di worker (wrangler secret put GEMINI_API_KEY).');
  const limit = parseInt(env.OCR_LIMIT_HARIAN, 10) || 30, hari = todayWIB();
  const k = await db.prepare('SELECT jumlah FROM ocr_kuota WHERE tanggal = ?').bind(hari).first();
  if (k && k.jumlah >= limit) throw new Error('Batas baca struk hari ini (' + limit + ') sudah habis. Isi manual atau coba besok.');
  await db.prepare('INSERT INTO ocr_kuota (tanggal, jumlah) VALUES (?, 1) ON CONFLICT(tanggal) DO UPDATE SET jumlah = jumlah + 1').bind(hari).run();

  const { results: bahan } = await db.prepare('SELECT id, nama, alias, kategori FROM bahan ORDER BY nama COLLATE NOCASE').all();
  const hasil = await panggilGemini(env, b64, mime, promptStruk(bahan.map((b) => ({ id: b.id, nama: b.nama, kategori: b.kategori || 'bahan', alias: String(b.alias || '').split('|').filter(Boolean) }))));

  const validIds = new Set(bahan.map((b) => b.id));
  const items = (Array.isArray(hasil.items) ? hasil.items : []).slice(0, 60).map((it) => ({
    teks: String(it.nama_raw || '').trim().slice(0, 120),
    bahan_id: validIds.has(Number(it.bahan_id)) ? Number(it.bahan_id) : null, // id di luar daftar dibuang
    qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
    satuan: String(it.satuan || '').slice(0, 20),
    isi_dg: Number(it.isi_gr) > 0 ? Math.round(Number(it.isi_gr) * 10) : null,
    harga: Math.max(0, Math.round(Number(it.harga_total) || 0)),
  })).filter((it) => it.teks);
  if (!items.length) throw new Error('Struk nggak terbaca (tidak ada item). Foto ulang lebih dekat dan terang.');

  const totalStruk = Math.round(Number(hasil.total)) || 0, sum = items.reduce((s, it) => s + it.harga, 0);
  let net = items.map((it) => it.harga), selisih = 0;
  // Sebar hanya kalau total terbaca wajar (0,5x–1,5x jumlah item); di luar itu kemungkinan salah baca, pakai harga item apa adanya.
  if (totalStruk > 0 && sum > 0 && totalStruk !== sum && totalStruk / sum >= 0.5 && totalStruk / sum <= 1.5) { net = sebarHarga(items.map((it) => it.harga), totalStruk); selisih = totalStruk - sum; }

  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(String(hasil.tanggal || '')) ? hasil.tanggal : todayWIB();
  const jamOk = /^\d{1,2}:\d{2}$/.test(String(hasil.jam || ''));
  const jam = jamOk ? String(hasil.jam) : new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16);
  const idTrx = String(hasil.id_transaksi || '').trim().slice(0, 60) || null;
  const model = env.OCR_MODEL || OCR_MODEL_DEFAULT, now = new Date().toISOString();

  const stmts = [db.prepare("INSERT INTO struk_bahan (client_struk_id, toko, tanggal, jam, jam_perkiraan, id_transaksi, total_struk, selisih, status, sumber, provider, model, created_at, created_by) VALUES (?,?,?,?,?,?,?,?, 'pending', 'foto', 'gemini', ?, ?, ?)")
    .bind(cid, String(hasil.toko || '').trim().slice(0, 80) || null, tanggal, jam, jamOk ? 0 : 1, idTrx, totalStruk || null, selisih, model, now, session.alias)];
  items.forEach((it, i) => stmts.push(db.prepare('INSERT INTO struk_bahan_item (struk_id, urut, teks_struk, bahan_id, qty, satuan, isi_gr_dg, harga_total_net) VALUES ((SELECT id FROM struk_bahan WHERE client_struk_id = ?), ?, ?, ?, ?, ?, ?, ?)')
    .bind(cid, i, it.teks, it.bahan_id, it.qty, it.satuan, it.isi_dg, net[i])));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (!String(err.message || '').toUpperCase().includes('UNIQUE')) throw err; // dua unggahan bersamaan: yang kalah ambil punya yang menang
  }
  const row = await db.prepare('SELECT id FROM struk_bahan WHERE client_struk_id = ?').bind(cid).first();
  return strukDetail(env, row.id);
}

async function strukDetail(env, id) {
  const db = env.myposdb;
  const s = await db.prepare('SELECT id, toko, tanggal, jam, jam_perkiraan, id_transaksi, total_struk, selisih, status, provider, model, created_at FROM struk_bahan WHERE id = ?').bind(id).first();
  if (!s) throw new Error('Struk nggak ketemu, mungkin sudah di-approve atau dihapus.');
  const { results: items } = await db.prepare('SELECT id, urut, teks_struk, bahan_id, qty, satuan, isi_gr_dg, harga_total_net FROM struk_bahan_item WHERE struk_id = ? ORDER BY urut').bind(id).all();
  // duplikat = peringatan lunak: ID transaksi sama, atau tanggal + total sama persis (nama toko tidak dibandingkan)
  const { results: duplikat } = await db.prepare("SELECT id, status, toko, tanggal FROM struk_bahan WHERE id <> ? AND ((id_transaksi IS NOT NULL AND id_transaksi <> '' AND id_transaksi = ?) OR (total_struk > 0 AND tanggal = ? AND total_struk = ?)) ORDER BY id DESC LIMIT 3")
    .bind(id, s.id_transaksi || '', s.tanggal || '', s.total_struk || 0).all();
  return { struk: s, items: items.map((i) => ({ id: i.id, teks_struk: i.teks_struk, bahan_id: i.bahan_id, qty: i.qty, satuan: i.satuan, isi_gr: i.isi_gr_dg == null ? null : i.isi_gr_dg / 10, harga_total: i.harga_total_net })), duplikat };
}

async function listStrukPending(env) {
  const { results } = await env.myposdb.prepare("SELECT s.id, s.toko, s.tanggal, s.total_struk, s.created_at, (SELECT COUNT(*) FROM struk_bahan_item i WHERE i.struk_id = s.id) AS n_item FROM struk_bahan s WHERE s.status = 'pending' ORDER BY s.id DESC LIMIT 50").all();
  return { jumlah: results.length, struk: results };
}

async function approveStruk(env, session, p) {
  const db = env.myposdb, sid = int(p.id, 'id', 1);
  const s = await db.prepare('SELECT id, status, toko FROM struk_bahan WHERE id = ?').bind(sid).first();
  if (!s) throw new Error('Struk nggak ketemu, mungkin sudah dihapus.');
  if (s.status === 'final') return { duplicate: true };
  const rows = Array.isArray(p.items) ? p.items : [];
  if (!rows.length) throw new Error('Belum ada baris yang dicentang.');
  if (rows.length > 60) throw new Error('Terlalu banyak baris.');
  const ids = [...new Set(rows.map((r) => int(r.bahan_id, 'bahan_id', 1)))];
  const { results: found } = await db.prepare(`SELECT id, opname_at, alias, rendemen_pct FROM bahan WHERE id IN (${ph(ids.length)})`).bind(...ids).all();
  if (found.length !== ids.length) throw new Error('Ada bahan yang nggak ketemu, refresh dulu.');
  const byB = {};
  for (const f of found) byB[f.id] = f;
  const { results: raw } = await db.prepare('SELECT id, teks_struk FROM struk_bahan_item WHERE struk_id = ?').bind(sid).all();
  const rawMap = {};
  for (const r of raw) rawMap[r.id] = r.teks_struk;
  const now = new Date().toISOString(), judul = (s.toko || 'Struk belanja').slice(0, 60), stmts = [], aliasBaru = {};
  rows.forEach((r, i) => {
    const bid = Number(r.bahan_id);
    stmts.push(...stokRowStmts(db, session, now, byB[bid], r, 'struk:' + sid + ':' + i, 'struk:' + sid, judul, 'struk'));
    const t = rawMap[r.item_id];
    if (t) (aliasBaru[bid] = aliasBaru[bid] || []).push(t);
  });
  for (const bid of Object.keys(aliasBaru)) { // alias dipelajari: nama mentah struk ditambah ke bahan (tanpa duplikat, tanpa peka huruf besar)
    const cur = String(byB[bid].alias || '').split('|').filter(Boolean), low = new Set(cur.map((a) => a.toLowerCase()));
    for (const t of aliasBaru[bid]) { const a = String(t).trim().slice(0, 60); if (a && !low.has(a.toLowerCase())) { cur.push(a); low.add(a.toLowerCase()); } }
    stmts.push(db.prepare('UPDATE bahan SET alias = ? WHERE id = ?').bind(cur.join('|').slice(0, 500), Number(bid)));
  }
  stmts.push(db.prepare("UPDATE struk_bahan SET status = 'final', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'pending'").bind(now, session.alias, sid));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('UNIQUE')) return { duplicate: true }; // approve ganda
    throw err;
  }
  return { saved: rows.length };
}

async function rejectStruk(env, p) {
  const db = env.myposdb, sid = int(p.id, 'id', 1);
  const s = await db.prepare('SELECT status FROM struk_bahan WHERE id = ?').bind(sid).first();
  if (!s) return { rejected: true };
  if (s.status !== 'pending') throw new Error('Struk sudah di-approve, nggak bisa dihapus.');
  await db.batch([db.prepare('DELETE FROM struk_bahan_item WHERE struk_id = ?').bind(sid), db.prepare("DELETE FROM struk_bahan WHERE id = ? AND status = 'pending'").bind(sid)]);
  return { rejected: true };
}

// ---- Notif Habis (U16: Web Push ke owner), hanya pada transisi bukan-Habis -> Habis ----
const isHabis = (stok, need) => stok <= 0 || (need != null && stok < need);
async function notifHabis(env, deps, rows) {
  try {
    if (!deps || !deps.pushHabis) return;
    const cand = rows.filter((r) => r.sesudah !== null);
    if (!cand.length) return;
    const ids = cand.map((r) => r.bahan_id);
    const { results: needs } = await env.myposdb.prepare(`SELECT rb.bahan_id, MAX(rb.qty_dg) AS need FROM resep_bahan rb JOIN resep r ON r.id = rb.resep_id AND r.aktif = 1 WHERE rb.bahan_id IN (${ph(ids.length)}) GROUP BY rb.bahan_id`).bind(...ids).all();
    const nm = {};
    for (const n of needs) nm[n.bahan_id] = n.need;
    const baru = cand.filter((r) => isHabis(r.sesudah, nm[r.bahan_id] == null ? null : nm[r.bahan_id]) && !(r.sebelum !== null && isHabis(r.sebelum, nm[r.bahan_id] == null ? null : nm[r.bahan_id])));
    if (!baru.length) return;
    const { results } = await env.myposdb.prepare(`SELECT nama FROM bahan WHERE id IN (${ph(baru.length)})`).bind(...baru.map((r) => r.bahan_id)).all();
    deps.pushHabis(results.map((r) => r.nama)); // gagal kirim push tidak boleh menggagalkan produksi/opname
  } catch (e) { console.error('notifHabis GAGAL:', e && e.message); }
}

// ---- DISPATCH (dipanggil router di worker.js setelah validateSession) ----
async function handleResep(env, session, action, params, deps) {
  const p = params || {};
  switch (action) {
    case 'get_resep_index': await requireRole(env, session, ['owner', 'chef'], 'Resep cuma bisa dilihat owner dan chef.'); return getResepIndex(env);
    case 'get_resep': { const role = await requireRole(env, session, ['owner', 'chef'], 'Resep cuma bisa dilihat owner dan chef.'); return getResep(env, role, p.item_id); }
    case 'get_bahan': { const role = await requireRole(env, session, ['owner', 'chef'], 'Bahan cuma bisa dilihat owner dan chef.'); return getBahan(env, role); }
    case 'get_tarif': await requireRole(env, session, ['owner'], 'Tarif cuma bisa dilihat owner.'); return env.myposdb.prepare('SELECT * FROM tarif_non_stok WHERE id = 1').first();
    case 'save_resep': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengubah resep.'); return saveResep(env, session, p);
    case 'delete_resep': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh menghapus resep.'); return deleteResep(env, session, p);
    case 'save_bahan': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengubah data bahan.'); return saveBahan(env, session, p);
    case 'save_tarif': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengubah tarif.'); return saveTarif(env, session, p);
    case 'add_produksi': await requireRole(env, session, ['owner', 'chef'], 'Produksi cuma bisa dicatat owner dan chef.'); return addProduksi(env, session, p, deps);
    case 'add_stok': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh menambah stok.'); return addStok(env, session, p);
    case 'add_opname': await requireRole(env, session, ['owner', 'chef'], 'Opname cuma bisa dicatat owner dan chef.'); return addOpname(env, session, p, deps);
    case 'save_olahan': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengatur komposisi olahan.'); return saveOlahan(env, session, p);
    case 'buat_olahan': await requireRole(env, session, ['owner', 'chef'], 'Olahan cuma bisa dibuat owner dan chef.'); return buatOlahan(env, session, p, deps);
    case 'save_urutan_bahan': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh mengatur posisi bahan.'); return saveUrutanBahan(env, p);
    case 'get_riwayat_harga': await requireRole(env, session, ['owner'], 'Riwayat harga cuma bisa dilihat owner.'); return getRiwayatHarga(env, p);
    case 'get_riwayat_bahan': await requireRole(env, session, ['owner', 'chef'], 'Riwayat bahan cuma bisa dilihat owner dan chef.'); return getRiwayatBahan(env, p);
    case 'baca_struk': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh membaca struk.'); return bacaStruk(env, session, p);
    case 'baca_resep_tulisan': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh membaca resep dari foto.'); return bacaResepTulisan(env, p);
    case 'get_struk_pending': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh melihat struk.'); return p.id ? strukDetail(env, int(p.id, 'id', 1)) : listStrukPending(env);
    case 'approve_struk': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh meng-approve struk.'); return approveStruk(env, session, p);
    case 'reject_struk': await requireRole(env, session, ['owner'], 'Cuma owner yang boleh menghapus struk.'); return rejectStruk(env, p);
    case 'set_role': return setRole(env, session, p);
    default: throw new Error('Unknown action: ' + action);
  }
}

// ===== AKHIR MODUL RESEP =====

// WP1: Auth (verify_login) + tabel sessions + middleware validateSession.
// WP2: update_stok + add_order — write paling sering dipakai harian.
// WP3: add_menu_item, update_menu_item, delete_menu_row, delete_category,
// update_order, delete_order.
// WP3.5 (belum diberi nomor resmi di PRD): get_menu, get_customers — read publik,
// prasyarat testing manual lewat UI (tanpa ini, add_menu_item sukses tapi gak
// nongol di layar karena frontend gantung ke get_menu buat refresh tampilan).
// WP4: topup_saldo, reconcile_saldo.
// WP5: get_orders, get_orders_search, get_customers_saldo, get_customer_saldo_detail
// (gated GET actions — sebelum ini cuma di-gate, belum ada handler-nya).
// WP6: publish_menu (+ commit ke GitHub, non-fatal) dan get_published_menu.
// GITHUB_TOKEN WAJIB di-set manual via `wrangler secret put GITHUB_TOKEN` sebelum
// bagian commit GitHub-nya beneran jalan — TANPA itu publish_menu tetap sukses nyimpen
// ke D1 (behavior yang benar/expected, bukan bug), cuma bagian commit-nya balik
// {committed:false}.
// BARU 19 Sep 2026:
// - update_menu_aktif + kolom menu.aktif (toggle "tampil di tab Order", frontend v16 Sep).
//   WAJIB jalanin ALTER TABLE menu ADD COLUMN aktif ... di D1 SEBELUM deploy versi ini,
//   kalau tidak get_menu error "no such column: aktif".
// - FIX bug customer_id '' (lihat ensureCustomerRecorded) — pakai NULL, bukan '' , karena
//   customer.customer_id UNIQUE dan '' dianggap nilai yang SAMA antar baris.
// - processExpiredPrepDeductions (potongan Stok Real + Saldo Real harian) + handler
//   scheduled() — ini bagian inti WP7. Cron di wrangler.toml.
// BARU 20 Sep 2026: archiveOldPaidOrders (WP7 sisa), add_allowed_email/delete_allowed_email (WP8),
// dan Push Notification order baru (subscribe_push + kirim push dari add_order). WAJIB buat tabel
// push_subscriptions di D1 (migrasi-20sep-push.sql) sebelum subscribe_push dipakai.
// - pay_order_with_saldo (keputusan Shakies 19 Sep 2026): Lunas manual pas saldo customer
//   KURANG = saldo dipakai habis, sisanya cash. Lihat payOrderWithSaldo.
// Semua action di PRD-Migrasi-Backend-D1.md Section 8 sekarang sudah ada di file ini.
// BARU 24 Sep 2026: get_customers_ltv + get_customer_profile (PRD Customer LTV & Profile,
// Bagian 5) + refreshCustomerLtv jadi bagian dari runDailyJobs (Bagian 8). WAJIB jalanin
// migrasi-24sep-ltv.sql SEBELUM deploy versi ini.
// BARU 24 Sep 2026 (v2): update_customer_name + merge_customer (Bagian 4.2/4.3/6.2), lewat
// mergeOrRenameCustomer() bersama. Open Item #1 (customer_id bentrok pas merge) DIPUTUSIN:
// diblokir kalau kedua nama sama-sama punya saldo Top Up sendiri, lihat komentar fungsinya.
// BARU 25 Sep 2026: getCustomerProfile pake json_each() buat agregasi menu favorit (Open Item
// #3), ganti loop-JS yang lama. WAJIB jalanin migrasi-25sep-index.sql (Open Item #2 — index
// order_pos/archive by LOWER(customer_name) & delivery_date) SEBELUM/BARENG deploy ini.
//
// Binding D1 di wrangler: env.myposdb (nama binding yang dipakai pas setup WP0).
//
// CATATAN LOCKING (PRD Section 6): TIDAK ada LockService pengganti secara eksplisit.
// D1 sendiri single-writer (dibangun di atas satu Durable Object per database), jadi
// serialisasi tulis udah didapat otomatis DALAM SATU QUERY. Yang TIDAK otomatis aman:
// pola baca-lalu-tulis yang melintasi >1 query terpisah (misal generateItemId: baca
// kategori_kode + baca menu, BARU insert) — dua request yang nyaris bareng bisa
// dua-duanya baca state lama sebelum salah satu sempat nulis. Proteksinya BUKAN lock,
// tapi UNIQUE/PRIMARY KEY constraint di kolom hasil akhir (item_id, client_item_id)
// + catch-and-retry kalau tabrakan — pola yang sama kayak client_order_id di WP2,
// diperluas ke generateItemId di WP3, dan ke generateCustomerId di WP4 (lihat topupSaldo).
//
// CATATAN KHUSUS WP4 (reconcile_saldo — RISIKO TERBUKA, lihat PRD Section 10 baris 1):
// FIFO alokasi saldo ke banyak order BUKAN satu query — baca kandidat order + saldo_real
// (SELECT terpisah), hitung alokasi di JS, baru tulis lewat env.myposdb.batch() (transaksi
// atomik D1 untuk BAGIAN TULISNYA doang). Window baca->tulis TETAP ADA: kalau reconcile
// buat CUSTOMER YANG SAMA kepanggil 2x nyaris bareng (skenario nyata: abis Top Up + bareng
// Prep/Riwayat di-load), dua-duanya bisa baca saldo & daftar order Belum Lunas yang sama,
// dan overlap alokasi. Ini keputusan PRD yang sudah ada, bukan kelalaian — mitigasinya
// "test 2-device concurrent reconcile" sebagai bagian dari gate G3, BUKAN nambah lock baru.
// WAJIB masuk checklist manual testing sebelum cutover.

const GOOGLE_CLIENT_ID = '403073099452-nsj2p0kfupqr86opvr0fjovhv0tcfru7.apps.googleusercontent.com';
const SESSION_TTL_DAYS = 30; // sama seperti Code_production.gs

// CATATAN ARSITEKTUR (baru, gak ada di GAS): Content Service Apps Script gak kena
// enforcement CORS browser dengan cara yang sama seperti Worker biasa — fetch dari
// index.html (GitHub Pages) ke domain lain SEKARANG wajib header CORS eksplisit, atau
// browser nolak response-nya sebelum sempat kebaca JS. Ini bukan pilihan desain, ini
// konsekuensi pindah ke Workers. [Pasti]
const ALLOWED_ORIGINS = [
  'https://heran-dika.github.io',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonOut(obj, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ==== AUTH ====

// Replikasi persis verifyLogin() di Code_production.gs. Satu-satunya perbedaan:
// ALLOWED_EMAILS hardcode (objek JS) -> query tabel D1 `allowed_emails`, sesuai
// keputusan PRD Section 7 (Opsi A, 12 Sep 2026) supaya staff bisa ditambah/dihapus
// tanpa deploy ulang.
async function verifyLogin(env, idToken) {
  if (!idToken) return { status: 'error', message: 'Token kosong.' };

  const resp = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken)
  );
  if (resp.status !== 200) {
    return { status: 'error', message: 'Token Google nggak valid atau expired.' };
  }

  const info = await resp.json();
  if (info.aud !== GOOGLE_CLIENT_ID) {
    return { status: 'error', message: 'Token bukan buat aplikasi ini.' };
  }
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    return { status: 'error', message: 'Email Google belum diverifikasi.' };
  }

  const email = String(info.email || '').trim().toLowerCase();
  const row = await env.myposdb
    .prepare('SELECT email, alias, is_owner, role FROM allowed_emails WHERE email = ?')
    .bind(email)
    .first();

  if (!row) {
    return { status: 'not_registered', message: 'Email ini belum terdaftar buat nulis data ke sistem beneran.' };
  }

  const sessionToken = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  await env.myposdb
    .prepare('INSERT INTO sessions (session_token, email, alias, expires_at) VALUES (?, ?, ?, ?)')
    .bind(sessionToken, email, row.alias, expiresAt)
    .run();

  return { status: 'ok', data: { session_token: sessionToken, alias: row.alias, email, is_owner: Number(row.is_owner) === 1, role: Number(row.is_owner) === 1 ? 'owner' : (row.role === 'chef' ? 'chef' : 'staf') } };
}

// Replikasi persis validateSession() di Code_production.gs. Self-cleaning: session
// yang ketemu udah expired langsung dihapus (pola sama seperti PropertiesService.
// deleteProperty di versi GAS), gak perlu job pembersihan terpisah.
async function validateSession(env, token) {
  if (!token) return null;
  const row = await env.myposdb
    .prepare('SELECT email, alias, expires_at FROM sessions WHERE session_token = ?')
    .bind(token)
    .first();
  if (!row) return null;
  if (!row.expires_at || Date.now() > row.expires_at) {
    await env.myposdb.prepare('DELETE FROM sessions WHERE session_token = ?').bind(token).run();
    return null;
  }
  return { email: row.email, alias: row.alias };
}

// ==== MENU: update_stok ====

// Replikasi persis setMenuStok() di Code_production.gs, termasuk clamp minimal 0
// (FIX 21 Agustus 2026 di kode asli — Stok Real merepresentasikan stok fisik, gak
// boleh minus). Beda dari GAS: gak ada lagi konsep "row" yang bisa geser — D1 nyari
// baris langsung by item_id (PRIMARY KEY), jadi race condition nomor baris yang jadi
// alasan FIX 12 Agustus di kode asli otomatis gak relevan lagi di D1.
async function setMenuStok(env, p) {
  const itemId = String(p.item_id || '').trim();
  if (!itemId) throw new Error('item_id kosong — refresh menu dulu baru ubah stok lagi.');
  const stokValue = Math.max(0, Number(p.stok) || 0);

  const result = await env.myposdb
    .prepare('UPDATE menu SET stok_real = ? WHERE item_id = ?')
    .bind(stokValue, itemId)
    .run();

  if (!result.meta || result.meta.changes === 0) {
    throw new Error('Item ini nggak ketemu lagi di Menu (mungkin baru aja dihapus device lain) — refresh dulu.');
  }
  return { updated: true };
}

// ==== MENU: update_menu_aktif (BARU 19 Sep 2026 — fitur baru di luar GAS) ====

// Toggle "Available": item nonaktif (aktif=0) disembunyikan dari tab Order di frontend.
// Independen dari stok — murni visibility manual. Kontrak request dari frontend
// (toggleMenuAktif di index.html): { row, item_id, aktif, device_label }. `row` diabaikan
// (sama kayak update_stok — D1 nyari langsung by item_id).
async function updateMenuAktif(env, p) {
  const itemId = String(p.item_id || '').trim();
  if (!itemId) throw new Error('item_id kosong — refresh menu dulu baru ubah ketersediaan lagi.');
  const result = await env.myposdb
    .prepare('UPDATE menu SET aktif = ? WHERE item_id = ?')
    .bind(p.aktif === true ? 1 : 0, itemId)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    throw new Error('Item ini nggak ketemu lagi di Menu (mungkin baru aja dihapus device lain) — refresh dulu.');
  }
  return { updated: true };
}

// ==== MENU: add_menu_item / update_menu_item / delete_menu_row / delete_category (WP3) ====

// Replikasi generateItemId() di Code_production.gs, dipecah 2 bagian karena beda
// sumber tabrakan (lihat catatan locking di kepala file):
//
// 1) ensureKategoriKode: kategori baru butuh kode 2-digit baru. INSERT OR IGNORE lalu
//    re-SELECT — kalau 2 request bikin kategori baru yang SAMA nyaris bareng, salah
//    satu INSERT-nya di-ignore sama PRIMARY KEY(kategori), dan re-SELECT balikin kode
//    yang BENERAN kepake (bukan yang barusan dihitung locally, yang mungkin udah basi).
// 2) generateItemId: baca kode + baca max sequence existing di tabel menu buat kode
//    itu. Ini TETAP bisa race (2 request baca max seq yang sama sebelum salah satu
//    sempat INSERT) — makanya addMenuItem() di bawah retry generate ulang kalau INSERT
//    gagal karena item_id (PRIMARY KEY) tabrakan, bukan mengandalkan bagian ini bebas race.
async function ensureKategoriKode(env, kategori) {
  const existing = await env.myposdb
    .prepare('SELECT kode FROM kategori_kode WHERE kategori = ?')
    .bind(kategori)
    .first();
  if (existing) return existing.kode;

  const { results } = await env.myposdb.prepare('SELECT kode FROM kategori_kode').all();
  let maxKode = 0;
  for (const row of results) {
    const n = parseInt(row.kode, 10);
    if (!isNaN(n) && n > maxKode) maxKode = n;
  }
  const candidateKode = String(maxKode + 1).padStart(2, '0');

  await env.myposdb
    .prepare('INSERT OR IGNORE INTO kategori_kode (kategori, kode) VALUES (?, ?)')
    .bind(kategori, candidateKode)
    .run();

  const confirmed = await env.myposdb
    .prepare('SELECT kode FROM kategori_kode WHERE kategori = ?')
    .bind(kategori)
    .first();
  return confirmed ? confirmed.kode : candidateKode;
}

// Tanggal buat item_id WAJIB Asia/Jakarta (sama seperti Session.getScriptTimeZone() di
// GAS) — pakai new Date().toISOString() polos bakal salah tanggal di sekitar tengah
// malam WIB (UTC+7), karena itu balikin tanggal UTC. [Pasti]
function todayJakartaISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // yyyy-mm-dd
}
function todayJakartaCompact() {
  return todayJakartaISO().replace(/-/g, '');
}

async function generateItemId(env, kategori) {
  const kode = await ensureKategoriKode(env, kategori);
  const { results } = await env.myposdb
    .prepare('SELECT item_id FROM menu WHERE substr(item_id, 1, 2) = ?')
    .bind(kode)
    .all();
  let maxSeq = 0;
  for (const row of results) {
    const idVal = String(row.item_id || '');
    if (idVal.length === 13) {
      const seqPart = parseInt(idVal.substring(2, 5), 10);
      if (!isNaN(seqPart) && seqPart > maxSeq) maxSeq = seqPart;
    }
  }
  const seq = String(maxSeq + 1).padStart(3, '0');
  return kode + seq + todayJakartaCompact();
}

// Replikasi addMenuItem() di Code_production.gs. Idempotency via client_item_id —
// kolom ini SUDAH UNIQUE di schema.sql (beda dari GAS yang nambahin kolom "Client Item
// ID" dinamis lewat ensureSheetColumn). Fast path SELECT dulu, tapi guard sebenarnya
// tetap si UNIQUE constraint pas INSERT (pola sama kayak add_order di WP2).
async function addMenuItem(env, p) {
  const kategori = String(p.kategori || '').trim();
  if (!kategori) throw new Error('Kategori kosong.');
  const clientItemId = String(p.client_item_id || '').trim();

  if (clientItemId) {
    const existing = await env.myposdb
      .prepare('SELECT item_id FROM menu WHERE client_item_id = ?')
      .bind(clientItemId)
      .first();
    if (existing) return { added: true, item_id: existing.item_id, duplicate: true };
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const newId = await generateItemId(env, kategori);
    try {
      await env.myposdb
        .prepare(
          `INSERT INTO menu (item_id, kategori, nama, harga, stok_real, mother_stock, unlimited_stock, client_item_id)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .bind(
          newId,
          kategori,
          p.nama,
          Number(p.harga) || 0,
          p.stok_induk || null,
          p.unlimited === true ? 1 : 0,
          clientItemId || null
        )
        .run();
      return { added: true, item_id: newId };
    } catch (err) {
      const msg = String(err.message || '').toUpperCase();
      if (msg.includes('UNIQUE') && msg.includes('ITEM_ID') && !msg.includes('CLIENT_ITEM_ID')) {
        continue; // tabrakan item_id (race generasi ID) — generate ulang, coba lagi
      }
      if (clientItemId && msg.includes('UNIQUE') && msg.includes('CLIENT_ITEM_ID')) {
        const existing = await env.myposdb
          .prepare('SELECT item_id FROM menu WHERE client_item_id = ?')
          .bind(clientItemId)
          .first();
        if (existing) return { added: true, item_id: existing.item_id, duplicate: true };
      }
      throw err;
    }
  }
  throw new Error('Gagal generate Item ID unik setelah beberapa percobaan — coba lagi.');
}

// Replikasi updateMenuItem() di Code_production.gs. Beda dari GAS: gak perlu
// findMenuRowByItemId manual — UPDATE ... WHERE item_id=? langsung, item_id PRIMARY KEY.
async function updateMenuItem(env, p) {
  const itemId = String(p.item_id || '').trim();
  if (!itemId) {
    throw new Error('item_id kosong — menu di HP kamu kayaknya versi lama, refresh dulu (tarik ke bawah / buka ulang tab Menu) baru edit lagi.');
  }
  const result = await env.myposdb
    .prepare('UPDATE menu SET kategori = ?, nama = ?, harga = ?, mother_stock = ?, unlimited_stock = ? WHERE item_id = ?')
    .bind(p.kategori, p.nama, Number(p.harga) || 0, p.stok_induk || null, p.unlimited === true ? 1 : 0, itemId)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    throw new Error('Item ini nggak ketemu lagi di Menu (mungkin baru aja dihapus device lain) — refresh dulu.');
  }
  return { updated: true };
}

// Replikasi deleteMenuRow() di Code_production.gs.
async function deleteMenuRow(env, p) {
  const itemId = String(p.item_id || '').trim();
  if (!itemId) throw new Error('item_id kosong — refresh menu dulu baru hapus lagi.');
  await assertItemNotUsedByResep(env, itemId); // BARU 11 Okt 2026 (U7)
  const result = await env.myposdb.prepare('DELETE FROM menu WHERE item_id = ?').bind(itemId).run();
  if (!result.meta || result.meta.changes === 0) {
    throw new Error('Item ini nggak ketemu lagi (mungkin udah kehapus duluan) — refresh dulu.');
  }
  return { deleted: true };
}

// Replikasi deleteCategory() di Code_production.gs — persis, termasuk TIDAK error kalau
// kategorinya udah kosong/gak ada (behavior lama juga gitu, gak dicek jumlah row kehapus).
async function deleteCategory(env, kategori) {
  await assertCategoryNotUsedByResep(env, kategori); // BARU 11 Okt 2026 (U7)
  await env.myposdb.prepare('DELETE FROM menu WHERE kategori = ?').bind(kategori).run();
  return { deleted: true };
}

// ==== READ PUBLIK: get_menu / get_customers ====

// Replikasi readMenu() di Code_production.gs. Kontrak field HARUS persis sama kayak
// GAS (`stok`, `stok_induk`, `unlimited`, `row`) — frontend index.html udah ditulis
// dari awal dengan nama field ini, bukan `stok_real`/`mother_stock`/`unlimited_stock`
// (nama kolom D1). `row` di GAS itu nomor baris fisik Sheet; di sini cuma index urutan
// hasil query (1-based) — frontend cuma makein sebagai KEY UI lokal (state stok pending),
// gak pernah dikirim balik buat nulis (lihat setMenuStok: cuma baca item_id, `row`
// diabaikan), jadi aman disintesis begini.
// BARU 19 Sep 2026: field `aktif` (boolean) — frontend baca `it.aktif !== false`.
async function getMenu(env) {
  const { results } = await env.myposdb
    .prepare('SELECT item_id, kategori, nama, harga, stok_real, mother_stock, unlimited_stock, aktif FROM menu ORDER BY rowid ASC')
    .all();
  return results.map((row, i) => ({
    row: i + 1,
    item_id: row.item_id,
    kategori: row.kategori,
    nama: row.nama,
    harga: Number(row.harga) || 0,
    stok: Number(row.stok_real) || 0,
    stok_induk: row.mother_stock || '',
    unlimited: row.unlimited_stock === 1,
    aktif: row.aktif !== 0,
  }));
}

// Replikasi readCustomerNames() di Code_production.gs — cuma nama, urut insertion
// order (ORDER BY rowid), BUKAN alfabetis, biar match persis perilaku GAS (baca apa
// adanya dari urutan baris Sheet, gak pernah di-sort).
async function getCustomers(env) {
  const { results } = await env.myposdb.prepare('SELECT nama FROM customer ORDER BY rowid ASC').all();
  return results.map((r) => String(r.nama || '').trim()).filter(Boolean);
}

// ==== MENU PUBLIK: publish_menu / get_published_menu (WP6) ====

// Nilai literal internal (bukan dari input user), aman di-hardcode sama kayak GAS asli.
const GITHUB_OWNER = 'heran-dika';
const GITHUB_REPO = 'shakies';
// (lihat POS Shakies/Logs — cari entri "published-menu.json").
const GITHUB_FILE_PATH = 'published-menu.json';
const GITHUB_BRANCH = 'main';

// Replikasi getPublishedMenu() di Code_production.gs. Beda dari GAS: baca dari tabel D1
// `published_menu` (selalu 1 baris, id=1, di-seed pas schema.sql dijalankan) gantiin
// PropertiesService key tunggal — sama semantiknya (satu snapshot global, bukan per-item).
async function getPublishedMenu(env) {
  const row = await env.myposdb
    .prepare('SELECT categories_json, published_at, published_by FROM published_menu WHERE id = 1')
    .first();
  if (!row) return { categories: [], publishedAt: null, publishedBy: '' };
  return {
    categories: safeParseJson(row.categories_json),
    publishedAt: row.published_at || null,
    publishedBy: row.published_by || '',
  };
}

// UTF-8-safe base64 encode — pengganti Utilities.base64Encode(str, Utilities.Charset.UTF_8)
// di GAS. `btoa()` bawaan Worker cuma ngerti Latin1; nama menu yang kebetulan ada karakter
// non-ASCII (é, emoji, dst) bakal korup kalau di-`btoa()` langsung tanpa lewat TextEncoder.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Replikasi commitPublishedMenuToGitHub() di Code_production.gs — NON-FATAL BY DESIGN,
// SAMA PERSIS: token belum di-set / GitHub API gagal / apa pun TIDAK BOLEH melempar error,
// cuma balikin {committed:false, reason}. publishMenu() di bawah tetap sukses nyimpen ke
// D1 walau bagian ini gagal (persis komentar asli: "kegagalan commit GitHub tidak boleh
// menggagalkan publish_menu", lihat PRD Section 5). Beda dari GAS: token dibaca dari
// env.GITHUB_TOKEN (Worker Secret, di-set manual via `wrangler secret put GITHUB_TOKEN`),
// bukan Script Properties — TIDAK AKAN ADA sampai Dika jalanin perintah itu, jadi sampai
// itu terjadi hasilnya SELALU {committed:false} (bukan bug, ini behavior yang benar/expected).
async function commitPublishedMenuToGitHub(env, snapshot) {
  const token = env.GITHUB_TOKEN;
  if (!token) return { committed: false, reason: 'GITHUB_TOKEN belum di-set (Worker Secret).' };

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'shakies-pos-worker',
  };

  try {
    // 1. Cari SHA file yang ada sekarang — WAJIB buat update, GitHub API nolak overwrite
    //    tanpa SHA yang cocok. 404 artinya file belum pernah ada (publish pertama kali),
    //    lanjut create baru dengan sha tetap null.
    let sha = null;
    const getResp = await fetch(apiUrl + '?ref=' + GITHUB_BRANCH, { headers });
    if (getResp.status === 200) {
      sha = (await getResp.json()).sha;
    } else if (getResp.status !== 404) {
      return { committed: false, reason: 'Gagal ambil file existing: HTTP ' + getResp.status };
    }

    // 2. Commit (create kalau sha null, update kalau ada)
    const body = {
      message: 'Auto-publish menu via POS (' + snapshot.publishedAt + ')',
      content: utf8ToBase64(JSON.stringify(snapshot, null, 2)),
      branch: GITHUB_BRANCH,
    };
    if (sha) body.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body),
    });
    if (putResp.status === 200 || putResp.status === 201) {
      return { committed: true };
    }
    const errText = await putResp.text();
    return { committed: false, reason: 'HTTP ' + putResp.status + ': ' + errText };
  } catch (err) {
    return { committed: false, reason: err.message };
  }
}

// Replikasi publishMenu() di Code_production.gs. UPSERT (INSERT ... ON CONFLICT DO UPDATE)
// dipakai bukan UPDATE polos — jaga-jaga kalau baris seed id=1 dari schema.sql somehow
// belum ada (D1 fresh yang lupa di-seed), publish pertama tetap jalan alih-alih diam-diam
// nulis 0 baris.
async function publishMenu(env, p) {
  const snapshot = {
    categories: (p && p.categories) || [],
    publishedAt: new Date().toISOString(),
    publishedBy: (p && p.device_label) || '',
  };
  await env.myposdb
    .prepare(
      `INSERT INTO published_menu (id, categories_json, published_at, published_by) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET categories_json = excluded.categories_json,
         published_at = excluded.published_at, published_by = excluded.published_by`
    )
    .bind(JSON.stringify(snapshot.categories), snapshot.publishedAt, snapshot.publishedBy)
    .run();
  const githubResult = await commitPublishedMenuToGitHub(env, snapshot); // non-fatal, lihat komentar di atas
  return { published: true, publishedAt: snapshot.publishedAt, publishedBy: snapshot.publishedBy, github: githubResult };
}

// ==== SALDO: topup_saldo / reconcile_saldo (WP4) ====

// Cari 1 customer by nama. Kolom `customer.nama` sudah UNIQUE COLLATE NOCASE di
// schema.sql, jadi perbandingan `=` di sini otomatis case-insensitive lewat kolasi
// kolom — gak perlu LOWER() manual di kedua sisi kayak query lintas tabel (order_pos)
// yang kolomnya nggak dideklarasi COLLATE NOCASE.
async function findCustomerByName(env, nama) {
  return await env.myposdb
    .prepare('SELECT nama, customer_id, saldo_real FROM customer WHERE nama = ?')
    .bind(nama)
    .first();
}

// Replikasi generateCustomerId() di Code_production.gs (pola format C01, C02, ...).
async function generateCustomerId(env) {
  const { results } = await env.myposdb.prepare('SELECT customer_id FROM customer').all();
  let maxSeq = 0;
  for (const row of results) {
    const m = /^C(\d+)$/.exec(String(row.customer_id || ''));
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    }
  }
  return 'C' + String(maxSeq + 1).padStart(2, '0');
}

// Replikasi findTopupByClientId() di Code_production.gs — idempotency check buat
// topupSaldo, dari tabel saldo_log (client_topup_id UNIQUE di schema.sql).
async function findTopupByClientId(env, clientTopupId) {
  if (!clientTopupId) return null;
  return await env.myposdb
    .prepare('SELECT customer_id, nama, saldo_after FROM saldo_log WHERE client_topup_id = ?')
    .bind(clientTopupId)
    .first();
}

// Replikasi logSaldoTopup() di Code_production.gs — non-fatal by design: histori Top Up
// gagal tercatat TIDAK BOLEH gagalin Top Up utama (saldo_real udah kesimpen duluan).
// Beda dari GAS: satu-satunya kegagalan yang realistis di sini adalah tabrakan
// UNIQUE(client_topup_id) di saldo_log, yang harusnya udah kecegah lewat
// findTopupByClientId di atas — try/catch ini defense-in-depth kalau ada race.
async function logSaldoTopup(env, customerId, nama, amount, saldoAfter, clientTopupId) {
  try {
    await env.myposdb
      .prepare(
        'INSERT INTO saldo_log (timestamp, customer_id, nama, amount, saldo_after, client_topup_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(new Date().toISOString(), customerId, nama, amount, saldoAfter, clientTopupId || null)
      .run();
  } catch (err) {
    // non-fatal, lihat komentar di atas.
  }
}

// Replikasi topupSaldo() di Code_production.gs. BEDA PENTING dari GAS: GAS ngelindungin
// seluruh operasi (baca saldo lama -> hitung -> tulis saldo baru) pake LockService, yang
// efeknya blokir SEMUA tulisan lain di sistem selama proses ini jalan (blunt instrument).
// Di sini TIDAK ada lock, tapi juga TIDAK PERLU: increment saldo dilakuin lewat SATU
// statement atomik (`saldo_real = saldo_real + ?` + RETURNING), jadi D1 (single-writer)
// otomatis nyegah 2 top-up nyaris bareng saling timpa (lost update) — race yang justru
// ADA kalau ditulis naif ala GAS (baca nilai, tambah di JS, baru UPDATE nilai hasil).
// Satu-satunya bagian yang masih butuh retry (bukan lock) adalah generateCustomerId:
// 2 TOP UP PERTAMA buat 2 customer BARU yang beda bisa generate ID yang sama kalau
// nyaris bareng — customer_id UNIQUE di schema jadi guard-nya, sama pola generateItemId.
async function topupSaldo(env, p) {
  const nama = String(p.nama || '').trim();
  const amount = Number(p.amount);
  const clientTopupId = String(p.client_topup_id || '').trim();
  if (!nama) throw new Error('Nama customer kosong.');
  if (isNaN(amount) || amount === 0) throw new Error('Nominal top up nggak valid.');

  if (clientTopupId) {
    const existing = await findTopupByClientId(env, clientTopupId);
    if (existing) {
      return { customer_id: existing.customer_id, nama: existing.nama, saldo_real: existing.saldo_after, duplicate: true };
    }
  }

  // Pastiin baris customer ada — no-op kalau udah ada (nama UNIQUE COLLATE NOCASE).
  // FIX 19 Sep 2026: customer_id diisi NULL, BUKAN '' — kolomnya UNIQUE dan '' dianggap
  // nilai yang sama antar baris, jadi customer baru ke-2 dst diam-diam gak pernah kebikin
  // (OR IGNORE nelen error-nya) dan top up-nya gagal "Gagal mencatat customer baru".
  await env.myposdb
    .prepare('INSERT OR IGNORE INTO customer (nama, customer_id, saldo_real) VALUES (?, NULL, 0)')
    .bind(nama)
    .run();

  let customer = await findCustomerByName(env, nama);
  if (!customer) throw new Error('Gagal mencatat customer baru — coba lagi.');

  let customerId = customer.customer_id;
  if (!customerId) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await generateCustomerId(env);
      try {
        const result = await env.myposdb
          .prepare("UPDATE customer SET customer_id = ? WHERE nama = ? AND (customer_id IS NULL OR customer_id = '')")
          .bind(candidate, customer.nama)
          .run();
        if (result.meta && result.meta.changes > 0) {
          customerId = candidate;
        } else {
          // Kolom udah keisi duluan sama request lain di antara SELECT dan UPDATE ini — baca ulang.
          customer = await findCustomerByName(env, nama);
          customerId = customer.customer_id;
        }
        break;
      } catch (err) {
        if (String(err.message || '').toUpperCase().includes('UNIQUE')) continue; // tabrakan customer_id, generate ulang
        throw err;
      }
    }
    if (!customerId) throw new Error('Gagal generate Customer ID unik setelah beberapa percobaan — coba lagi.');
  }

  const updated = await env.myposdb
    .prepare('UPDATE customer SET saldo_real = saldo_real + ? WHERE nama = ? RETURNING saldo_real')
    .bind(amount, customer.nama)
    .first();
  const newSaldo = updated ? Number(updated.saldo_real) : (Number(customer.saldo_real) || 0) + amount;

  await logSaldoTopup(env, customerId, customer.nama, amount, newSaldo, clientTopupId);
  return { customer_id: customerId, nama: customer.nama, saldo_real: newSaldo };
}

// GUARD 21 Sep 2026 (disetujui Dika): tiap UPDATE alokasi dicek ULANG di dalam WHERE (satu statement
// atomik D1), bukan cuma percaya angka yang dibaca di awal. Menutup race reconcile_saldo x
// pay_order_with_saldo (tes lokal: saldo terpakai melebihi saldo di 126/300 percobaan sebelum guard) —
// guard pay_order_with_saldo cuma satu arah, ini melengkapi arah sebaliknya. Tiga syarat di WHERE:
//   1) order masih belum lunas & belum pernah kepake saldo,
//   2) (saldo_real - saldo yang sudah "committed") >= total order SEKARANG — statement di dalam satu
//      batch dieksekusi berurutan, jadi alokasi sebelumnya di batch yang sama ikut terhitung,
//   3) FIFO tetap strict: order sebelumnya di batch ini harus berhasil teralokasi (saldo_used > 0),
//      kalau tidak, order ini ikut ditahan — jangan loncat ke order yang lebih kecil.
// saldo_sisa_after dihitung di SQL dari kondisi yang sama, jadi nilai yang dibekukan selalu konsisten.
// Order yang ditolak guard TIDAK error — tetap Belum Lunas dan dicoba lagi di reconcile berikutnya.
const RECONCILE_GUARDED_UPDATE = `UPDATE order_pos SET saldo_used = ?, saldo_deducted = 0, paid = 1,
    saldo_sisa_after = (SELECT saldo_real FROM customer WHERE customer_id = ?)
      - (SELECT COALESCE(SUM(saldo_used), 0) FROM order_pos WHERE LOWER(customer_name) = LOWER(?) AND saldo_used > 0 AND saldo_deducted = 0) - ?
  WHERE order_id = ? AND paid = 0 AND saldo_used = 0
    AND (SELECT saldo_real FROM customer WHERE customer_id = ?)
      - (SELECT COALESCE(SUM(saldo_used), 0) FROM order_pos WHERE LOWER(customer_name) = LOWER(?) AND saldo_used > 0 AND saldo_deducted = 0) >= ?
    AND (? IS NULL OR (SELECT saldo_used FROM order_pos WHERE order_id = ?) > 0)`;

// Replikasi reconcileCustomerSaldo() di Code_production.gs — FIFO strict by
// delivery_date paling lama duluan, berhenti di order pertama yang gak kecukupan saldo.
// Lihat CATATAN KHUSUS WP4 di kepala file soal race window baca->tulis yang TIDAK
// ditutup di sini (keputusan PRD, bukan kelalaian).
async function reconcileCustomerSaldo(env, customerId) {
  const id = String(customerId || '').trim();
  if (!id) throw new Error('Customer ID kosong.');
  const customer = await env.myposdb
    .prepare('SELECT nama, customer_id, saldo_real FROM customer WHERE customer_id = ?')
    .bind(id)
    .first();
  if (!customer) throw new Error('Customer ID nggak ketemu: ' + id);

  const { results } = await env.myposdb
    .prepare(
      'SELECT order_id, delivery_date, total, paid, saldo_used, saldo_deducted FROM order_pos WHERE LOWER(customer_name) = LOWER(?)'
    )
    .bind(customer.nama)
    .all();

  let committed = 0;
  const candidates = [];
  for (const r of results) {
    const saldoUsed = Number(r.saldo_used) || 0;
    const saldoDeducted = r.saldo_deducted === 1;
    if (saldoUsed > 0 && !saldoDeducted) committed += saldoUsed;
    const paid = r.paid === 1;
    // PENTING (sama seperti GAS): order yang PERNAH kepake saldo (saldo_used>0) gak
    // pernah masuk kandidat lagi, walau sekarang statusnya balik Belum Lunas manual —
    // tanpa pengecualian ini, order itu kehitung dobel (di `committed` dan sebagai
    // kandidat baru) dan nimpa saldo_sisa_after yang udah dibekukan.
    if (!paid && saldoUsed <= 0) {
      candidates.push({ order_id: r.order_id, delivery_date: String(r.delivery_date || ''), total: Number(r.total) || 0 });
    }
  }

  candidates.sort((a, b) => (a.delivery_date < b.delivery_date ? -1 : a.delivery_date > b.delivery_date ? 1 : 0));

  let remaining = (Number(customer.saldo_real) || 0) - committed;
  const allocated = [];
  const statements = [];
  let prevOrderId = null;
  for (const c of candidates) {
    if (c.total <= 0) continue;
    if (remaining < c.total) break; // gak kecukupan -> stop, jangan loncat ke order lain
    remaining -= c.total;
    statements.push(
      env.myposdb.prepare(RECONCILE_GUARDED_UPDATE).bind(
        c.total, id, customer.nama, c.total, // SET: saldo_used, lalu saldo_sisa_after dihitung ulang di SQL
        c.order_id, id, customer.nama, c.total, // WHERE: order masih belum lunas + saldo masih cukup SEKARANG
        prevOrderId, prevOrderId // WHERE: FIFO — order sebelumnya di batch ini HARUS berhasil teralokasi
      )
    );
    prevOrderId = c.order_id;
    allocated.push({ order_id: c.order_id, saldo_used: c.total, saldo_sisa_after: remaining });
  }

  // env.myposdb.batch() = transaksi atomik D1 (all-or-nothing) buat SEMUA UPDATE
  // sekaligus — replikasi requirement "SQL transaction" di PRD Section 6 item 2.
  let allocatedCount = allocated.length;
  if (statements.length) {
    const results = await env.myposdb.batch(statements);
    allocatedCount = results.filter((r) => r.meta && r.meta.changes > 0).length;
    if (allocatedCount !== statements.length) {
      // Ada UPDATE yang ditolak guard (saldo/order berubah dari luar sejak dibaca di atas) — angka JS
      // `remaining` sudah basi, hitung ulang dari DB. Order yang ditolak dicoba lagi di reconcile berikutnya.
      const fresh = await env.myposdb
        .prepare(
          `SELECT c.saldo_real - COALESCE((SELECT SUM(o.saldo_used) FROM order_pos o
             WHERE LOWER(o.customer_name) = LOWER(c.nama) AND o.saldo_used > 0 AND o.saldo_deducted = 0), 0) AS sisa
           FROM customer c WHERE c.customer_id = ?`
        )
        .bind(id)
        .first();
      if (fresh) remaining = Number(fresh.sisa) || 0;
    }
  }

  return { customer_id: id, allocated_count: allocatedCount, saldo_sisa: remaining };
}

// ==== SALDO: pay_order_with_saldo (BARU 19 Sep 2026 — keputusan Shakies) ====

// Lunas manual pas saldo customer KURANG dari total order: saldo yang ada dipakai HABIS
// (saldo_used = min(total, sisa)), order jadi Lunas, sisanya dianggap cash. Setelah ini
// Saldo Sisa customer = 0 jadi order berikutnya otomatis gak pakai saldo (reconcile cuma
// ngalokasiin kalau sisa >= total). Order ditandai persis kayak hasil reconcile
// (saldo_deducted=0 -> nanti dipotong dari Saldo Real sama processExpiredPrepDeductions, dan
// otomatis terkunci dari toggle "Belum Lunas" di frontend karena saldo_used > 0).
// Anti-race TANPA lock: sisa saldo dibaca dulu, lalu UPDATE cuma jalan kalau sisa itu MASIH
// sama persis pas nulis (di-cek ulang di dalam WHERE, satu statement atomik D1). Kalau ada
// reconcile/top-up yang nyelip di antara, changes=0 -> baca ulang & coba lagi (maks 3x).
async function payOrderWithSaldo(env, p) {
  const orderId = String((p && p.order_id) || '').trim();
  if (!orderId) throw new Error('order_id kosong.');

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = await env.myposdb
      .prepare('SELECT order_id, customer_name, total, paid, saldo_used FROM order_pos WHERE order_id = ?')
      .bind(orderId)
      .first();
    if (!order) throw new Error('Order nggak ketemu di daftar aktif (mungkin udah diarsipkan/dihapus) — refresh dulu.');
    if (order.paid === 1) throw new Error('Order ini udah Lunas.');
    if ((Number(order.saldo_used) || 0) > 0) throw new Error('Order ini udah pernah kepake saldo.');

    const customer = await env.myposdb
      .prepare('SELECT nama, customer_id, saldo_real FROM customer WHERE nama = ?')
      .bind(String(order.customer_name || '').trim())
      .first();
    if (!customer || !customer.customer_id) throw new Error('Customer ini belum punya saldo.');

    const committedRow = await env.myposdb
      .prepare(
        'SELECT COALESCE(SUM(saldo_used), 0) AS c FROM order_pos WHERE LOWER(customer_name) = LOWER(?) AND saldo_used > 0 AND saldo_deducted = 0'
      )
      .bind(customer.nama)
      .first();
    const remaining = (Number(customer.saldo_real) || 0) - (Number(committedRow.c) || 0);
    if (remaining <= 0) throw new Error('Saldo customer udah habis — tandain Lunas biasa (cash) aja.');

    const total = Number(order.total) || 0;
    const used = Math.min(total, remaining);
    const sisaAfter = remaining - used;

    const result = await env.myposdb
      .prepare(
        `UPDATE order_pos SET saldo_used = ?, saldo_deducted = 0, saldo_sisa_after = ?, paid = 1, updated_at = ?
         WHERE order_id = ? AND paid = 0 AND saldo_used = 0
           AND (SELECT saldo_real FROM customer WHERE nama = ?)
             - (SELECT COALESCE(SUM(saldo_used), 0) FROM order_pos
                WHERE LOWER(customer_name) = LOWER(?) AND saldo_used > 0 AND saldo_deducted = 0) = ?`
      )
      .bind(used, sisaAfter, new Date().toISOString(), orderId, customer.nama, customer.nama, remaining)
      .run();
    if (result.meta && result.meta.changes > 0) {
      return { order_id: orderId, saldo_used: used, saldo_sisa_after: sisaAfter, cash_part: total - used };
    }
    // saldo/order berubah di antara baca & tulis — ulangi
  }
  throw new Error('Saldo customer baru aja berubah — coba lagi.');
}

// ==== ORDER: add_order ====

// Replikasi attachItemIds() di Code_production.gs — 1x baca seluruh tabel menu jadi
// map nama->item_id, dipasangin ke tiap item pesanan berdasar `name` (bukan item_id
// dari frontend, sama seperti versi GAS: frontend kirim nama, backend yang nempelin ID).
// ==== CUSTOMER LTV & PROFILE (PRD: Customer LTV & Profile, Bagian 5/6/7/8, Fase 2) ====
//
// Kolom total_spend, spend_30d, dst di tabel `customer` STATIS — diisi cuma oleh
// refreshCustomerLtv() lewat cron (lihat runDailyJobs di bawah), BUKAN dihitung live di sini.
// get_customers_ltv & get_customer_profile cuma SELECT, sama semangatnya kayak
// getCustomersWithSaldo/getCustomerSaldoDetail. WAJIB jalanin migrasi-24sep-ltv.sql dulu
// sebelum deploy versi ini.
//
// CATATAN PENTING beda dari draft kontrak PRD Bagian 5: profile di-route pakai `nama`
// (bukan `customer_id`). Alasan: customer_id NULL buat customer yang belum pernah topup
// saldo (lihat ensureCustomerRecorded), jadi gak bisa dipakai sebagai key universal —
// sedangkan customer.nama UNIQUE COLLATE NOCASE dan SELALU ada. Field `customer_id` di
// response get_customers_ltv tetap dikirim (buat ditampilin/dipakai UI kalau perlu),
// tapi cuma `nama` yang dipakai buat manggil get_customer_profile.

// Replikasi getCustomersWithSaldo() tapi nambahin total_spend/total_orders (PRD Bagian 5,
// GET /customers). saldo dibalikin NULL kalau customer_id kosong (belum pernah topup) —
// kontrak Bagian 4.1: frontend nampilin "-", BUKAN Rp0, buat kasus ini.
async function getCustomersLtv(env) {
  const { results } = await env.myposdb
    .prepare('SELECT nama, customer_id, saldo_real, total_spend, total_orders, last_order_date FROM customer ORDER BY rowid ASC')
    .all();
  return results
    .map((c) => ({
      customer_id: c.customer_id || '',
      display_name: c.nama,
      total_spend: Number(c.total_spend) || 0,
      total_orders: Number(c.total_orders) || 0,
      last_order_date: c.last_order_date || null,
      saldo: c.customer_id ? (Number(c.saldo_real) || 0) : null,
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'id'));
}

// Replikasi Profile Screen (PRD Bagian 5, GET /customers/:id/profile — di sini key-nya `nama`,
// lihat catatan di atas). Field turunan (Avg Transaction Value, Lifespan, LTV) SENGAJA gak
// dihitung di sini — itu tugas frontend (PRD Bagian 7), biar formulanya gampang diubah tanpa
// nunggu deploy backend.
async function getCustomerProfile(env, nama) {
  const trimmed = String(nama || '').trim();
  if (!trimmed) throw new Error('Nama customer kosong.');

  const c = await env.myposdb
    .prepare(
      `SELECT nama, total_spend, total_orders, spend_30d, orders_30d, spend_365d, orders_365d, first_order_date, no_wa, alamat
       FROM customer WHERE nama = ?`
    )
    .bind(trimmed)
    .first();
  if (!c) throw new Error('Customer nggak ketemu: ' + trimmed);

  // Menu favorit — agregasi items_json semua order (order_pos + archive), all-time. Pake
  // json_each() di SQLite/D1 (PRD Bagian 7) biar parsing JSON-nya kejadian di database, bukan
  // ditarik mentah-mentah terus di-loop di JS kayak versi sebelumnya — buat customer yang
  // order-nya udah ratusan kali, itu ratusan blob JSON lewat jaringan ke Worker cuma buat
  // di-parse manual di sini. Field item ({name, qty, price}) ngikutin payload asli addOrder
  // (lihat attachItemIds) — BUKAN {name,total} kayak contoh di draft PRD.
  // CATATAN: ini belum pernah dites ke D1 beneran (Open Item #3, PRD Bagian 10) — kalau
  // ternyata json_each() gak kepake normal di D1, fallback-nya versi loop-JS yang lama.
  const { results: itemRows } = await env.myposdb
    .prepare(
      `SELECT json_extract(je.value, '$.name') AS name,
              SUM(json_extract(je.value, '$.qty')) AS qty,
              SUM(json_extract(je.value, '$.qty') * json_extract(je.value, '$.price')) AS total
       FROM (
         SELECT items_json FROM order_pos WHERE LOWER(customer_name) = LOWER(?)
         UNION ALL
         SELECT items_json FROM archive WHERE LOWER(customer_name) = LOWER(?)
       ) o, json_each(o.items_json) je
       WHERE json_extract(je.value, '$.name') IS NOT NULL AND TRIM(json_extract(je.value, '$.name')) != ''
       GROUP BY name
       ORDER BY total DESC`
    )
    .bind(trimmed, trimmed)
    .all();
  const items = itemRows.map((r) => ({
    name: r.name,
    qty: Number(r.qty) || 0,
    total: Number(r.total) || 0,
  }));

  return {
    display_name: c.nama,
    first_order_date: c.first_order_date,
    no_wa: c.no_wa || '',
    alamat: c.alamat || '',
    total_orders: Number(c.total_orders) || 0,
    spend_30d: Number(c.spend_30d) || 0,
    orders_30d: Number(c.orders_30d) || 0,
    spend_365d: Number(c.spend_365d) || 0,
    orders_365d: Number(c.orders_365d) || 0,
    total_spend: Number(c.total_spend) || 0,
    items,
  };
}

// Cron harian (PRD Bagian 8). SATU query agregat (order_pos UNION ALL archive, GROUP BY
// LOWER(customer_name)) buat SEMUA customer sekaligus — bukan loop per customer, pola sama
// kayak computeSaldoPrepMapAll. UPDATE-nya dikirim lewat env.myposdb.batch() (atomik untuk
// bagian tulis), pola sama kayak archiveOldPaidOrders/processExpiredPrepDeductions.
// Cutoff 30/365 hari pakai dateDaysAgoJakartaISO yang sudah ada (WIB, konsisten sama archive).
async function refreshCustomerLtv(env) {
  const cutoff30 = dateDaysAgoJakartaISO(30);
  const cutoff365 = dateDaysAgoJakartaISO(365);

  const { results } = await env.myposdb
    .prepare(
      `SELECT LOWER(customer_name) AS key,
         SUM(total) AS total_spend,
         COUNT(*) AS total_orders,
         SUM(CASE WHEN delivery_date >= ? THEN total ELSE 0 END) AS spend_30d,
         SUM(CASE WHEN delivery_date >= ? THEN 1 ELSE 0 END) AS orders_30d,
         SUM(CASE WHEN delivery_date >= ? THEN total ELSE 0 END) AS spend_365d,
         SUM(CASE WHEN delivery_date >= ? THEN 1 ELSE 0 END) AS orders_365d,
         MIN(delivery_date) AS first_order_date,
         MAX(delivery_date) AS last_order_date
       FROM (
         SELECT customer_name, total, delivery_date FROM order_pos
         UNION ALL
         SELECT customer_name, total, delivery_date FROM archive
       )
       WHERE customer_name IS NOT NULL AND TRIM(customer_name) != ''
       GROUP BY LOWER(customer_name)`
    )
    .bind(cutoff30, cutoff30, cutoff365, cutoff365)
    .all();

  const now = new Date().toISOString();
  const stmts = results.map((r) =>
    env.myposdb
      .prepare(
        `UPDATE customer SET total_spend=?, total_orders=?, spend_30d=?, orders_30d=?,
          spend_365d=?, orders_365d=?, first_order_date=?, last_order_date=?, ltv_refreshed_at=?
         WHERE nama = ?`
      )
      .bind(
        Number(r.total_spend) || 0,
        Number(r.total_orders) || 0,
        Number(r.spend_30d) || 0,
        Number(r.orders_30d) || 0,
        Number(r.spend_365d) || 0,
        Number(r.orders_365d) || 0,
        r.first_order_date,
        r.last_order_date,
        now,
        r.key
      )
  );
  if (stmts.length) await env.myposdb.batch(stmts);
  return { customers_updated: stmts.length, cutoff30, cutoff365 };
}

// Versi scoped-1-customer dari refreshCustomerLtv() di atas — dipanggil abis rename/merge
// (PRD Bagian 6.2 langkah 5: "Trigger recompute cron untuk customer_id_target itu, biar gak
// nunggu jadwal cron berikutnya"), jadi UI Profile langsung akurat abis Edit Nama/Merge,
// gak nunggu cron 00:05 WIB nanti malam.
async function refreshOneCustomerLtv(env, nama) {
  const cutoff30 = dateDaysAgoJakartaISO(30);
  const cutoff365 = dateDaysAgoJakartaISO(365);
  const r = await env.myposdb
    .prepare(
      `SELECT
         SUM(total) AS total_spend,
         COUNT(*) AS total_orders,
         SUM(CASE WHEN delivery_date >= ? THEN total ELSE 0 END) AS spend_30d,
         SUM(CASE WHEN delivery_date >= ? THEN 1 ELSE 0 END) AS orders_30d,
         SUM(CASE WHEN delivery_date >= ? THEN total ELSE 0 END) AS spend_365d,
         SUM(CASE WHEN delivery_date >= ? THEN 1 ELSE 0 END) AS orders_365d,
         MIN(delivery_date) AS first_order_date,
         MAX(delivery_date) AS last_order_date
       FROM (
         SELECT customer_name, total, delivery_date FROM order_pos
         UNION ALL
         SELECT customer_name, total, delivery_date FROM archive
       )
       WHERE LOWER(customer_name) = LOWER(?)`
    )
    .bind(cutoff30, cutoff30, cutoff365, cutoff365, nama)
    .first();
  await env.myposdb
    .prepare(
      `UPDATE customer SET total_spend=?, total_orders=?, spend_30d=?, orders_30d=?,
        spend_365d=?, orders_365d=?, first_order_date=?, last_order_date=?, ltv_refreshed_at=?
       WHERE nama = ?`
    )
    .bind(
      Number(r.total_spend) || 0,
      Number(r.total_orders) || 0,
      Number(r.spend_30d) || 0,
      Number(r.orders_30d) || 0,
      Number(r.spend_365d) || 0,
      Number(r.orders_365d) || 0,
      r.first_order_date,
      r.last_order_date,
      new Date().toISOString(),
      nama
    )
    .run();
}

// ==== CUSTOMER RENAME & MERGE (PRD Bagian 4.2/4.3, 6.2) ====
// Edit-nama dan Merge itu SATU operasi yang sama di level data: "nama lama" pindah jadi
// "nama baru", ngikut di order_pos + archive + saldo_log (Fase 2 semula cuma nyebut
// order_pos+archive; saldo_log gue tambahin sendiri karena itu ledger Top Up asli, kalau
// gak ikut disinkronin nama-nya bakal nyasar nunjuk ke nama yang udah gak ada).
// Edit-nama = kasus di mana "nama baru" belum pernah ada. Merge = kasus di mana dia udah ada.
//
// KEPUTUSAN buat Open Item #1 (PRD Bagian 10, sebelumnya belum diputusin): kalau KEDUA nama
// masih punya SISA SALDO (bukan cuma "pernah topup" — customer_id doang gak masalah kalau
// saldo-nya udah 0), operasi DIBLOKIR — dilempar Error, gak digabung otomatis. Ini keputusan
// finansial (nyatuin 2 saldo yang masih ada isinya diam-diam), bukan keputusan UI — kalau
// kejadian, harus diputusin manual dulu (nanti bisa ditambah endpoint transfer saldo eksplisit
// kalau perlu, tapi itu di luar PRD ini). Kalau salah satu 0, otomatis lanjut, yang nonzero
// yang dipertahankan.
async function mergeOrRenameCustomer(env, oldNameRaw, newNameRaw, actorEmail) {
  const oldName = String(oldNameRaw || '').trim();
  const newName = String(newNameRaw || '').trim();
  if (!oldName || !newName) throw new Error('Nama lama/baru gak boleh kosong.');
  if (oldName.toLowerCase() === newName.toLowerCase()) {
    // 14 Okt 2026 (W1): ganti KAPITAL saja ("budi santoso" -> "Budi Santoso") = rename ejaan di semua tabel, bukan tabrakan/merge
    // dengan diri sendiri dan bukan no-op. Persis sama (termasuk kapital) tetap ditolak.
    const same = await findCustomerByName(env, oldName);
    if (!same) throw new Error('Customer "' + oldName + '" nggak ketemu.');
    if (same.nama === newName) throw new Error('Nama baru sama kayak nama lama.');
    const cs = [
      env.myposdb.prepare('UPDATE customer SET nama = ? WHERE nama = ?').bind(newName, same.nama),
      env.myposdb.prepare('UPDATE order_pos SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newName, same.nama),
      env.myposdb.prepare('UPDATE archive SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newName, same.nama),
      env.myposdb.prepare('UPDATE customer_alias SET target_nama = ? WHERE LOWER(target_nama) = LOWER(?)').bind(newName, same.nama),
    ];
    if (same.customer_id) cs.push(env.myposdb.prepare('UPDATE saldo_log SET nama = ? WHERE customer_id = ?').bind(newName, same.customer_id));
    await env.myposdb.batch(cs);
    await refreshOneCustomerLtv(env, newName);
    return { mode: 'renamed', display_name: newName };
  }

  const oldC = await findCustomerByName(env, oldName);
  if (!oldC) throw new Error('Customer "' + oldName + '" nggak ketemu.');
  const newC = await findCustomerByName(env, newName);

  const now = new Date().toISOString();
  const stmts = [];

  if (!newC) {
    // Rename murni — nama baru belum pernah ada sebagai customer.
    stmts.push(env.myposdb.prepare('UPDATE customer SET nama = ? WHERE nama = ?').bind(newName, oldC.nama));
    stmts.push(
      env.myposdb.prepare('UPDATE order_pos SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newName, oldC.nama)
    );
    stmts.push(
      env.myposdb.prepare('UPDATE archive SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newName, oldC.nama)
    );
    if (oldC.customer_id) {
      stmts.push(env.myposdb.prepare('UPDATE saldo_log SET nama = ? WHERE customer_id = ?').bind(newName, oldC.customer_id));
    }
    stmts.push(
      env.myposdb
        .prepare('INSERT INTO customer_alias (target_nama, old_name, merged_at, merged_by) VALUES (?, ?, ?, ?)')
        .bind(newName, oldC.nama, now, actorEmail || null)
    );
    await env.myposdb.batch(stmts);
    await refreshOneCustomerLtv(env, newName);
    return { mode: 'renamed', display_name: newName };
  }

  // Merge beneran — newName udah jadi customer sendiri. Yang bahaya BUKAN "keduanya pernah
  // topup" (customer_id doang), tapi "keduanya MASIH punya sisa saldo" — kalau salah satu
  // udah 0 (abis dipake / emang gak pernah nyisa), gak ada duit yang bisa ke-drop diam-diam,
  // jadi aman digabung otomatis (yang menang = yang saldo-nya nonzero).
  const oldSaldo = Number(oldC.saldo_real) || 0;
  const newSaldo = Number(newC.saldo_real) || 0;
  if (oldC.customer_id && newC.customer_id && oldSaldo !== 0 && newSaldo !== 0) {
    throw new Error(
      'Gak bisa digabung otomatis: "' + oldC.nama + '" (sisa saldo ' + oldSaldo + ') dan "' + newC.nama +
        '" (sisa saldo ' + newSaldo + ') dua-duanya masih punya saldo Top Up. Perlu diputusin manual dulu.'
    );
  }
  const oldContact = await env.myposdb.prepare('SELECT no_wa, alamat FROM customer WHERE nama = ?').bind(oldC.nama).first();
  let survivingCustomerId, survivingSaldo;
  if (oldC.customer_id && newC.customer_id) {
    // Dua-duanya punya customer_id tapi salah satu udah 0 — yang nonzero yang dipertahankan.
    if (newSaldo !== 0) { survivingCustomerId = newC.customer_id; survivingSaldo = newSaldo; }
    else { survivingCustomerId = oldC.customer_id; survivingSaldo = oldSaldo; }
  } else {
    survivingCustomerId = oldC.customer_id || newC.customer_id || null;
    survivingSaldo = oldC.customer_id ? oldSaldo : newSaldo;
  }

  stmts.push(
    env.myposdb
      .prepare('UPDATE customer SET customer_id = ?, saldo_real = ? WHERE nama = ?')
      .bind(survivingCustomerId, survivingSaldo, newC.nama)
  );
  // 18 Okt 2026: kontak (WA/alamat) customer sumber dibawa kalau punya target masih kosong
  stmts.push(
    env.myposdb
      .prepare("UPDATE customer SET no_wa = COALESCE(NULLIF(no_wa, ''), ?), alamat = COALESCE(NULLIF(alamat, ''), ?) WHERE nama = ?")
      .bind((oldContact && oldContact.no_wa) || null, (oldContact && oldContact.alamat) || null, newC.nama)
  );
  stmts.push(env.myposdb.prepare('DELETE FROM customer WHERE nama = ?').bind(oldC.nama));
  stmts.push(
    env.myposdb.prepare('UPDATE order_pos SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newC.nama, oldC.nama)
  );
  stmts.push(
    env.myposdb.prepare('UPDATE archive SET customer_name = ? WHERE LOWER(customer_name) = LOWER(?)').bind(newC.nama, oldC.nama)
  );
  if (survivingCustomerId) {
    stmts.push(env.myposdb.prepare('UPDATE saldo_log SET nama = ? WHERE customer_id = ?').bind(newC.nama, survivingCustomerId));
  }
  stmts.push(
    env.myposdb
      .prepare('INSERT INTO customer_alias (target_nama, old_name, merged_at, merged_by) VALUES (?, ?, ?, ?)')
      .bind(newC.nama, oldC.nama, now, actorEmail || null)
  );
  await env.myposdb.batch(stmts);
  await refreshOneCustomerLtv(env, newC.nama);
  return { mode: 'merged', display_name: newC.nama };
}

// ==== KONTAK CUSTOMER (18 Okt 2026): no WA + alamat di profil. WAJIB migrasi-18okt-kontak-customer.sql dulu. ====
// no_wa disimpan sudah dinormalisasi (62xxxx, digit saja) supaya langsung jadi wa.me/<no_wa>.
function normalizeWa(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d;
}
async function updateCustomerContact(env, p) {
  const nama = String((p && p.nama) || '').trim();
  if (!nama) throw new Error('Nama customer kosong.');
  const c = await findCustomerByName(env, nama);
  if (!c) throw new Error('Customer "' + nama + '" nggak ketemu.');
  const sets = [];
  const binds = [];
  if ('no_wa' in p) {
    const wa = normalizeWa(p.no_wa);
    if (wa && !/^\d{9,15}$/.test(wa)) throw new Error('Nomor WA nggak valid.');
    sets.push('no_wa = ?');
    binds.push(wa || null);
  }
  if ('alamat' in p) {
    const a = String(p.alamat || '').trim().slice(0, 500);
    sets.push('alamat = ?');
    binds.push(a || null);
  }
  if (!sets.length) throw new Error('Nggak ada yang diubah.');
  await env.myposdb.prepare('UPDATE customer SET ' + sets.join(', ') + ' WHERE nama = ?').bind(...binds, c.nama).run();
  const row = await env.myposdb.prepare('SELECT no_wa, alamat FROM customer WHERE nama = ?').bind(c.nama).first();
  return { no_wa: (row && row.no_wa) || '', alamat: (row && row.alamat) || '' };
}

async function attachItemIds(env, items) {
  if (!items || !items.length) return items || [];
  const { results } = await env.myposdb.prepare('SELECT nama, item_id FROM menu').all();
  const byName = {};
  for (const row of results) {
    const nama = String(row.nama || '').trim();
    if (nama) byName[nama] = row.item_id;
  }
  return items.map((it) => {
    const nama = String(it.name || '').trim();
    const itemId = byName[nama];
    return itemId ? Object.assign({}, it, { item_id: itemId }) : it;
  });
}

// Replikasi ensureCustomerRecorded() di Code_production.gs. Di GAS ini butuh
// baca-semua-lalu-cek-manual (case-insensitive) sebelum appendRow. Di D1, kolom
// `customer.nama` sudah UNIQUE COLLATE NOCASE (lihat schema.sql) — jadi pengecekan
// case-insensitive-nya didapat gratis dari constraint, tinggal INSERT OR IGNORE.
// FIX 19 Sep 2026: customer_id NULL (bukan ''), lihat komentar di topupSaldo — dengan ''
// hanya 1 customer tanpa Customer ID yang bisa ada; customer berikutnya ke-IGNORE diam-diam
// dan gak pernah muncul di autocomplete.
async function ensureCustomerRecorded(env, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  await env.myposdb
    .prepare('INSERT OR IGNORE INTO customer (nama, customer_id, saldo_real) VALUES (?, NULL, 0)')
    .bind(trimmed)
    .run();
}

// Replikasi addOrder() di Code_production.gs. Idempotency via client_order_id:
// - Fast path: SELECT dulu, kalau udah ada balikin order_id lama (duplicate:true).
// - Guard sebenarnya: UNIQUE constraint di kolom client_order_id. Kalau 2 request
//   nyaris bareng lolos fast-path bersamaan (belum ada yang sempet INSERT pas
//   keduanya SELECT), salah satu INSERT-nya bakal ditolak D1 — di-catch di bawah,
//   balikin order_id yang menang, BUKAN dilempar sebagai error ke frontend.
async function addOrder(env, p) {
  const clientOrderId = String(p.client_order_id || '').trim();

  if (clientOrderId) {
    const existing = await env.myposdb
      .prepare('SELECT order_id FROM order_pos WHERE client_order_id = ?')
      .bind(clientOrderId)
      .first();
    if (existing) return { order_id: existing.order_id, duplicate: true };
  }

  const itemsWithId = await attachItemIds(env, p.items);
  const id = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const now = new Date().toISOString();

  try {
    await env.myposdb
      .prepare(
        `INSERT INTO order_pos (
          order_id, created_at, delivery_date, customer_name, items_summary, items_json,
          total, note, prepared, device_label, updated_at, shipping_fee, paid, real_deducted,
          client_order_id, saldo_used, saldo_deducted, saldo_sisa_after, discount_type, discount_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, 0, 0, NULL, ?, ?)`
      )
      .bind(
        id,
        now,
        p.delivery_date,
        p.customer_name,
        p.items_summary,
        JSON.stringify(itemsWithId),
        p.total || 0,
        p.note || '',
        p.device_label || '',
        now,
        p.shipping_fee || 0,
        clientOrderId || null,
        p.discount_type || '',
        Number(p.discount_value) || 0
      )
      .run();
  } catch (err) {
    if (clientOrderId && String(err.message || '').toUpperCase().includes('UNIQUE')) {
      const existing = await env.myposdb
        .prepare('SELECT order_id FROM order_pos WHERE client_order_id = ?')
        .bind(clientOrderId)
        .first();
      if (existing) return { order_id: existing.order_id, duplicate: true };
    }
    throw err;
  }

  await ensureCustomerRecorded(env, p.customer_name);
  return { order_id: id };
}

// ==== ORDER: update_order / delete_order (WP3) ====

// Replikasi locateOrderRow() di Code_production.gs — cari di order_pos dulu (order aktif
// jauh lebih sering diakses), baru archive kalau gak ketemu. `table` dipakai UPDATE/DELETE
// selanjutnya cuma dari 2 nilai literal internal ('order_pos'/'archive'), gak pernah dari
// input user — aman diinterpolasi ke SQL tanpa parameter binding.
async function locateOrderRow(env, orderId) {
  const active = await env.myposdb.prepare('SELECT * FROM order_pos WHERE order_id = ?').bind(orderId).first();
  if (active) return { table: 'order_pos', row: active };
  const archived = await env.myposdb.prepare('SELECT * FROM archive WHERE order_id = ?').bind(orderId).first();
  if (archived) return { table: 'archive', row: archived };
  return null;
}

// Replikasi updateOrder() di Code_production.gs, termasuk 3 skenario aslinya:
// 1) Order di order_pos (aktif) -> update in place.
// 2) Order di archive, TETAP paid=true -> update in place (tetap di archive).
// 3) Order di archive, JADI paid=false -> "unarchive": INSERT balik ke order_pos bawa
//    field non-editable dari row lama (created_at, real_deducted, client_order_id,
//    saldo_*), lalu DELETE dari archive. Field editable (delivery_date, items, dst)
//    pakai payload baru — sama persis logic GAS.
async function updateOrder(env, p) {
  const located = await locateOrderRow(env, p.order_id);
  if (!located) throw new Error('Order ID nggak ketemu: ' + p.order_id);

  const itemsWithId = await attachItemIds(env, p.items);
  const now = new Date().toISOString();
  const newPaid = p.paid === true ? 1 : 0;
  const preparedVal = p.prepared === true ? 1 : 0;
  const discountType = p.discount_type || '';
  const discountValue = Number(p.discount_value) || 0;

  const editableSet = `delivery_date=?, customer_name=?, items_summary=?, items_json=?,
    total=?, note=?, prepared=?, device_label=?, updated_at=?, shipping_fee=?, paid=?,
    discount_type=?, discount_value=?`;
  const editableBind = [
    p.delivery_date, p.customer_name, p.items_summary, JSON.stringify(itemsWithId),
    p.total || 0, p.note || '', preparedVal, p.device_label || '', now, p.shipping_fee || 0,
    newPaid, discountType, discountValue,
  ];

  if (located.table === 'order_pos') {
    await env.myposdb
      .prepare(`UPDATE order_pos SET ${editableSet} WHERE order_id=?`)
      .bind(...editableBind, p.order_id)
      .run();
    return { updated: true };
  }

  if (newPaid) {
    await env.myposdb
      .prepare(`UPDATE archive SET ${editableSet} WHERE order_id=?`)
      .bind(...editableBind, p.order_id)
      .run();
    return { updated: true };
  }

  const r = located.row;
  await env.myposdb
    .prepare(
      `INSERT INTO order_pos (
        order_id, created_at, delivery_date, customer_name, items_summary, items_json,
        total, note, prepared, device_label, updated_at, shipping_fee, paid, real_deducted,
        client_order_id, saldo_used, saldo_deducted, saldo_sisa_after, discount_type, discount_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      r.order_id, r.created_at, p.delivery_date, p.customer_name, p.items_summary,
      JSON.stringify(itemsWithId), p.total || 0, p.note || '', preparedVal, p.device_label || '',
      now, p.shipping_fee || 0, newPaid, r.real_deducted,
      r.client_order_id, r.saldo_used, r.saldo_deducted, r.saldo_sisa_after,
      discountType, discountValue
    )
    .run();
  await env.myposdb.prepare('DELETE FROM archive WHERE order_id = ?').bind(p.order_id).run();
  return { updated: true, unarchived: true };
}

// ==== ORDER: set_order_flag (BARU 29 Sep 2026 — fix race prepared vs paid) ====
//
// Sebelumnya togglePrepared()/togglePaid() di frontend sama-sama manggil update_order,
// yang nulis ULANG SEMUA kolom (full-row overwrite) — termasuk field yang LAGI TIDAK
// diubah, dari snapshot memory lokal (order.prepared / order.paid saat itu). Kalau dua
// toggle dipencet berdekatan (skenario nyata: tandain order siap DAN lunas sekaligus di
// kartu yang sama), dua request POST race, dan yang NYAMPE ke server BELAKANGAN (walau
// dipencet duluan — timing jaringan, bukan urutan tap) nimpa balik field yang SATUNYA ke
// nilai lama/stale. Ini kenapa gejalanya "kadang doang", bukan konsisten.
//
// Fix: UPDATE kolom TUNGGAL doang (prepared ATAU paid, whitelist ketat — nggak pernah dari
// nama kolom bebas), gak pernah nyentuh kolom lain sama sekali. Dua toggle sekarang gak
// akan bisa saling timpa lagi walau nyaris bareng, karena masing-masing cuma megang 1 kolom.
//
// paid=false pada order yang ADA DI ARCHIVE tetap butuh "unarchive" (pindah balik ke
// order_pos) — sama seperti updateOrder() — supaya order itu balik muncul di Prep/tab
// aktif. Field lain dibawa APA ADANYA dari row lama (bukan dari payload baru), karena
// action ini BUKAN buat edit form, cuma toggle 1 status.
async function setOrderFlag(env, p) {
  const orderId = String((p && p.order_id) || '').trim();
  const field = String((p && p.field) || '').trim();
  if (!orderId) throw new Error('order_id kosong.');
  if (field !== 'prepared' && field !== 'paid') throw new Error('Field nggak valid: ' + field);
  const value = p.value === true ? 1 : 0;

  const located = await locateOrderRow(env, orderId);
  if (!located) throw new Error('Order ID nggak ketemu: ' + orderId);
  const now = new Date().toISOString();

  if (located.table === 'order_pos') {
    const result = await env.myposdb
      .prepare(`UPDATE order_pos SET ${field} = ?, updated_at = ? WHERE order_id = ?`)
      .bind(value, now, orderId)
      .run();
    if (!result.meta || result.meta.changes === 0) {
      throw new Error('Order ini nggak ketemu lagi (mungkin baru aja dihapus device lain) — refresh dulu.');
    }
    return { updated: true };
  }

  // located.table === 'archive'. `prepared` di order arsip gak relevan buat Prep tab (yang
  // cuma baca order_pos), tapi tetap ditulis in-place kalau somehow dipanggil — gak perlu
  // unarchive (cuma paid=false yang butuh itu, di bawah).
  if (field === 'prepared') {
    await env.myposdb
      .prepare('UPDATE archive SET prepared = ?, updated_at = ? WHERE order_id = ?')
      .bind(value, now, orderId)
      .run();
    return { updated: true };
  }

  if (value === 1) {
    await env.myposdb
      .prepare('UPDATE archive SET paid = 1, updated_at = ? WHERE order_id = ?')
      .bind(now, orderId)
      .run();
    return { updated: true };
  }

  // field === 'paid', value === 0, lokasinya di archive -> unarchive (pola sama persis
  // kayak cabang unarchive di updateOrder(), field lain dibawa apa adanya dari row lama).
  const r = located.row;
  await env.myposdb
    .prepare(
      `INSERT INTO order_pos (
        order_id, created_at, delivery_date, customer_name, items_summary, items_json,
        total, note, prepared, device_label, updated_at, shipping_fee, paid, real_deducted,
        client_order_id, saldo_used, saldo_deducted, saldo_sisa_after, discount_type, discount_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      r.order_id, r.created_at, r.delivery_date, r.customer_name, r.items_summary,
      r.items_json, r.total, r.note, r.prepared, r.device_label,
      now, r.shipping_fee, r.real_deducted,
      r.client_order_id, r.saldo_used, r.saldo_deducted, r.saldo_sisa_after,
      r.discount_type, r.discount_value
    )
    .run();
  await env.myposdb.prepare('DELETE FROM archive WHERE order_id = ?').bind(orderId).run();
  return { updated: true, unarchived: true };
}

// Replikasi deleteOrder() di Code_production.gs — cari dulu di order_pos, baru archive.
async function deleteOrder(env, orderId) {
  const located = await locateOrderRow(env, orderId);
  if (!located) throw new Error('Order ID nggak ketemu: ' + orderId);
  const table = located.table === 'archive' ? 'archive' : 'order_pos';
  await env.myposdb.prepare(`DELETE FROM ${table} WHERE order_id = ?`).bind(orderId).run();
  return { deleted: true };
}

// ==== READ GATED: get_orders / get_orders_search / get_customers_saldo /
// get_customer_saldo_detail (WP5) ====

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return [];
  }
}

// Bentuk objek order buat frontend, dipakai bareng getOrders & searchOrders — kontrak
// field HARUS persis sama kayak parseOrderRow() di Code_production.gs.
function mapOrderRow(r) {
  return {
    order_id: r.order_id,
    created_at: r.created_at,
    delivery_date: r.delivery_date,
    customer_name: r.customer_name,
    items_summary: r.items_summary,
    items: safeParseJson(r.items_json),
    total: Number(r.total) || 0,
    note: r.note || '',
    prepared: r.prepared === 1,
    device_label: r.device_label || '',
    updated_at: r.updated_at,
    shipping_fee: Number(r.shipping_fee) || 0,
    paid: r.paid === 1,
    real_deducted: r.real_deducted === 1,
    client_order_id: r.client_order_id || '',
    saldo_used: Number(r.saldo_used) || 0,
    saldo_deducted: r.saldo_deducted === 1,
    saldo_sisa_after: (r.saldo_sisa_after === null || r.saldo_sisa_after === undefined) ? null : Number(r.saldo_sisa_after),
    discount_type: r.discount_type || '',
    discount_value: Number(r.discount_value) || 0,
  };
}

// Replikasi readOrders() di Code_production.gs — CUMA sheet/tabel aktif (order_pos),
// archive sengaja gak diikutin (sama seperti GAS: tab Prep/Besok cuma butuh order aktif).
async function getOrders(env) {
  const { results } = await env.myposdb.prepare('SELECT * FROM order_pos ORDER BY rowid ASC').all();
  const orders = results.map(mapOrderRow);
  // 18 Okt 2026: kontak customer (WA/alamat) buat ikon di card Prep. Query terpisah + try/catch:
  // kalau migrasi kontak belum jalan / query gagal, daftar order tetap tampil tanpa ikon.
  try {
    const { results: kontak } = await env.myposdb
      .prepare('SELECT nama, no_wa, alamat FROM customer WHERE no_wa IS NOT NULL OR alamat IS NOT NULL')
      .all();
    if (kontak.length) {
      const m = {};
      for (const k of kontak) m[String(k.nama || '').trim().toLowerCase()] = k;
      for (const o of orders) {
        const k = m[String(o.customer_name || '').trim().toLowerCase()];
        if (k) { o.kontak_wa = k.no_wa || ''; o.kontak_alamat = k.alamat || ''; }
      }
    }
  } catch (e) { console.error('kontak order GAGAL:', e && e.message); }
  return orders;
}

// Escape wildcard LIKE ('%', '_', '\') di query nama customer, biar behavior-nya sama
// kayak GAS (String.includes() polos, treat semua karakter sebagai literal) — bukan
// wildcard SQL beneran, biar customer yang nama-nya kebetulan ada "%" gak bikin match aneh.
function likeEscape(str) {
  return str.replace(/[%_\\]/g, (ch) => '\\' + ch);
}

// Replikasi searchOrders() di Code_production.gs — gabungan order_pos + archive,
// filter nama (substring, case-insensitive) DAN rentang tanggal (semua kondisi yang
// diisi harus cocok sekaligus, sama seperti chain filter() di GAS).
async function searchOrders(env, params) {
  const nameQuery = String((params && params.name) || '').trim();
  const dateFrom = String((params && params.date_from) || '').trim();
  const dateTo = String((params && params.date_to) || '').trim();

  const conditions = [];
  const binds = [];
  if (nameQuery) {
    conditions.push("LOWER(customer_name) LIKE ? ESCAPE '\\'");
    binds.push('%' + likeEscape(nameQuery.toLowerCase()) + '%');
  }
  if (dateFrom) {
    conditions.push('delivery_date >= ?');
    binds.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('delivery_date <= ?');
    binds.push(dateTo);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const active = await env.myposdb.prepare(`SELECT * FROM order_pos ${where}`).bind(...binds).all();
  const archived = await env.myposdb.prepare(`SELECT * FROM archive ${where}`).bind(...binds).all();
  return active.results.map(mapOrderRow).concat(archived.results.map(mapOrderRow));
}

// Replikasi computeSaldoPrepMapAll() di Code_production.gs — 1x SELECT buat SEMUA
// customer sekaligus (bukan per-customer), Saldo Prep = SUM(saldo_used) yang
// saldo_used>0 & saldo_deducted=FALSE, dari order_pos AKTIF doang (bukan archive).
async function computeSaldoPrepMapAll(env) {
  const { results } = await env.myposdb
    .prepare('SELECT customer_name, saldo_used FROM order_pos WHERE saldo_used > 0 AND saldo_deducted = 0')
    .all();
  const map = {};
  for (const r of results) {
    const key = String(r.customer_name || '').trim().toLowerCase();
    map[key] = (map[key] || 0) + (Number(r.saldo_used) || 0);
  }
  return map;
}

// Replikasi getCustomersWithSaldo() di Code_production.gs — list semua customer +
// Saldo Awal/Jajan/Sisa, urut abjad (locale 'id', sama kayak GAS).
async function getCustomersWithSaldo(env) {
  const { results } = await env.myposdb
    .prepare('SELECT nama, customer_id, saldo_real FROM customer ORDER BY rowid ASC')
    .all();
  const prepMap = await computeSaldoPrepMapAll(env);
  return results
    .map((c) => {
      const prep = c.customer_id ? (prepMap[String(c.nama).trim().toLowerCase()] || 0) : 0;
      const saldoReal = Number(c.saldo_real) || 0;
      return {
        nama: c.nama,
        customer_id: c.customer_id || '',
        saldo_real: saldoReal,
        saldo_prep: prep,
        saldo_sisa: saldoReal - prep,
      };
    })
    .sort((a, b) => a.nama.localeCompare(b.nama, 'id'));
}

// Replikasi getCustomerSaldoDetail() di Code_production.gs — Saldo Awal/Jajan/Sisa +
// histori gabungan (spend dari order_pos & archive, topup dari saldo_log), diurut
// pakai sort_key (presisi detik buat topup, "00:00:00" buat spend — sama kayak GAS).
async function getCustomerSaldoDetail(env, customerId) {
  const id = String(customerId || '').trim();
  if (!id) throw new Error('Customer ID kosong.');
  const customer = await env.myposdb
    .prepare('SELECT nama, customer_id, saldo_real FROM customer WHERE customer_id = ?')
    .bind(id)
    .first();
  if (!customer) throw new Error('Customer ID nggak ketemu: ' + id);
  const namaLower = String(customer.nama).trim().toLowerCase();

  const history = [];
  let prep = 0;

  for (const table of ['order_pos', 'archive']) {
    const { results } = await env.myposdb
      .prepare(
        `SELECT order_id, delivery_date, total, paid, saldo_used, saldo_deducted, saldo_sisa_after
         FROM ${table} WHERE LOWER(customer_name) = ?`
      )
      .bind(namaLower)
      .all();
    for (const r of results) {
      const saldoUsed = Number(r.saldo_used) || 0;
      if (saldoUsed <= 0) continue;
      const saldoDeducted = r.saldo_deducted === 1;
      if (table === 'order_pos' && !saldoDeducted) prep += saldoUsed;
      history.push({
        type: 'spend',
        date: r.delivery_date,
        sort_key: r.delivery_date + ' 00:00:00',
        order_id: r.order_id,
        total: Number(r.total) || 0,
        saldo_used: saldoUsed,
        saldo_sisa_after: (r.saldo_sisa_after === null || r.saldo_sisa_after === undefined) ? null : Number(r.saldo_sisa_after),
        paid: r.paid === 1,
      });
    }
  }

  const { results: logResults } = await env.myposdb
    .prepare('SELECT timestamp, amount, saldo_after FROM saldo_log WHERE customer_id = ?')
    .bind(customer.customer_id)
    .all();
  for (const r of logResults) {
    const tsStr = String(r.timestamp || '');
    history.push({
      type: 'topup',
      date: tsStr.slice(0, 10),
      sort_key: tsStr,
      amount: Number(r.amount) || 0,
      saldo_after: Number(r.saldo_after) || 0,
    });
  }

  history.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));

  const saldoReal = Number(customer.saldo_real) || 0;
  return {
    nama: customer.nama,
    customer_id: customer.customer_id,
    saldo_real: saldoReal,
    saldo_prep: prep,
    saldo_sisa: saldoReal - prep,
    history,
  };
}

// ==== SCHEDULED: processExpiredPrepDeductions (WP7 — bagian inti, BARU 19 Sep 2026) ====

// Replikasi processExpiredPrepDeductions() di Code_production.gs — trigger harian yang
// "memotong fisik" order yang delivery_date-nya sudah lewat (< hari ini WIB):
//   1) Stok Real menu dikurangi qty item (clamp minimal 0 — FIX 21 Agustus di GAS),
//      ngikutin mother_stock (kalau item child, yang dipotong stok induknya), item
//      unlimited dilewati. Order ditandai real_deducted=1.
//   2) Saldo Real customer dikurangi saldo_used order itu, order ditandai saldo_deducted=1.
//      TANPA langkah ini Saldo Awal gak pernah berkurang & Saldo Jajan numpuk selamanya.
// Beda dari GAS (lebih ketat, bukan perubahan perilaku): SEMUA UPDATE (potongan + penanda)
// dikirim dalam SATU env.myposdb.batch() (transaksi atomik) — gak mungkin stok kepotong tapi
// order gak ke-mark (yang bikin potong dobel di run berikutnya). Lookup item pakai item_id
// dulu (kalau ada di items_json), fallback nama — GAS cuma by nama; item_id lebih tahan rename.
// Order archive gak disentuh (sama kayak GAS: cuma sheet aktif).
async function processExpiredPrepDeductions(env) {
  const today = todayJakartaISO();
  const { results: orders } = await env.myposdb
    .prepare(
      `SELECT order_id, customer_name, items_json, real_deducted, saldo_used, saldo_deducted
       FROM order_pos
       WHERE delivery_date < ? AND (real_deducted = 0 OR (saldo_used > 0 AND saldo_deducted = 0))`
    )
    .bind(today)
    .all();

  if (!orders.length) return { processed_orders: 0, deductions: {}, saldo_deductions: {} };

  const { results: menuRows } = await env.myposdb
    .prepare('SELECT item_id, nama, mother_stock, unlimited_stock FROM menu')
    .all();
  const byId = {};
  const byName = {};
  for (const m of menuRows) {
    byId[m.item_id] = m;
    const nama = String(m.nama || '').trim();
    if (nama) byName[nama] = m;
  }

  const deductions = {}; // stockKey (item_id yang stoknya dipotong) -> total qty
  const stockOrderIds = [];
  const saldoDeductions = {}; // nama customer (lowercase) -> total saldo_used
  const saldoOrderIds = [];

  for (const o of orders) {
    if (o.real_deducted !== 1) {
      const items = safeParseJson(o.items_json);
      for (const it of Array.isArray(items) ? items : []) {
        const info = (it.item_id && byId[it.item_id]) || byName[String(it.name || '').trim()];
        if (!info) continue;
        if (info.unlimited_stock === 1) continue;
        const stockKey = info.mother_stock || info.item_id;
        if (!stockKey) continue;
        deductions[stockKey] = (deductions[stockKey] || 0) + (Number(it.qty) || 0);
      }
      stockOrderIds.push(o.order_id);
    }

    const saldoUsed = Number(o.saldo_used) || 0;
    if (saldoUsed > 0 && o.saldo_deducted !== 1) {
      const key = String(o.customer_name || '').trim().toLowerCase();
      saldoDeductions[key] = (saldoDeductions[key] || 0) + saldoUsed;
      saldoOrderIds.push(o.order_id);
    }
  }

  const statements = [];
  for (const [itemId, qty] of Object.entries(deductions)) {
    statements.push(
      env.myposdb
        .prepare('UPDATE menu SET stok_real = MAX(0, stok_real - ?) WHERE item_id = ?')
        .bind(qty, itemId)
    );
  }
  for (const orderId of stockOrderIds) {
    statements.push(
      env.myposdb.prepare('UPDATE order_pos SET real_deducted = 1 WHERE order_id = ? AND real_deducted = 0').bind(orderId)
    );
  }
  for (const [namaLower, total] of Object.entries(saldoDeductions)) {
    statements.push(
      env.myposdb.prepare('UPDATE customer SET saldo_real = saldo_real - ? WHERE LOWER(nama) = ?').bind(total, namaLower)
    );
  }
  for (const orderId of saldoOrderIds) {
    statements.push(
      env.myposdb.prepare('UPDATE order_pos SET saldo_deducted = 1 WHERE order_id = ? AND saldo_deducted = 0').bind(orderId)
    );
  }

  if (statements.length) await env.myposdb.batch(statements);

  return { processed_orders: stockOrderIds.length, deductions, saldo_deductions: saldoDeductions };
}

// ==== SCHEDULED: archiveOldPaidOrders (WP7 sisa, BARU 20 Sep 2026) ====

// Replikasi archiveOldPaidOrders() di Code_production.gs: order LUNAS (paid=1) yang
// delivery_date-nya lebih tua dari ARCHIVE_BUFFER_DAYS hari dipindah dari order_pos ke archive.
// Beda dari GAS (lebih ketat, bukan perubahan perilaku): INSERT ... SELECT + DELETE dikirim
// dalam SATU env.myposdb.batch() (transaksi atomik) — GAS baca ke memori lalu nulis & hapus
// terpisah, jadi kalau kepotong di tengah bisa dobel/hilang. Di sini pindahnya semua-atau-
// tidak-sama-sekali. Kolom ditulis eksplisit (bukan SELECT *) biar gak tergantung urutan kolom.
// Kalau ada order_id yang sudah ada di archive (mis. sisa unarchive updateOrder yang kepotong),
// INSERT-nya ditolak PRIMARY KEY dan SELURUH batch rollback — sengaja gagal keras (kelihatan di
// log cron), bukan diam-diam menimpa salah satu salinan.
const ARCHIVE_BUFFER_DAYS = 3;
const ORDER_COLUMNS =
  'order_id, created_at, delivery_date, customer_name, items_summary, items_json, total, note, prepared, ' +
  'device_label, updated_at, shipping_fee, paid, real_deducted, client_order_id, saldo_used, saldo_deducted, ' +
  'saldo_sisa_after, discount_type, discount_value';

// Aritmetika tanggal murni (yyyy-mm-dd -> yyyy-mm-dd) dari "hari ini" WIB — gak ada jam,
// jadi gak kena masalah offset zona waktu.
function dateDaysAgoJakartaISO(days) {
  const d = new Date(todayJakartaISO() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function archiveOldPaidOrders(env) {
  const cutoff = dateDaysAgoJakartaISO(ARCHIVE_BUFFER_DAYS);
  const [inserted] = await env.myposdb.batch([
    env.myposdb
      .prepare(
        `INSERT INTO archive (${ORDER_COLUMNS}) SELECT ${ORDER_COLUMNS} FROM order_pos WHERE paid = 1 AND delivery_date < ?`
      )
      .bind(cutoff),
    env.myposdb.prepare('DELETE FROM order_pos WHERE paid = 1 AND delivery_date < ?').bind(cutoff),
  ]);
  return { archived: (inserted.meta && inserted.meta.changes) || 0, cutoff };
}

// Urutan WAJIB: potong stok/saldo DULU, baru arsip — dalam satu handler, bukan dua cron
// terpisah, supaya urutannya terjamin. processExpiredPrepDeductions cuma menyisir order_pos;
// order yang keburu pindah ke archive sebelum sempat dipotong gak akan pernah dipotong lagi.
// Kalau langkah potong GAGAL, arsip DILEWATI malam itu (dicoba lagi besok) — di GAS ini dua
// trigger independen dan gak ada jaminan itu.
async function runDailyJobs(env) {
  try {
    const r = await processExpiredPrepDeductions(env);
    console.log('processExpiredPrepDeductions OK', JSON.stringify(r));
  } catch (err) {
    console.error('processExpiredPrepDeductions GAGAL — archiveOldPaidOrders DILEWATI:', err && err.message);
    return;
  }
  try {
    const r = await archiveOldPaidOrders(env);
    console.log('archiveOldPaidOrders OK', JSON.stringify(r));
  } catch (err) {
    console.error('archiveOldPaidOrders GAGAL:', err && err.message);
  }
  // LTV (PRD Customer LTV & Profile, Bagian 8) — independen dari 2 langkah di atas (gak
  // saling butuh urutan), tapi taruh terakhir biar first_order_date/last_order_date-nya
  // ngikutin state order_pos/archive yang udah final malam itu. Gagal di sini TIDAK
  // ngeblok apa-apa besok — data LTV cuma telat sehari, sama kayak trade-off di Bagian 8.
  try {
    const r = await refreshCustomerLtv(env);
    console.log('refreshCustomerLtv OK', JSON.stringify(r));
  } catch (err) {
    console.error('refreshCustomerLtv GAGAL:', err && err.message);
  }
}

// ==== ALLOWED EMAILS: add_allowed_email / delete_allowed_email (WP8, BARU 20 Sep 2026) ====

// Fitur baru (gak ada di GAS — di sana ALLOWED_EMAILS hardcode). Aturan dari PRD Section 7:
// cuma email dengan is_owner=1 yang boleh nambah/hapus; owner gak bisa dihapus lewat sini
// (biar gak ke-lock-out semua). Cek owner dibaca FRESH dari tabel tiap panggilan (bukan dari
// sesi) — sessions gak nyimpen is_owner, dan cabut hak owner lewat SQL langsung berlaku
// seketika. PENTING: error izin sengaja error BIASA (bukan status 'not_registered') —
// apiPost di frontend nganggep 'not_registered' = sesi mati dan otomatis logout.
async function requireOwner(env, session) {
  const row = await env.myposdb
    .prepare('SELECT is_owner FROM allowed_emails WHERE email = ?')
    .bind(session.email)
    .first();
  if (!row || Number(row.is_owner) !== 1) throw new Error('Cuma owner yang boleh ngatur daftar staff.');
}

// Staff baru SELALU is_owner=0 — gak ada jalur naikin jadi owner lewat API (owner di-seed
// manual lewat SQL, sesuai PRD). Email di-lowercase karena verifyLogin nyocokin email dari
// Google yang sudah lowercase; salah ketik email = staff itu gak akan pernah bisa login.
async function addAllowedEmail(env, session, p) {
  await requireOwner(env, session);
  const email = String((p && p.email) || '').trim().toLowerCase();
  const alias = String((p && p.alias) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Format email nggak valid.');
  if (!alias) throw new Error('Alias kosong.');
  try {
    await env.myposdb
      .prepare('INSERT INTO allowed_emails (email, alias, is_owner) VALUES (?, ?, 0)')
      .bind(email, alias)
      .run();
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('UNIQUE')) throw new Error('Email ini udah terdaftar.');
    throw err;
  }
  return { added: true, email, alias };
}

// Hapus staff + cabut SEMUA sesi aktifnya + subscription push-nya dalam satu batch (atomik).
// Tanpa cabut sesi, "hapus" cuma kosmetik: session_token yang sudah terbit (TTL 30 hari) tetap
// lolos validateSession dan orang itu masih bisa nulis data sampai token-nya expired. Tanpa cabut
// push_subscriptions (id = alias), orang yang sudah dihapus tetap dapet notif order baru (nama
// customer + item) di HP-nya. Konsekuensi: butuh tabel push_subscriptions (migrasi-20sep-push.sql).
async function deleteAllowedEmail(env, session, p) {
  await requireOwner(env, session);
  const email = String((p && p.email) || '').trim().toLowerCase();
  if (!email) throw new Error('Email kosong.');
  const target = await env.myposdb
    .prepare('SELECT alias, is_owner FROM allowed_emails WHERE email = ?')
    .bind(email)
    .first();
  if (!target) throw new Error('Email ini nggak ada di daftar staff.');
  if (Number(target.is_owner) === 1) throw new Error('Owner nggak bisa dihapus lewat sini.');
  await env.myposdb.batch([
    env.myposdb.prepare('DELETE FROM allowed_emails WHERE email = ? AND is_owner = 0').bind(email),
    env.myposdb.prepare('DELETE FROM sessions WHERE email = ?').bind(email),
    env.myposdb.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(target.alias),
  ]);
  return { deleted: true, email };
}

// Daftar staff buat layar "Authorize Email" di frontend — owner-only juga (isinya email
// orang), makanya lewat requireOwner, bukan cuma validateSession. is_owner dibalikin boolean.
async function getAllowedEmails(env, session) {
  await requireOwner(env, session);
  const { results } = await env.myposdb
    .prepare('SELECT email, alias, is_owner, role FROM allowed_emails ORDER BY is_owner DESC, rowid ASC')
    .all();
  return results.map((r) => ({ email: r.email, alias: r.alias, is_owner: Number(r.is_owner) === 1, role: Number(r.is_owner) === 1 ? 'owner' : (r.role === 'chef' ? 'chef' : 'staf') }));
}

// ==== PUSH NOTIFICATION: subscribe_push + kirim push order baru (BARU 20 Sep 2026) ====
// Spesifikasi & keputusan: "POS Shakies/Worker/Push Notif/PRD - Push Notification Order Baru.md".
// Scope: HP Android dika, trigger cuma add_order dengan delivery_date = HARI INI WIB.
//
// KEPUTUSAN IMPLEMENTASI (menyimpang dari PRD §8B step 1 — PRD nyaranin npm web-push-neo /
// @pushforge/builder): pakai Web Crypto bawaan runtime Workers, TANPA dependency. Alasannya:
// gak perlu `npm install` + package.json di project Worker, dan protokolnya kecil (VAPID JWT =
// ECDSA P-256; enkripsi payload = RFC 8291 aes128gcm). encryptPushPayload dites lawan test
// vector RFC 8291 Appendix A. Kalau nanti mau pindah ke library, cukup ganti isi sendPush().
//
// VAPID_PRIVATE_KEY = Worker Secret (sudah di-set), format base64url 32 byte hasil
// `web-push generate-vapid-keys`. Public key aman di kode (sama dengan CONFIG.VAPID_PUBLIC_KEY
// di test.html — HARUS identik, kalau beda push service nolak subscription-nya).
const VAPID_PUBLIC_KEY = 'BPJeRo-2YtoiY76zSYTU4zMeyiVs-lki8iTiyibwPpVVOICPiBqNMgr2fHJgcvKuAG2KhrYadzXW0KroPdm2ARg';
const VAPID_SUBJECT = 'https://heran-dika.github.io/shakies-pos/'; // contact URI di klaim `sub` (RFC 8292 boleh https: atau mailto:)
const PUSH_TTL_SECONDS = 4 * 60 * 60; // order hari-H yang telat >4 jam sampai udah gak berguna, biar push service buang
// Endpoint subscription dikirim dari client, lalu Worker mem-POST ke URL itu — WAJIB dibatasi ke
// push service yang dikenal, kalau tidak Worker bisa disuruh nembak URL sembarang (SSRF buta).
const PUSH_ENDPOINT_HOST_RE =
  /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/;

function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// HKDF (extract+expand sekaligus) — persis yang dikerjain deriveBits('HKDF') di Web Crypto.
async function hkdfBytes(ikm, salt, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8));
}

// RFC 8292: header Authorization "vapid t=<JWT>, k=<public key>". JWT ES256 — hasil
// crypto.subtle.sign ECDSA sudah format r||s 64 byte (IEEE P1363) yang dipakai JWS, gak perlu konversi DER.
async function vapidAuthHeader(env, endpoint) {
  const pub = b64urlToBytes(VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: String(env.VAPID_PRIVATE_KEY || '').trim(),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const enc = new TextEncoder();
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(
    enc.encode(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: VAPID_SUBJECT })
    )
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims))
  );
  return 'vapid t=' + header + '.' + claims + '.' + bytesToB64url(signature) + ', k=' + VAPID_PUBLIC_KEY;
}

// RFC 8291 (Web Push encryption) + RFC 8188 (aes128gcm), satu record, tanpa padding.
// Body = salt(16) || rs(4, big-endian) || idlen(1) || as_public(65) || ciphertext+tag.
async function encryptPushPayload(sub, payloadBytes) {
  const enc = new TextEncoder();
  const uaPublic = b64urlToBytes(sub.keys.p256dh); // 65 byte, uncompressed
  const authSecret = b64urlToBytes(sub.keys.auth); // 16 byte
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdfBytes(ecdhSecret, authSecret, concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdfBytes(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfBytes(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concatBytes(payloadBytes, new Uint8Array([2]))) // 0x02 = penanda record terakhir
  );

  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096); // record size
  head[20] = asPublic.length; // 65
  return concatBytes(head, asPublic, ciphertext);
}

// Balikin HTTP status dari push service (201 = diterima). Yang manggil yang nentuin arti statusnya.
async function sendPush(env, sub, message) {
  const body = await encryptPushPayload(sub, new TextEncoder().encode(JSON.stringify(message)));
  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: 'high', // biar Android gak nahan pesan pas Doze
    },
    body,
  });
  return resp.status;
}

// subscribe_push — WAJIB sudah lolos validateSession (router). id = alias staff dari sesi,
// jadi 1 orang = 1 baris; subscribe ulang dari HP lain menimpa yang lama. Upsert (BUKAN INSERT
// OR REPLACE seperti di PRD) supaya last_push_at/last_push_status gak ke-reset tiap app
// nge-sync ulang subscription — itu satu-satunya bahan diagnosis "kenapa notif berhenti".
async function subscribePush(env, session, p) {
  const endpoint = String((p && p.endpoint) || '').trim();
  const p256dh = String((p && p.keys && p.keys.p256dh) || '').trim();
  const auth = String((p && p.keys && p.keys.auth) || '').trim();

  let url;
  try {
    url = new URL(endpoint);
  } catch (e) {
    throw new Error('Endpoint push nggak valid.');
  }
  if (url.protocol !== 'https:' || !PUSH_ENDPOINT_HOST_RE.test(url.hostname)) {
    throw new Error('Endpoint push nggak dikenali.');
  }
  let keysOk = false;
  try {
    keysOk = b64urlToBytes(p256dh).length === 65 && b64urlToBytes(auth).length === 16;
  } catch (e) {
    keysOk = false;
  }
  if (!keysOk) throw new Error('Kunci subscription nggak valid.');

  await env.myposdb
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, updated_at = excluded.updated_at`
    )
    .bind(session.alias, endpoint, p256dh, auth, new Date().toISOString())
    .run();
  return { subscribed: true };
}

// unsubscribe_push (BARU 21 Sep 2026) — tombol "Matikan Notifikasi" di modal Akun Staff. Hapus baris
// push milik alias sesi INI, tapi HANYA kalau endpoint-nya sama dengan yang dikirim HP yang menekan
// tombol: id = alias, jadi kalau HP lain di akun yang sama sudah subscribe belakangan (menimpa baris),
// HP ini gak boleh ikut mematikan punya HP itu. Gak ada barisnya = bukan error (tujuannya sudah tercapai).
async function unsubscribePush(env, session, p) {
  const endpoint = String((p && p.endpoint) || '').trim();
  if (!endpoint) throw new Error('Endpoint kosong.');
  const result = await env.myposdb
    .prepare('DELETE FROM push_subscriptions WHERE id = ? AND endpoint = ?')
    .bind(session.alias, endpoint)
    .run();
  return { unsubscribed: !!(result.meta && result.meta.changes > 0) };
}

// Dipanggil dari router lewat ctx.waitUntil() SETELAH add_order sukses — gak nge-block response
// ke frontend, dan SEMUA kegagalan ditelan di sini (push itu bonus, order tetap sukses).
// "Hari ini" = tanggal WIB (todayJakartaISO), BUKAN UTC — order jam 05:00 WIB masih "kemarin" di UTC.
// ---- Preferensi jenis notifikasi per akun (15 Okt 2026) ----
// Kolom push_subscriptions.prefs (JSON). WAJIB migrasi-15okt-notif-prefs.sql dulu. Default: order_baru & bahan_habis nyala
// (sama kayak perilaku sebelum ada pilihan), rekap_pagi mati sampai dinyalakan.
const PUSH_PREF_DEFAULT = { order_baru: true, rekap_pagi: false, bahan_habis: true, hampers: true }; // hampers (5 Nov 2026): pengingat H-3..H-0 pesanan hampers, nyala default
function parsePushPrefs(raw) {
  let o = {};
  try { o = raw ? JSON.parse(raw) : {}; } catch (e) { o = {}; }
  const out = {};
  for (const k of Object.keys(PUSH_PREF_DEFAULT)) out[k] = typeof o[k] === 'boolean' ? o[k] : PUSH_PREF_DEFAULT[k];
  return out;
}
async function getPushPrefs(env, session) {
  const row = await env.myposdb.prepare('SELECT prefs FROM push_subscriptions WHERE id = ?').bind(session.alias).first();
  return Object.assign({ subscribed: !!row }, parsePushPrefs(row && row.prefs));
}
async function setPushPrefs(env, session, p) {
  const row = await env.myposdb.prepare('SELECT prefs FROM push_subscriptions WHERE id = ?').bind(session.alias).first();
  if (!row) throw new Error('Notifikasi belum aktif di akun ini. Nyalakan dulu.');
  const next = parsePushPrefs(row.prefs);
  for (const k of Object.keys(PUSH_PREF_DEFAULT)) if (p && typeof p[k] === 'boolean') next[k] = p[k];
  await env.myposdb.prepare('UPDATE push_subscriptions SET prefs = ? WHERE id = ?').bind(JSON.stringify(next), session.alias).run();
  return next;
}

// Rekap jam 04.00 WIB (cron '0 21 * * *'): ringkasan SEMUA order dengan tanggal kirim hari ini (termasuk yang dibuat kemarin).
// Kalau nggak ada order -> nggak ngirim apa-apa. Cuma ke akun yang menyalakan 'rekap_pagi'.
async function pushRekapPagi(env) {
  try {
    const hari = todayJakartaISO();
    const { results: orders } = await env.myposdb.prepare('SELECT customer_name, items_json FROM order_pos WHERE delivery_date = ?').bind(hari).all();
    if (!orders || !orders.length) return;
    const tot = {};
    let pcs = 0;
    for (const o of orders) {
      const items = safeParseJson(o.items_json);
      for (const it of Array.isArray(items) ? items : []) {
        const nm = String((it && it.name) || '').trim();
        const q = Number(it && it.qty) || 0;
        if (!nm || q <= 0) continue;
        tot[nm] = (tot[nm] || 0) + q;
        pcs += q;
      }
    }
    const daftar = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([n, q]) => q + ' ' + n).join(', ');
    const message = {
      title: 'Order hari ini: ' + orders.length + ' order' + (pcs ? ' (' + pcs + ' pcs)' : ''),
      body: (daftar || 'Buka tab Prep untuk detailnya.').slice(0, 240),
      tag: 'rekap-pagi',
      alarm: true,
    };
    const { results } = await env.myposdb.prepare('SELECT id, endpoint, p256dh, auth, prefs FROM push_subscriptions').all();
    for (const row of results) {
      if (!parsePushPrefs(row.prefs).rekap_pagi) continue;
      let status;
      try {
        const code = await sendPush(env, { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, message);
        if (code === 404 || code === 410) { await env.myposdb.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run(); continue; }
        status = code >= 200 && code < 300 ? 'ok' : 'HTTP ' + code;
      } catch (err) {
        status = 'error: ' + String((err && err.message) || err).slice(0, 120);
      }
      await env.myposdb.prepare('UPDATE push_subscriptions SET last_push_at = ?, last_push_status = ? WHERE id = ?').bind(new Date().toISOString(), status, row.id).run();
    }
  } catch (err) {
    console.error('pushRekapPagi GAGAL:', err && err.message);
  }
}

// Pengingat hampers (5 Nov 2026): cron 04.00 WIB. Untuk tiap hari H-3, H-2, H-1, hari-H yang punya pesanan hampers, kirim SATU
// notifikasi berisi paket + rekap isi paket yang harus disiapkan. Terpisah dari pushRekapPagi (order biasa): hari yang sama
// bisa ada 2 jenis notif. Dikirim ke semua akun yang menyalakan 'hampers' (semua role boleh input hampers). Semua kegagalan ditelan.
async function pushHampersReminders(env) {
  try {
    const items = await hampersReminders(env, todayJakartaISO());
    if (!items.length) return;
    const { results } = await env.myposdb.prepare('SELECT id, endpoint, p256dh, auth, prefs FROM push_subscriptions').all();
    for (const it of items) {
      for (const row of results) {
        if (!parsePushPrefs(row.prefs).hampers) continue;
        let status;
        try {
          const code = await sendPush(env, { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, it.message);
          if (code === 404 || code === 410) { await env.myposdb.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run(); continue; }
          status = code >= 200 && code < 300 ? 'ok' : 'HTTP ' + code;
        } catch (err) {
          status = 'error: ' + String((err && err.message) || err).slice(0, 120);
        }
        await env.myposdb.prepare('UPDATE push_subscriptions SET last_push_at = ?, last_push_status = ? WHERE id = ?').bind(new Date().toISOString(), status, row.id).run();
      }
    }
  } catch (err) {
    console.error('pushHampersReminders GAGAL:', err && err.message);
  }
}

async function pushNewOrderIfToday(env, p) {
  try {
    if (String((p && p.delivery_date) || '') !== todayJakartaISO()) return;
    const { results } = await env.myposdb.prepare('SELECT id, endpoint, p256dh, auth, prefs FROM push_subscriptions').all();
    const summary = String(p && p.items_summary || "");
    const note = String(p && p.note || "").trim();
    const message = {
      title: "Order baru masuk",
      body: (String(p && p.customer_name || "") + (summary ? ": " + summary : "") + (note ? "\n📝 " + note : "")).slice(0, 240)
    };
    for (const row of results) {
      // Order dibuat dari HP yang sama dengan yang subscribe -> skip (keputusan PRD §9 #1).
      // Dibandingin lewat endpoint, BUKAN alias, supaya order dari HP lain di akun yang sama tetap masuk.
      if (p.origin_push_endpoint && p.origin_push_endpoint === row.endpoint) continue;
      if (!parsePushPrefs(row.prefs).order_baru) continue; // akun ini mematikan jenis notif ini
      let status;
      try {
        const code = await sendPush(env, { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, message);
        if (code === 404 || code === 410) {
          // subscription mati permanen -> buang, jangan dicoba terus
          await env.myposdb.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run();
          continue;
        }
        status = code >= 200 && code < 300 ? 'ok' : 'HTTP ' + code;
      } catch (err) {
        status = 'error: ' + String((err && err.message) || err).slice(0, 120);
      }
      await env.myposdb
        .prepare('UPDATE push_subscriptions SET last_push_at = ?, last_push_status = ? WHERE id = ?')
        .bind(new Date().toISOString(), status, row.id)
        .run();
    }
  } catch (err) {
    console.error('pushNewOrderIfToday GAGAL:', err && err.message);
  }
}

// Notif bahan habis (U16, 14 Okt 2026) — hanya ke OWNER (is_owner=1 di allowed_emails; push_subscriptions.id = alias).
// Dipanggil dari resep.js lewat ctx.waitUntil; semua kegagalan ditelan (push itu bonus, produksi/opname tetap sukses).
async function pushHabisToOwners(env, names) {
  try {
    if (!names || !names.length) return;
    const { results } = await env.myposdb.prepare('SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, ps.prefs FROM push_subscriptions ps JOIN allowed_emails ae ON ae.alias = ps.id WHERE ae.is_owner = 1').all();
    const message = { title: 'Bahan habis', body: (names.join(', ') + ' habis').slice(0, 240) };
    for (const row of results) {
      if (!parsePushPrefs(row.prefs).bahan_habis) continue; // akun ini mematikan jenis notif ini
      let status;
      try {
        const code = await sendPush(env, { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, message);
        if (code === 404 || code === 410) { await env.myposdb.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run(); continue; }
        status = code >= 200 && code < 300 ? 'ok' : 'HTTP ' + code;
      } catch (err) {
        status = 'error: ' + String((err && err.message) || err).slice(0, 120);
      }
      await env.myposdb.prepare('UPDATE push_subscriptions SET last_push_at = ?, last_push_status = ? WHERE id = ?').bind(new Date().toISOString(), status, row.id).run();
    }
  } catch (err) {
    console.error('pushHabisToOwners GAGAL:', err && err.message);
  }
}

// ==== ROUTER (doGet/doPost-equivalent) ====

const GATED_GET_ACTIONS = ['get_orders', 'get_orders_search', 'get_customers_saldo', 'get_customer_saldo_detail', 'get_allowed_emails', 'get_customers_ltv', 'get_customer_profile'].concat(RESEP_GET_ACTIONS, HAMPERS_GET_ACTIONS);

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        const action = url.searchParams.get('action');

        // get_menu, get_customers, get_published_menu: PUBLIK, gak butuh session, persis
        // sama kayak doGet() versi GAS (lihat Code_production.gs).
        if (action === 'get_menu') {
          const result = await getMenu(env);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'get_customers') {
          const result = await getCustomers(env);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'get_published_menu') {
          const result = await getPublishedMenu(env);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (GATED_GET_ACTIONS.includes(action)) {
          const session = await validateSession(env, url.searchParams.get('session_token'));
          if (!session) {
            return jsonOut(
              { status: 'not_registered', message: 'Sesi login belum ada / udah expired. Sign in dulu buat lihat data ini.' },
              origin
            );
          }

          if (RESEP_GET_ACTIONS.includes(action)) {
            const result = await handleResep(env, session, action, Object.fromEntries(url.searchParams), { pushHabis: (names) => ctx.waitUntil(pushHabisToOwners(env, names)) });
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (HAMPERS_GET_ACTIONS.includes(action)) {
            const result = await handleHampers(env, session, action, Object.fromEntries(url.searchParams), { requireRole });
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_allowed_emails') {
            const result = await getAllowedEmails(env, session);
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_orders') {
            const result = await getOrders(env);
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_orders_search') {
            const result = await searchOrders(env, Object.fromEntries(url.searchParams));
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_customers_saldo') {
            const result = await getCustomersWithSaldo(env);
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_customer_saldo_detail') {
            const result = await getCustomerSaldoDetail(env, url.searchParams.get('customer_id'));
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          if (action === 'get_customers_ltv') {
            const result = await getCustomersLtv(env);
            return jsonOut({ status: 'ok', data: result }, origin);
          }

          // Di-route pakai ?nama=... (bukan customer_id) — lihat catatan di getCustomerProfile
          // soal kenapa customer_id gak bisa dipakai sebagai key universal di sini.
          if (action === 'get_customer_profile') {
            const result = await getCustomerProfile(env, url.searchParams.get('nama'));
            return jsonOut({ status: 'ok', data: result }, origin);
          }
        }

        return jsonOut({ status: 'error', message: 'Unknown action: ' + action }, origin);
      }

      if (request.method === 'POST') {
        const body = await request.json();
        const action = body.action;

        if (action === 'verify_login') {
          const result = await verifyLogin(env, body.payload && body.payload.id_token);
          return jsonOut(result, origin);
        }

        const session = await validateSession(env, body.payload && body.payload.session_token);
        if (!session) {
          return jsonOut(
            { status: 'not_registered', message: 'Sesi login belum ada / udah expired. Sign in ulang buat nulis data beneran.' },
            origin
          );
        }

        if (RESEP_POST_ACTIONS.includes(action)) {
          const result = await handleResep(env, session, action, body.payload, { pushHabis: (names) => ctx.waitUntil(pushHabisToOwners(env, names)) });
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (HAMPERS_POST_ACTIONS.includes(action)) {
          const result = await handleHampers(env, session, action, body.payload, { requireRole });
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'update_stok') {
          const result = await setMenuStok(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'update_menu_aktif') {
          const result = await updateMenuAktif(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'add_order') {
          const result = await addOrder(env, body.payload);
          // Push order baru: di belakang layar (gak nge-block response), dan dilewati kalau ini cuma
          // retry idempotency dari order yang sudah pernah kesimpan (duplicate) — biar gak push dobel.
          if (!result.duplicate) ctx.waitUntil(pushNewOrderIfToday(env, body.payload));
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'add_menu_item') {
          const result = await addMenuItem(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'update_menu_item') {
          const result = await updateMenuItem(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'delete_menu_row') {
          const result = await deleteMenuRow(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'delete_category') {
          const result = await deleteCategory(env, body.payload && body.payload.kategori);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'update_order') {
          const result = await updateOrder(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'set_order_flag') {
          const result = await setOrderFlag(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'delete_order') {
          const result = await deleteOrder(env, body.payload && body.payload.order_id);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'topup_saldo') {
          const result = await topupSaldo(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'pay_order_with_saldo') {
          const result = await payOrderWithSaldo(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'reconcile_saldo') {
          const result = await reconcileCustomerSaldo(env, body.payload && body.payload.customer_id);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        // PRD Customer LTV & Profile, Bagian 4.2/4.3 — lihat komentar di mergeOrRenameCustomer
        // soal kenapa 2 action ini manggil fungsi yang sama.
        if (action === 'update_customer_name') {
          const p = body.payload || {};
          const result = await mergeOrRenameCustomer(env, p.old_nama, p.new_nama, session.email);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'merge_customer') {
          const p = body.payload || {};
          const result = await mergeOrRenameCustomer(env, p.source_nama, p.target_nama, session.email);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'update_customer_contact') {
          const result = await updateCustomerContact(env, body.payload || {});
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'subscribe_push') {
          const result = await subscribePush(env, session, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'unsubscribe_push') {
          const result = await unsubscribePush(env, session, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'get_push_prefs') {
          const result = await getPushPrefs(env, session);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'set_push_prefs') {
          const result = await setPushPrefs(env, session, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'add_allowed_email') {
          const result = await addAllowedEmail(env, session, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'delete_allowed_email') {
          const result = await deleteAllowedEmail(env, session, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        if (action === 'publish_menu') {
          const result = await publishMenu(env, body.payload);
          return jsonOut({ status: 'ok', data: result }, origin);
        }

        return jsonOut({ status: 'error', message: 'Unknown action: ' + action }, origin);
      }

      return jsonOut({ status: 'error', message: 'Method not allowed.' }, origin, 405);
    } catch (err) {
      return jsonOut({ status: 'error', message: err.message }, origin, 500);
    }
  },

  // Cron Trigger (jadwal di wrangler.toml [triggers]). Error cuma di-log (kelihatan di
  // `wrangler tail` / dashboard Logs) — gak ada request HTTP yang bisa dibales error.
  async scheduled(event, env, ctx) {
    // Dua cron di wrangler.toml: '0 21 * * *' (04:00 WIB) = rekap order pagi; '5 17 * * *' (00:05 WIB) = job harian.
    if (event && event.cron === '0 21 * * *') { ctx.waitUntil(pushRekapPagi(env)); ctx.waitUntil(pushHampersReminders(env)); return; } // dua notif terpisah: rekap order biasa + pengingat hampers
    ctx.waitUntil(runDailyJobs(env)); // potong stok/saldo dulu, baru arsip — lihat runDailyJobs
  },
};
