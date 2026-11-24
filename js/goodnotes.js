// GoodNotes (.goodnotes) export with real, erasable ink strokes.
//
// A .goodnotes file is a ZIP: index.notes.pb (pages), index.attachments.pb,
// index.events.pb, notes/<page-uuid> (stroke records), attachments/<uuid>
// (page background PDF). Each stroke is two length-delimited protobuf records:
//   meta: f1 uuid, f2 {f1 2, f2 rand}, f8 device id, f9 order, f14 5381, f16 version
//   data: f7 { f1 uuid, f2 AppleLZ4(TPL points), f4 RGBA, f6 '', f7 {f1 {f1 2, f2 rand}},
//              f9 '', f15 {f1 2, f2 rand}, f20 '', f21 version }
// The TPL image "vuA(v)A(S(uu))A(S(uuuu))vA(f)" holds a ballpoint stroke:
//   tool, width, flags[0,1,1..], start point, quadratic segments (cx,cy,x,y), 1, [].
// We take a real notebook exported from the user's GoodNotes as template, so
// schema version, device id and page structure match their app exactly.

import { readZip, writeZip } from './zip.js';
import { toQuads } from './geom.js';
import { uuidUpper, rand32, hexToRgb } from './util.js';

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();
const GN_PER_PT = 132 / 72;
const PT_PER_MM = 72 / 25.4;
const CLASSIC_FMT = 'vuA(v)A(S(uu))A(S(uuuu))vA(f)';
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

// ---------------------------------------------------------------- protobuf
function readVarint(u8, p) {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (p >= u8.length) throw new Error('varint truncated');
    const b = u8[p++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [v, p];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
}

/** Decode one message → fields [{num, wt, val, raw}] or null if not valid protobuf. */
export function decodeMsg(u8) {
  const out = [];
  let p = 0;
  try {
    while (p < u8.length) {
      const start = p;
      let key;
      [key, p] = readVarint(u8, p);
      const num = Number(key >> 3n);
      const wt = Number(key & 7n);
      if (num === 0) return null;
      let val;
      if (wt === 0) [val, p] = readVarint(u8, p);
      else if (wt === 1) { val = u8.subarray(p, p + 8); p += 8; }
      else if (wt === 5) { val = u8.subarray(p, p + 4); p += 4; }
      else if (wt === 2) {
        let len;
        [len, p] = readVarint(u8, p);
        const l = Number(len);
        if (p + l > u8.length) return null;
        val = u8.subarray(p, p + l);
        p += l;
      } else return null;
      if (p > u8.length) return null;
      out.push({ num, wt, val, raw: u8.subarray(start, p) });
    }
  } catch (_) {
    return null;
  }
  return out;
}

const field = (f, num) => f && f.find((x) => x.num === num);
const fieldStr = (f, num) => {
  const x = field(f, num);
  return x && x.wt === 2 ? utf8d.decode(x.val) : null;
};
const f32 = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);

export function splitDelimited(u8) {
  const recs = [];
  let p = 0;
  while (p < u8.length) {
    let len;
    [len, p] = readVarint(u8, p);
    recs.push(u8.subarray(p, p + Number(len)));
    p += Number(len);
  }
  return recs;
}

class PB {
  constructor() {
    this.parts = [];
  }
  varint(v) {
    let x = BigInt(v);
    const b = [];
    do {
      let byte = Number(x & 0x7fn);
      x >>= 7n;
      if (x > 0n) byte |= 0x80;
      b.push(byte);
    } while (x > 0n);
    this.parts.push(Uint8Array.from(b));
    return this;
  }
  key(num, wt) {
    return this.varint((num << 3) | wt);
  }
  uint(num, v) {
    return this.key(num, 0).varint(v);
  }
  bytes(num, u8) {
    this.key(num, 2).varint(u8.length);
    this.parts.push(u8);
    return this;
  }
  str(num, s) {
    return this.bytes(num, utf8.encode(s));
  }
  float(num, x) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    this.key(num, 5);
    this.parts.push(b);
    return this;
  }
  msg(num, pb) {
    return this.bytes(num, pb.finish());
  }
  raw(u8) {
    this.parts.push(u8);
    return this;
  }
  finish() {
    return concat(this.parts);
  }
}

