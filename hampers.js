// ==== hampers.js — PO Hampers di dalam POS (v2, 5 Nov 2026) ====
// Modul TAMBAHAN yang di-import worker.js. Tabel: hampers_order (lama), hampers_periode + hampers_paket (baru).
// WAJIB jalankan migrasi-5nov-hampers-periode.sql di D1 SEBELUM deploy. Tidak menyentuh order_pos/archive/stok/saldo.
// requireRole di-inject dari worker.js lewat deps (worker.js tidak punya named export -> hindari import melingkar).
//
// Akses: lihat + input + edit + hapus pesanan = semua role yang sudah login.
//        buat/ubah/tutup periode dan paket = owner saja.
// Pesanan menyimpan SNAPSHOT tiap baris paket (label, harga, isi) — mengubah/menghapus paket tidak mengubah pesanan lama.
export const HAMPERS_GET_ACTIONS = ['get_hampers', 'get_hampers_orders'];
export const HAMPERS_POST_ACTIONS = [
  'add_hampers_order', 'update_hampers_order', 'delete_hampers_order',
  'save_hampers_periode', 'set_hampers_periode_closed', 'save_hampers_paket', 'delete_hampers_paket',
];

// Pesanan lama (sebelum ada periode) dianggap milik periode Natal hasil seed migrasi.
const LEGACY_PERIODE = 'per_natal_2026';

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
const rid = (p) => p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const parse = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };

function cleanIsi(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Isi paket kosong.');
  if (raw.length > 30) throw new Error('Maksimal 30 item per paket.');
  return raw.map((x) => {
    const nama = str(x && x.nama, 80), qty = Number(x && x.qty);
    if (!nama) throw new Error('Nama item di isi paket kosong.');
    if (!isInt(qty, 1, 999)) throw new Error('Jumlah item di isi paket harus bilangan bulat 1-999.');
    return { item_id: str(x && x.item_id, 40) || null, nama, qty };
  });
}

// Baris pesanan LAMA (hampers.html) — kirim label/harga/isi sendiri. Tetap diterima supaya halaman lama tidak rusak.
function cleanLegacyLine(l) {
  const label = str(l && l.label, 120);
  const qty = Number(l && l.qty), harga = Number(l && l.harga);
  if (!label) throw new Error('Nama paket kosong.');
  if (!isInt(qty, 1, 999)) throw new Error('Jumlah paket harus bilangan bulat 1-999.');
  if (!isInt(harga, 0, 100000000)) throw new Error('Harga paket nggak valid.');
  const isi = (Array.isArray(l.isi) ? l.isi : []).slice(0, 30).map((x) => {
    const n = str(x && x[0], 80), q = Number(x && x[1]);
    if (!n || !isInt(q, 1, 999)) throw new Error('Isi paket nggak valid.');
    return [n, q];
  });
  if (!isi.length) throw new Error('Isi paket kosong.');
  return { label, harga, qty, isi };
}

// Bangun baris pesanan. Baris baru berbasis paket_id di-snapshot dari tabel paket (harga dari SERVER, bukan klien).
// existingByPaket: baris yang SUDAH ada di pesanan (saat edit) -> snapshot lama dipertahankan, cuma qty yang berubah,
// dan paket dari periode yang sudah ditutup tetap boleh ada selama memang sudah ada di pesanan itu.
async function buildLines(env, raw, existingByPaket) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Pesanan butuh minimal 1 paket.');
  if (raw.length > 30) throw new Error('Maksimal 30 baris paket per pesanan.');
  const out = [];
  for (const l of raw) {
    const paketId = str(l && l.paket_id, 60);
    if (!paketId) { out.push(cleanLegacyLine(l)); continue; }
    const qty = Number(l.qty);
    if (!isInt(qty, 1, 999)) throw new Error('Jumlah paket harus bilangan bulat 1-999.');
    const keep = existingByPaket && existingByPaket.get(paketId);
    if (keep) { out.push(Object.assign({}, keep, { qty })); continue; }
    const p = await env.myposdb
      .prepare('SELECT k.id, k.periode_id, k.nama, k.harga, k.isi_json, k.deleted_at, r.closed_at FROM hampers_paket k JOIN hampers_periode r ON r.id = k.periode_id WHERE k.id = ?')
      .bind(paketId).first();
    if (!p || p.deleted_at) throw new Error('Paket nggak ketemu (mungkin baru dihapus owner) — buka ulang layar Hampers.');
    if (p.closed_at) throw new Error('Periode paket "' + p.nama + '" sudah ditutup.');
    const isi = parse(p.isi_json, []).map((x) => [x.nama, Number(x.qty) || 1]);
    out.push({ paket_id: p.id, periode_id: p.periode_id, label: p.nama, harga: Number(p.harga) || 0, qty, isi });
  }
  // gabung baris dengan paket_id sama (klien kadang mengirim dobel)
  const merged = [];
  for (const l of out) {
    const same = l.paket_id && merged.find((m) => m.paket_id === l.paket_id);
    if (same) same.qty += l.qty; else merged.push(l);
  }
  return merged;
}

