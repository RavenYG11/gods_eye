// GODS EYE #74 — penulis ZIP minimal pure-Node (TANPA dependency baru).
//
// Dipakai GET /api/dataset/export: mengemas dataset ke format YOLO
// (images/ + labels/ + dataset.yaml) sebagai SATU buffer ZIP untuk diunduh.
//
// Keterbatasan yang disengaja (cukup untuk kebutuhan ini):
//   - metode STORE saja (tanpa kompresi) — gambar PNG/JPG memang tidak
//     mengecil signifikan bila dikompresi; kesederhanaan > ukuran.
//   - nama file UTF-8 (flag bit 11), tanpa enkripsi, tanpa ZIP64.
// CRC32 dihitung sendiri (tabel 256 entri) — tanpa modul tambahan.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 (IEEE 802.3) dari Buffer. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Waktu DOS (16 bit) + tanggal DOS (16 bit) dari Date. */
function dosDateTime(d) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2) & 0x1f) << 0);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    ((d.getDate() & 0x1f) << 0);
  return { time, date };
}

/**
 * Bangun ZIP (metode store) dari daftar file.
 * @param {Array<{name: string, data: Buffer|string}>} files — nama memakai
 *        '/' sebagai pemisah (mis. 'images/train/3.png').
 * @returns {Buffer} isi file .zip lengkap.
 */
export function createZip(files) {
  const now = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(data);

    // Local file header (PK\x03\x04)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed (2.0)
    lh.writeUInt16LE(1 << 11, 6); // flags: bit 11 = UTF-8
    lh.writeUInt16LE(0, 8); // method: 0 = store
    lh.writeUInt16LE(now.time, 10);
    lh.writeUInt16LE(now.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed size (= uncompressed, store)
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra length
    chunks.push(lh, nameBuf, data);

    // Central directory entry (PK\x01\x02) — dicatat untuk ditulis belakangan
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0); // signature
    ce.writeUInt16LE(20, 4); // version made by
    ce.writeUInt16LE(20, 6); // version needed
    ce.writeUInt16LE(1 << 11, 8); // flags UTF-8
    ce.writeUInt16LE(0, 10); // method store
    ce.writeUInt16LE(now.time, 12);
    ce.writeUInt16LE(now.date, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(data.length, 20);
    ce.writeUInt32LE(data.length, 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30); // extra
    ce.writeUInt16LE(0, 32); // comment
    ce.writeUInt16LE(0, 34); // disk number
    ce.writeUInt16LE(0, 36); // internal attrs
    ce.writeUInt32LE(0, 38); // external attrs
    ce.writeUInt32LE(offset, 42); // offset local header
    central.push({ header: ce, name: nameBuf });
    offset += lh.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  for (const { header, name } of central) {
    chunks.push(header, name);
    offset += header.length + name.length;
  }
  const centralSize = offset - centralStart;

  // End of central directory (PK\x05\x06)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(central.length, 8); // entries this disk
  eocd.writeUInt16LE(central.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