function concat(parts) {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function joinDelimited(records) {
  const pb = new PB();
  for (const r of records) pb.varint(r.length).raw(r);
  return pb.finish();
}

// ---------------------------------------------------------------- Apple LZ4 + TPL
function lz4Block(src, outSize) {
  const dst = new Uint8Array(outSize);
  let p = 0, o = 0;
  while (p < src.length) {
    const tok = src[p++];
    let ll = tok >> 4;
    if (ll === 15) { let b; do { b = src[p++]; ll += b; } while (b === 255); }
    dst.set(src.subarray(p, p + ll), o);
    p += ll;
    o += ll;
    if (p >= src.length) break;
    const off = src[p] | (src[p + 1] << 8);
    p += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[p++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++) { dst[o] = dst[o - off]; o++; }
  }
  return dst.subarray(0, o);
}

/** Decode Apple framed LZ4 starting at `start`; returns [bytes, endPos]. */
export function appleLz4Decode(u8, start) {
  const parts = [];
  let p = start;
  for (;;) {
    const magic = utf8d.decode(u8.subarray(p, p + 4));
    p += 4;
    if (magic === 'bv4$') return [concat(parts), p];
    const dv = new DataView(u8.buffer, u8.byteOffset + p);
    if (magic === 'bv41') {
      const raw = dv.getUint32(0, true), size = dv.getUint32(4, true);
      p += 8;
      parts.push(lz4Block(u8.subarray(p, p + size), raw));
      p += size;
    } else if (magic === 'bv4-') {
      const raw = dv.getUint32(0, true);
      p += 4;
      parts.push(u8.slice(p, p + raw));
      p += raw;
    } else throw new Error('Unbekannter LZ4-Block');
  }
}

/** Valid Apple LZ4 frame holding one literal-only LZ4 block. */
function appleLz4Encode(raw) {
  const n = raw.length;
  const ext = [];
  let token;
  if (n < 15) token = n << 4;
  else {
    token = 0xf0;
    let rest = n - 15;
    while (rest >= 255) { ext.push(255); rest -= 255; }
    ext.push(rest);
  }
  const payload = concat([Uint8Array.of(token, ...ext), raw]);
  const head = new Uint8Array(12);
  head.set(utf8.encode('bv41'), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, n, true);
  dv.setUint32(8, payload.length, true);
  return concat([head, payload, utf8.encode('bv4$')]);
}

function buildClassicTpl(tool, width, start, segs, tail) {
  const nSeg = segs.length;
  const size = 8 + CLASSIC_FMT.length + 1 + 2 + 4 + (4 + 2 * (nSeg + 1)) + (4 + 8) + (4 + 16 * nSeg) + 2 + 4;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b.set(utf8.encode('tpl'), 0);
  b[3] = 0;
  dv.setUint32(4, size, true);
  b.set(utf8.encode(CLASSIC_FMT), 8);
  let p = 8 + CLASSIC_FMT.length + 1;
  dv.setUint16(p, tool, true); p += 2;
  dv.setFloat32(p, width, true); p += 4;
  dv.setUint32(p, nSeg + 1, true); p += 4;
  dv.setUint16(p, 0, true); p += 2;
  for (let i = 0; i < nSeg; i++) { dv.setUint16(p, 1, true); p += 2; }
  dv.setUint32(p, 1, true); p += 4;
  dv.setFloat32(p, start[0], true); p += 4;
  dv.setFloat32(p, start[1], true); p += 4;
  dv.setUint32(p, nSeg, true); p += 4;
  for (const s of segs) for (const v of s) { dv.setFloat32(p, v, true); p += 4; }
  dv.setUint16(p, tail, true); p += 2;
  dv.setUint32(p, 0, true); p += 4;
  return b;
}

/** Parse the classic ballpoint TPL → { tool, width, start, segs, tail } or null. */
function parseClassicTpl(t) {
  const end = t.indexOf(0, 8);
  const fmt = utf8d.decode(t.subarray(8, end));
  if (fmt !== CLASSIC_FMT) return { fmt };
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  let p = end + 1;
  const tool = dv.getUint16(p, true); p += 2;
  const width = dv.getFloat32(p, true); p += 4;
  const nFlags = dv.getUint32(p, true); p += 4;
  const flags = [];
  for (let i = 0; i < nFlags; i++) { flags.push(dv.getUint16(p, true)); p += 2; }
  const nStart = dv.getUint32(p, true); p += 4;
  const starts = [];
  for (let i = 0; i < nStart; i++) { starts.push([dv.getFloat32(p, true), dv.getFloat32(p + 4, true)]); p += 8; }
  const nSeg = dv.getUint32(p, true); p += 4;
  const segs = [];
  for (let i = 0; i < nSeg; i++) {
    segs.push([0, 1, 2, 3].map((k) => dv.getFloat32(p + k * 4, true)));
    p += 16;
  }
  const tail = dv.getUint16(p, true);
  return { fmt, tool, width, flags, starts, segs, tail };
}

/**
 * Split a parsed classic TPL into subpaths (GoodNotes units). flags: 0 = start a new
 * subpath at the next entry of starts[], anything else = next quadratic segment.
 * offset = [dx, dy] from a lasso move (data record field 6), or null.
 */
export function tplPaths(t, offset) {
  const ox = offset ? offset[0] : 0, oy = offset ? offset[1] : 0;
  const flags = t.flags && t.flags.length ? t.flags : [0, ...t.segs.map(() => 1)];
  const paths = [];
  let si = 0, gi = 0, cur = null;
  for (const f of flags) {
    if (f === 0) {
      const s = t.starts[si++];
      if (!s) break;
      cur = { start: [s[0] + ox, s[1] + oy], segs: [] };
      paths.push(cur);
    } else {
      const g = t.segs[gi++];
      if (!g || !cur) break;
      cur.segs.push([g[0] + ox, g[1] + oy, g[2] + ox, g[3] + oy]);
    }
  }
  return paths;
}

// ---------------------------------------------------------------- template
function parseStrokeData(rec) {
  const f = decodeMsg(rec);
  const f7 = field(f, 7);
  if (!f7 || f7.wt !== 2) return null;
  const inner = decodeMsg(f7.val);
  const blob = field(inner, 2);
  if (!blob || blob.wt !== 2) return null;
  const i = indexOfBytes(blob.val, utf8.encode('bv4'));
  if (i < 0) return null;
  try {
    const [tpl] = appleLz4Decode(blob.val, i);
    const color = decodeMsg(field(inner, 4)?.val || new Uint8Array());
    // Lasso-moved strokes keep their points and get a translation in field 6
    // ({f1: dx, f2: dy} as fixed32 floats); an empty string means "not moved".
    let offset = null;
    const off = field(inner, 6);
    if (off && off.wt === 2 && off.val.length) {
      const m = decodeMsg(off.val);
      const dx = field(m, 1), dy = field(m, 2);
      if (dx && dx.wt === 5 && dy && dy.wt === 5) offset = [f32(dx.val), f32(dy.val)];
    }
    return {
      offset,
      uuid: fieldStr(inner, 1),
      tpl: parseClassicTpl(tpl),
      color: color ? [1, 2, 3, 4].map((k) => (field(color, k) ? f32(field(color, k).val) : 1)) : null,
      erased: field(inner, 14)?.val === 1n,
    };
  } catch (_) {
    return null;
  }
}

function indexOfBytes(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** MediaBox (pt) of the first page; null for GoodNotes placeholder PDFs ("[0 0 0 0]"). */
function pdfMediaBox(bytes) {
  const s = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 400000)));
  const re = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;
  const m = re.exec(s);
  if (!m) return null;
  const [x0, y0, x1, y1] = m.slice(1).map(Number);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  return w > 10 && h > 10 ? { w, h } : null;
}