const sumTotal = (lines) => lines.reduce((s, l) => s + l.harga * l.qty, 0);

function rowToOrder(r) {
  const lines = parse(r.lines_json, []);
  return {
    id: r.id, nama: r.nama, tgl: r.tgl, note: r.note || '',
    lines: lines.map((l) => Object.assign({}, l, { periode_id: l.periode_id || LEGACY_PERIODE })),
    total: Number(r.total) || 0, created_at: r.created_at, created_by: r.created_by || '',
  };
}

async function getOrders(env) {
  const { results } = await env.myposdb
    .prepare('SELECT id, nama, tgl, note, lines_json, total, created_at, created_by FROM hampers_order ORDER BY tgl ASC, created_at ASC')
    .all();
  return results.map(rowToOrder);
}

async function getHampers(env) {
  const { results: per } = await env.myposdb
    .prepare('SELECT id, nama, buka, tutup, closed_at, created_at FROM hampers_periode ORDER BY (closed_at IS NOT NULL) ASC, created_at ASC')
    .all();
  const { results: pk } = await env.myposdb
    .prepare('SELECT id, periode_id, nama, harga, isi_json, urut FROM hampers_paket WHERE deleted_at IS NULL ORDER BY urut ASC, rowid ASC')
    .all();
  const periode = per.map((p) => ({
    id: p.id, nama: p.nama, buka: p.buka || '', tutup: p.tutup || '', closed: !!p.closed_at,
    pakets: pk.filter((k) => k.periode_id === p.id).map((k) => ({ id: k.id, nama: k.nama, harga: Number(k.harga) || 0, isi: parse(k.isi_json, []), urut: k.urut })),
  }));
  return { periode, orders: await getOrders(env) };
}

async function addOrder(env, session, p) {
  const clientId = str(p && p.client_id, 80);
  if (!clientId) throw new Error('client_id kosong.');
  const dup = await env.myposdb.prepare('SELECT id FROM hampers_order WHERE client_id = ?').bind(clientId).first();
  if (dup) return { id: dup.id, duplicate: true };

  const tgl = str(p.tgl, 10);
  if (!isDate(tgl)) throw new Error('Tanggal kirim nggak valid.');
  const nama = str(p.nama, 80) || 'Tanpa nama';
  const note = str(p.note, 500);
  const lines = await buildLines(env, p.lines, null);
  const total = sumTotal(lines); // dihitung ulang di server
  const id = rid('hmp');
  try {
    await env.myposdb
      .prepare('INSERT INTO hampers_order (id, client_id, nama, tgl, note, lines_json, total, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, clientId, nama, tgl, note, JSON.stringify(lines), total, new Date().toISOString(), session.alias)
      .run();
  } catch (err) {
    if (String(err.message || '').toUpperCase().includes('UNIQUE')) {
      const ex = await env.myposdb.prepare('SELECT id FROM hampers_order WHERE client_id = ?').bind(clientId).first();
      if (ex) return { id: ex.id, duplicate: true };
    }
    throw err;
  }
  return { id, total };
}

async function updateOrder(env, p) {
  const id = str(p && p.id, 80);
  if (!id) throw new Error('id kosong.');
  const cur = await env.myposdb.prepare('SELECT id, lines_json FROM hampers_order WHERE id = ?').bind(id).first();
  if (!cur) throw new Error('Pesanan hampers nggak ketemu (mungkin sudah dihapus device lain) — refresh dulu.');
  const tgl = str(p.tgl, 10);
  if (!isDate(tgl)) throw new Error('Tanggal kirim nggak valid.');
  const nama = str(p.nama, 80) || 'Tanpa nama';
  const note = str(p.note, 500);
  const existing = new Map();
  for (const l of parse(cur.lines_json, [])) if (l && l.paket_id) existing.set(l.paket_id, l);
  const lines = await buildLines(env, p.lines, existing);
  const total = sumTotal(lines);
  await env.myposdb
    .prepare('UPDATE hampers_order SET nama = ?, tgl = ?, note = ?, lines_json = ?, total = ? WHERE id = ?')
    .bind(nama, tgl, note, JSON.stringify(lines), total, id)
    .run();
  return { id, total };
}

async function deleteOrder(env, p) {
  const id = str(p && p.id, 80);
  if (!id) throw new Error('id kosong.');
  const r = await env.myposdb.prepare('DELETE FROM hampers_order WHERE id = ?').bind(id).run();
  return { deleted: !!(r.meta && r.meta.changes > 0) };
}

// ---- Owner only: periode & paket ----
async function savePeriode(env, session, p) {
  const nama = str(p && p.nama, 60);
  if (!nama) throw new Error('Nama periode kosong.');
  const buka = str(p.buka, 10), tutup = str(p.tutup, 10);
  if (buka && !isDate(buka)) throw new Error('Tanggal buka nggak valid.');
  if (tutup && !isDate(tutup)) throw new Error('Tanggal tutup nggak valid.');
  const id = str(p.id, 60);
  if (id) {
    const r = await env.myposdb.prepare('UPDATE hampers_periode SET nama = ?, buka = ?, tutup = ? WHERE id = ?').bind(nama, buka || null, tutup || null, id).run();
    if (!r.meta || !r.meta.changes) throw new Error('Periode nggak ketemu — refresh dulu.');
    return { id };
  }
  const nid = rid('per');
  await env.myposdb
    .prepare('INSERT INTO hampers_periode (id, nama, buka, tutup, closed_at, created_at, created_by) VALUES (?,?,?,?,NULL,?,?)')
    .bind(nid, nama, buka || null, tutup || null, new Date().toISOString(), session.alias).run();
  return { id: nid };
}

async function setPeriodeClosed(env, p) {
  const id = str(p && p.id, 60);
  if (!id) throw new Error('id kosong.');
  const closedAt = p.closed === false ? null : new Date().toISOString();
  const r = await env.myposdb.prepare('UPDATE hampers_periode SET closed_at = ? WHERE id = ?').bind(closedAt, id).run();
  if (!r.meta || !r.meta.changes) throw new Error('Periode nggak ketemu — refresh dulu.');
  return { id, closed: closedAt !== null };
}

async function savePaket(env, p) {
  const nama = str(p && p.nama, 120);
  if (!nama) throw new Error('Nama paket kosong.');
  const harga = Number(p.harga);
  if (!isInt(harga, 0, 100000000)) throw new Error('Harga paket nggak valid.');
  const isi = cleanIsi(p.isi);
  const id = str(p.id, 60);
  if (id) {
    const r = await env.myposdb
      .prepare('UPDATE hampers_paket SET nama = ?, harga = ?, isi_json = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(nama, harga, JSON.stringify(isi), id).run();
    if (!r.meta || !r.meta.changes) throw new Error('Paket nggak ketemu — refresh dulu.');
    return { id };
  }
  const periodeId = str(p.periode_id, 60);
  const per = periodeId && (await env.myposdb.prepare('SELECT id FROM hampers_periode WHERE id = ?').bind(periodeId).first());
  if (!per) throw new Error('Periode nggak ketemu — refresh dulu.');
  const mx = await env.myposdb.prepare('SELECT COALESCE(MAX(urut), 0) AS m FROM hampers_paket WHERE periode_id = ?').bind(periodeId).first();
  const nid = rid('pkt');
  await env.myposdb
    .prepare('INSERT INTO hampers_paket (id, periode_id, nama, harga, isi_json, urut, deleted_at) VALUES (?,?,?,?,?,?,NULL)')
    .bind(nid, periodeId, nama, harga, JSON.stringify(isi), (Number(mx && mx.m) || 0) + 1).run();
  return { id: nid };
}

// Soft delete: pesanan lama tidak terpengaruh (isinya snapshot), paket hanya hilang dari daftar.
async function deletePaket(env, p) {
  const id = str(p && p.id, 60);
  if (!id) throw new Error('id kosong.');
  const r = await env.myposdb.prepare('UPDATE hampers_paket SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(new Date().toISOString(), id).run();
  return { deleted: !!(r.meta && r.meta.changes > 0) };
}

// Dipanggil router worker.js setelah validateSession. deps.requireRole = fungsi dari worker.js.
export async function handleHampers(env, session, action, params, deps) {
  switch (action) {
    case 'get_hampers': return getHampers(env);
    case 'get_hampers_orders': return getOrders(env);
    case 'add_hampers_order': return addOrder(env, session, params || {});
    case 'update_hampers_order': return updateOrder(env, params || {});
    case 'delete_hampers_order': return deleteOrder(env, params || {});
    default: break;
  }
  // Sisanya khusus owner. Error biasa, bukan not_registered (supaya tidak auto-logout).
  await deps.requireRole(env, session, ['owner'], 'Mengatur periode dan paket hampers cuma bisa dilakukan owner.');
  switch (action) {
    case 'save_hampers_periode': return savePeriode(env, session, params || {});
    case 'set_hampers_periode_closed': return setPeriodeClosed(env, params || {});
    case 'save_hampers_paket': return savePaket(env, params || {});
    case 'delete_hampers_paket': return deletePaket(env, params || {});
    default: throw new Error('Unknown action: ' + action);
  }
}

// ---- Pengingat push hampers: H-3, H-2, H-1, hari-H (dijalankan cron 04.00 WIB) ----
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const tglPendek = (iso) => Number(iso.slice(8, 10)) + ' ' + BULAN[Number(iso.slice(5, 7)) - 1];

// Satu pesan per hari (H-3..H-0) yang ada pesanannya. Dikirim H-3 dulu, H-0 terakhir (tampil paling atas di HP).
// todayISO = tanggal WIB (dari worker.js). Tidak ada pesanan -> array kosong -> tidak ada notif.
export async function hampersReminders(env, todayISO) {
  const out = [];
  for (const d of [3, 2, 1, 0]) {
    const tgl = addDaysISO(todayISO, d);
    const { results } = await env.myposdb.prepare('SELECT lines_json FROM hampers_order WHERE tgl = ?').bind(tgl).all();
    if (!results || !results.length) continue;
    const paket = new Map(), isi = new Map();
    let boxes = 0;
    for (const r of results) {
      for (const l of parse(r.lines_json, [])) {
        const q = Number(l && l.qty) || 0;
        if (!l || q <= 0) continue;
        boxes += q;
        paket.set(l.label, (paket.get(l.label) || 0) + q);
        for (const x of Array.isArray(l.isi) ? l.isi : []) isi.set(x[0], (isi.get(x[0]) || 0) + (Number(x[1]) || 0) * q);
      }
    }
    const when = d === 0 ? 'hari ini' : d === 1 ? 'besok' : d + ' hari lagi';
    const title = 'Hampers ' + when + ' (' + tglPendek(tgl) + '): ' + results.length + ' pesanan, ' + boxes + ' paket';
    const lPaket = [...paket].map(([n, q]) => q + ' ' + n).join(', ');
    const lIsi = [...isi].map(([n, q]) => q + ' ' + n).join(', ');
    let body = 'Paket: ' + lPaket + '\nIsi: ' + lIsi;
    if (body.length > 480) body = body.slice(0, 477) + '...';
    out.push({ offset: d, tgl, message: { title, body, tag: 'hampers-d' + d } });
  }
  return out;
}