const isPdf = (d) => d && d[0] === 0x25 && d[1] === 0x50 && d[2] === 0x44 && d[3] === 0x46; // %PDF

/**
 * Find the paper the page really shows. index.events.pb is an append-only log:
 * paper records (type 2) name a background attachment (f4) and the size in
 * GoodNotes units (f8); page records (type 54 = create, 3 = change paper) point
 * at a paper (f3.f1). The last assignment for our page wins.
 */
function findPagePaper(eventsBytes, pageUuid) {
  const papers = new Map();
  let chosen = null, chosenAny = null;
  const prefix = pageUuid.slice(0, 8);
  for (const rec of splitDelimited(eventsBytes)) {
    const f = decodeMsg(rec);
    if (!f) continue;
    for (const x of f) {
      if (x.wt !== 2 || x.num === 1) continue;
      const inner = decodeMsg(x.val);
      if (!inner) continue;
      if (x.num === 2) {
        const id = fieldStr(inner, 2), att = fieldStr(inner, 4), size = field(inner, 8);
        const sz = size && size.wt === 2 ? decodeMsg(size.val) : null;
        const w = sz && field(sz, 1), h = sz && field(sz, 2);
        if (id && att && w && h && w.wt === 5 && h.wt === 5) papers.set(id, { att, w: f32(w.val), h: f32(h.val) });
      } else if (x.num === 54 || x.num === 3) {
        const ref = field(inner, 3);
        const refMsg = ref && ref.wt === 2 ? decodeMsg(ref.val) : null;
        const paperId = refMsg && fieldStr(refMsg, 1);
        if (!paperId) continue;
        chosenAny = paperId;
        if ((fieldStr(inner, 2) || '').startsWith(prefix)) chosen = paperId;
      }
    }
  }
  const p = papers.get(chosen || chosenAny);
  return p && p.w > 10 && p.h > 10 ? p : null;
}

/** Read a .goodnotes notebook exported from the user's app and learn its structure. */
export async function analyzeTemplate(buffer) {
  const entries = await readZip(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const need = ['index.notes.pb', 'index.events.pb', 'index.attachments.pb'];
  for (const n of need) if (!byName.has(n)) throw new Error(`Das ist keine GoodNotes-Datei (${n} fehlt).`);

  const pages = splitDelimited(byName.get('index.notes.pb').data)
    .map((r) => decodeMsg(r))
    .filter(Boolean)
    .map((f) => ({ uuid: fieldStr(f, 1), path: fieldStr(f, 2) }))
    .filter((p) => p.uuid && p.path);
  if (!pages.length) throw new Error('In der Datei wurde keine Seite gefunden.');

  const attachments = splitDelimited(byName.get('index.attachments.pb').data)
    .map((r) => decodeMsg(r))
    .filter(Boolean)
    .map((f) => ({ uuid: fieldStr(f, 1), path: fieldStr(f, 2) }))
    .filter((a) => a.uuid && a.path && byName.has(a.path));
  const page = pages[0];
  // Background PDF + size: prefer what the page's paper record says, otherwise the
  // first PDF attachment with a real MediaBox, otherwise A4.
  const paper = findPagePaper(byName.get('index.events.pb').data, page.uuid);
  let pdfAtt = null, ptSize = null;
  if (paper) {
    const a = attachments.find((x) => x.uuid === paper.att);
    if (a && isPdf(byName.get(a.path).data)) pdfAtt = a;
    ptSize = { w: paper.w / GN_PER_PT, h: paper.h / GN_PER_PT };
  }
  if (!pdfAtt) {
    for (const a of attachments) {
      const d = byName.get(a.path).data;
      const box = isPdf(d) && pdfMediaBox(d);
      if (box) {
        pdfAtt = a;
        if (!ptSize) ptSize = box;
        break;
      }
    }
  }
  if (!ptSize) ptSize = { w: 595.28, h: 841.89 };

  const noteBytes = byName.get(page.path)?.data || new Uint8Array();
  const records = splitDelimited(noteBytes);
  const dataRecs = new Map();
  records.forEach((r, i) => {
    const d = parseStrokeData(r);
    if (d && d.uuid) dataRecs.set(i, { ...d, raw: r });
  });
  const strokeIds = new Set([...dataRecs.values()].map((d) => d.uuid));
  const kept = [];
  let sampleData = null, sampleMeta = null, maxZ = 0;
  const metaById = new Map();
  records.forEach((r, i) => {
    if (dataRecs.has(i)) return;
    const f = decodeMsg(r);
    const id = fieldStr(f, 1);
    if (id && strokeIds.has(id)) {
      metaById.set(id, f);
      const z = field(f, 9);
      if (z && z.wt === 0 && Number(z.val) > maxZ) maxZ = Number(z.val);
      return; // drop old stroke meta
    }
    kept.push(r);
  });
  for (const d of dataRecs.values()) {
    if (!d.erased && d.tpl && d.tpl.fmt === CLASSIC_FMT && d.tpl.segs && d.tpl.segs.length) {
      sampleData = d;
      sampleMeta = metaById.get(d.uuid) || null;
      break;
    }
  }
  const anyMeta = sampleMeta || metaById.values().next().value || null;
  // Some GoodNotes versions give each stroke an extra element id (meta f6) that is
  // also listed in a per-page event record (f106).
  const usesElementIds = [...metaById.values()].some((f) => field(f, 6));

  // device id + schema version
  let deviceId = anyMeta && field(anyMeta, 8) ? field(anyMeta, 8).val : null;
  if (deviceId == null) deviceId = mostCommonBigVarint(byName.get('index.events.pb').data);
  const schema = byName.has('schema.pb') ? decodeMsg(byName.get('schema.pb').data) : null;
  let version = anyMeta && field(anyMeta, 16) ? Number(field(anyMeta, 16).val) : null;
  if (version == null) version = schema && field(schema, 1) ? Number(field(schema, 1).val) : 24;

  const pageMm = { w: ptSize.w / PT_PER_MM, h: ptSize.h / PT_PER_MM };
  return {
    entries,
    pageCount: pages.length,
    page,
    kept,
    removedStrokes: strokeIds.size,
    pdfAtt,
    ptSize,
    gnSize: { w: ptSize.w * GN_PER_PT, h: ptSize.h * GN_PER_PT },
    pageMm,
    deviceId,
    version,
    maxZ: maxZ || 3000000,
    usesElementIds,
    sample: sampleData
      ? {
          tool: sampleData.tpl.tool,
          tail: sampleData.tpl.tail,
          width: sampleData.tpl.width,
          color: sampleData.color,
          dataRaw: sampleData.raw,
          metaRaw: sampleMeta ? sampleMeta.map((x) => x.raw) : null,
        }
      : null,
    otherFormats: [...dataRecs.values()].filter((d) => d.tpl && d.tpl.fmt !== CLASSIC_FMT).map((d) => d.tpl.fmt),
  };
}

function mostCommonBigVarint(eventsBytes) {
  const counts = new Map();
  const visit = (u8, depth) => {
    const f = decodeMsg(u8);
    if (!f) return;
    for (const x of f) {
      if (x.wt === 0 && x.val > 2n ** 50n) counts.set(x.val, (counts.get(x.val) || 0) + 1);
      else if (x.wt === 2 && depth < 2) visit(x.val, depth + 1);
    }
  };
  for (const r of splitDelimited(eventsBytes)) visit(r, 0);
  let best = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best ?? 1000000000000000000n;
}

// ---------------------------------------------------------------- build
function patchAttachmentSize(eventsBytes, attUuid, newSize) {
  const recs = splitDelimited(eventsBytes);
  const out = recs.map((rec) => {
    const f = decodeMsg(rec);
    if (!f) return rec;
    let changed = false;
    const pb = new PB();
    for (const x of f) {
      if (x.wt === 2 && x.num !== 1) {
        const inner = decodeMsg(x.val);
        if (inner && fieldStr(inner, 1) === attUuid && inner.some((y) => y.num === 5 && y.wt === 0)) {
          const ib = new PB();
          for (const y of inner) (y.num === 5 && y.wt === 0 ? ib.uint(5, newSize) : ib.raw(y.raw));
          pb.msg(x.num, ib);
          changed = true;
          continue;
        }
      }
      pb.raw(x.raw);
    }
    return changed ? pb.finish() : rec;
  });
  return joinDelimited(out);
}

// Replace the page's element list (event f106) with our new strokes.
function rewriteElementList(eventsBytes, pageUuid, elements) {
  const recs = splitDelimited(eventsBytes);
  const out = recs.map((rec) => {
    const f = decodeMsg(rec);
    const list = f && field(f, 106);
    if (!list || list.wt !== 2) return rec;
    const inner = decodeMsg(list.val);
    if (!inner || fieldStr(inner, 1) !== pageUuid) return rec;
    const ib = new PB();
    let wrote = false;
    for (const y of inner) {
      if (y.num === 2) {
        if (!wrote) {
          for (const [id, clock] of elements) ib.msg(2, new PB().str(1, id).msg(2, new PB().uint(1, 2).uint(2, clock)));
          wrote = true;
        }
        continue;
      }
      if (!wrote && y.num > 2) {
        for (const [id, clock] of elements) ib.msg(2, new PB().str(1, id).msg(2, new PB().uint(1, 2).uint(2, clock)));
        wrote = true;
      }
      ib.raw(y.raw);
    }
    const pb = new PB();
    for (const x of f) (x.num === 106 ? pb.msg(106, ib) : pb.raw(x.raw));
    return pb.finish();
  });
  return joinDelimited(out);
}

/** Copy a decoded message, replacing fields via fns[num](field) → PB | null (drop). */
function rewrite(fields, fns) {
  const pb = new PB();
  for (const x of fields) {
    const fn = fns[x.num];
    if (!fn) {
      pb.raw(x.raw);
      continue;
    }
    const out = fn(x);
    if (out) pb.raw(out.finish());
  }
  return pb;
}

/** Clock message {f1 counter?, f2 random}: keep f1 as in the template, set f2. */
function setClock(u8, value) {
  const m = decodeMsg(u8) || [];
  const pb = rewrite(m, { 2: () => new PB().uint(2, value) });
  if (!field(m, 2)) pb.uint(2, value);
  return pb;
}

// Give every exported notebook its own ids (keeps relations: same prefix → same new prefix).
function remapIds(entries) {
  const map = new Map();
  const hex = () => rand32().toString(16).toUpperCase().padStart(8, '0');
  const mapPrefix = (pre) => {
    if (!map.has(pre)) map.set(pre, hex());
    return map.get(pre);
  };
  const re = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
  const latin = new TextDecoder('latin1');
  return entries.map((e) => {
    const name = e.name.replace(re, (u) => mapPrefix(u.slice(0, 8)) + u.slice(8));
    let data = e.data;
    const isPb = !e.name.startsWith('attachments/') && !e.name.endsWith('.jpg') && !e.name.endsWith('.png');
    if (isPb) {
      const s = latin.decode(e.data);
      let m;
      re.lastIndex = 0;
      data = null;
      while ((m = re.exec(s))) {
        // Only whole id strings (protobuf length byte 36 before) and paths. Ids inside
        // longer strings, e.g. GoodNotes paper names "AA27…_a4_2_2 - White", stay.
        const before = m.index ? e.data[m.index - 1] : -1;
        if (before !== 36 && before !== 0x2f) continue; // 36 = length byte, '/' = path "notes/<id>"
        if (!data) data = e.data.slice();
        const np = utf8.encode(mapPrefix(m[0].slice(0, 8)));
        data.set(np, m.index);
      }
      if (!data) data = e.data;
    }
    return { name, data };
  });
}

/**
 * @param tpl      result of analyzeTemplate
 * @param strokes  page strokes in mm (flat [x,y,p,...])
 * @param pen      { color: '#rrggbb', width: mm }
 * @param bgPdf    Uint8Array background PDF with the template's MediaBox (or null to keep)
 * @param thumb    Uint8Array JPEG thumbnail (optional)
 */
export function buildGoodnotes(tpl, strokes, pen, bgPdf, thumb, opts = {}) {
  const scale = tpl.gnSize.w / tpl.pageMm.w; // GoodNotes units per mm
  // TPL width = full line diameter in GoodNotes units. Evidence: the user's own ballpoint sample
  // stores 3.118 = 0.600 mm × (132/25.4) exactly (and kaih1825/parser-for-goodnotes also treats it as
  // diameter: radius = width / 2). Same mm value as preview (render.js) and PDF (pdf.js).
  const widthGN = pen.width * scale;
  const rgbOf = (hex) => hexToRgb(hex).map((c) => c / 255);
  const penRgb = rgbOf(pen.color);
  const tool = tpl.sample ? tpl.sample.tool : 2;
  const tail = tpl.sample ? tpl.sample.tail : 1;
  const records = [...tpl.kept];
  const elements = [];
  let z = tpl.maxZ;

  for (const s of strokes) {
    const pts = s.map((v, i) => (i % 3 === 2 ? v : v * scale));
    const q = toQuads(pts);
    const id = uuidUpper();
    const r1 = rand32(), r2 = rand32();
    const elemId = tpl.usesElementIds ? uuidUpper() : null;
    if (elemId) elements.push([elemId, r1]);
    const color = new PB();
    const [r, g, b] = s.color ? rgbOf(s.color) : penRgb; // per-stroke colour (e.g. mind map branches)
    [r, g, b, 1].forEach((v, k) => v && color.float(k + 1, v)); // proto3: zeros are omitted
    const blob = appleLz4Encode(buildClassicTpl(tool, widthGN, q.start, q.segs, tail));
    const sm = tpl.sample && tpl.sample.metaRaw;
    const sd = tpl.sample && tpl.sample.dataRaw;
    let meta, data;
    if (sm && sd) {
      // Clone the user's own stroke records and swap only ids, clocks, order, ink.
      meta = rewrite(sm.map((r0) => decodeMsg(r0)[0]), {
        1: () => new PB().str(1, id),
        2: (x) => new PB().msg(2, setClock(x.val, r1)),
        6: () => (elemId ? new PB().str(6, elemId) : null),
        9: () => new PB().uint(9, ++z),
      });
      const outer = decodeMsg(sd);
      const f7 = field(outer, 7);
      const inner = rewrite(decodeMsg(f7.val), {
        1: () => new PB().str(1, id),
        2: () => new PB().bytes(2, blob),
        4: () => new PB().msg(4, color),
        6: () => new PB().str(6, ''),
        7: (x) => {
          const m = decodeMsg(x.val);
          const c = field(m, 1);
          return new PB().msg(7, rewrite(m, { 1: () => new PB().msg(1, setClock(c.val, r2)) }));
        },
        14: () => null,
        15: (x) => new PB().msg(15, setClock(x.val, r1)),
      });
      data = rewrite(outer, { 7: () => new PB().msg(7, inner) }).finish();
      meta = meta.finish();
    } else {
      const m = new PB().str(1, id).msg(2, new PB().uint(1, 2).uint(2, r1));
      if (elemId) m.str(6, elemId);
      meta = m.uint(8, tpl.deviceId).uint(9, ++z).uint(14, 5381).uint(16, tpl.version).finish();
      const inner = new PB()
        .str(1, id)
        .bytes(2, blob)
        .msg(4, color)
        .str(6, '')
        .msg(7, new PB().msg(1, new PB().uint(1, 2).uint(2, r2)))
        .str(9, '')
        .msg(15, new PB().uint(1, 2).uint(2, r1))
        .str(20, '')
        .uint(21, tpl.version);
      data = new PB().msg(7, inner).finish();
    }
    records.push(meta, data);
  }

  let entries = tpl.entries.map((e) => ({ name: e.name, data: e.data }));
  const set = (name, data) => {
    const e = entries.find((x) => x.name === name);
    if (e) e.data = data;
    else entries.push({ name, data });
  };
  set(tpl.page.path, joinDelimited(records));
  if (bgPdf && tpl.pdfAtt) {
    set(tpl.pdfAtt.path, bgPdf);
    const ev = entries.find((x) => x.name === 'index.events.pb');
    ev.data = patchAttachmentSize(ev.data, tpl.pdfAtt.uuid, bgPdf.length);
  }
  if (tpl.usesElementIds) {
    const ev = entries.find((x) => x.name === 'index.events.pb');
    ev.data = rewriteElementList(ev.data, tpl.page.uuid, elements);
  }
  if (thumb && entries.some((e) => e.name === 'thumbnail.jpg')) set('thumbnail.jpg', thumb);
  if (opts.remap !== false) entries = remapIds(entries);
  return writeZip(entries, 'application/octet-stream');
}

/**
 * Read every page of a notebook: classic ballpoint strokes (GoodNotes units, with
 * lasso offset applied in `paths`), the number of strokes in other formats
 * (fountain pen, pencil, highlighter …) and the MediaBox (pt) of the first PDF
 * background, so callers can map GoodNotes units back to the PDF they imported.
 */
export async function readNotebook(buffer) {
  const entries = await readZip(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (!byName.has('index.notes.pb')) throw new Error('Das ist keine GoodNotes-Datei (index.notes.pb fehlt).');
  const pages = splitDelimited(byName.get('index.notes.pb').data)
    .map((r) => decodeMsg(r))
    .filter(Boolean)
    .map((f) => ({ uuid: fieldStr(f, 1), path: fieldStr(f, 2) }))
    .filter((p) => p.uuid && p.path);
  let mediaBox = null;
  const paper = pages[0] && byName.has('index.events.pb') ? findPagePaper(byName.get('index.events.pb').data, pages[0].uuid) : null;
  if (paper) mediaBox = { w: paper.w / GN_PER_PT, h: paper.h / GN_PER_PT };
  else if (byName.has('index.attachments.pb')) {
    for (const r of splitDelimited(byName.get('index.attachments.pb').data)) {
      const f = decodeMsg(r);
      const path = f && fieldStr(f, 2);
      const d = path && byName.get(path)?.data;
      if (d && d[0] === 0x25 && d[1] === 0x50 && d[2] === 0x44 && d[3] === 0x46) {
        mediaBox = pdfMediaBox(d);
        if (mediaBox) break;
      }
    }
  }
  return {
    mediaBox,
    pages: pages.map((p) => {
      const recs = splitDelimited(byName.get(p.path)?.data || new Uint8Array());
      const strokes = [];
      let other = 0;
      for (const r of recs) {
        const d = parseStrokeData(r);
        if (!d || d.erased || !d.tpl) continue;
        if (d.tpl.fmt !== CLASSIC_FMT) other++;
        else if (d.tpl.segs) strokes.push({ ...d.tpl, color: d.color, uuid: d.uuid, offset: d.offset, paths: tplPaths(d.tpl, d.offset) });
      }
      return { ...p, strokes, other };
    }),
  };
}

/** Read back classic ballpoint strokes of every page (GoodNotes units) – used for checks/import. */
export async function readStrokes(buffer) {
  return (await readNotebook(buffer)).pages;
}

/**
 * Test set to find out which step GoodNotes rejects (each file adds one step):
 * A = template only re-zipped, B = A + new ids, C = A + strokes, D = full export.
 */
export function diagnosticFiles(tpl, strokes, pen, bgPdf, thumb) {
  const raw = tpl.entries.map((e) => ({ name: e.name, data: e.data }));
  return [
    ['A-nur-neu-verpackt', writeZip(raw, 'application/octet-stream')],
    ['B-neue-IDs', writeZip(remapIds(raw), 'application/octet-stream')],
    ['C-mit-Strichen', buildGoodnotes(tpl, strokes, pen, null, null, { remap: false })],
    ['D-kompletter-Export', buildGoodnotes(tpl, strokes, pen, bgPdf, thumb)],
  ];
}

export { UUID_RE };
