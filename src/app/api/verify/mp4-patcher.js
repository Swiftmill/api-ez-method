// mp4-patcher.js — Cœur de l'algorithme EZ Method déplacé côté serveur
// Reçoit le bloc moov, applique les patches et renvoie le bloc moov modifié.

'use strict';

const FAKE_SAMPLE = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
const FAKE_NUM = 20;
const FAKE_DEN = 3;

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'dinf', 'ilst', 'meta', 'edts']);
const STRIP_BOXES = new Set(['free', 'skip', 'uuid']);

// ─── Binaire (big-endian) ──────────────────────────────────────────────────────
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u64(b, o) { return Number((BigInt(u32(b, o)) << 32n) | BigInt(u32(b, o + 4))); }
function w32(v) { const b = new Uint8Array(4); b[0] = (v >>> 24) & 255; b[1] = (v >>> 16) & 255; b[2] = (v >>> 8) & 255; b[3] = v & 255; return b; }
function w64(v) { const b = new Uint8Array(8); const x = BigInt(v); b.set(w32(Number(x >> 32n)), 0); b.set(w32(Number(x & 0xFFFFFFFFn)), 4); return b; }

function box(type, content) {
    const out = new Uint8Array(content.length + 8);
    out.set(w32(content.length + 8), 0);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(content, 8);
    return out;
}
function boxType(b, o) { return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]); }
function concatBuffers(arrs) {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Uint8Array(n); let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
}

// ─── Parser MP4 ────────────────────────────────────────────────────────────────
function parseBoxes(buf, start, end) {
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = u32(buf, pos), header = 8;
        if (size === 1) { if (pos + 16 > end) break; size = u64(buf, pos + 8); header = 16; }
        else if (size === 0) { size = end - pos; }
        if (!size || pos + size > end) break;
        const type = boxType(buf, pos);
        const node = { type, start: pos, end: pos + size, size, header, children: null };
        let cs = pos + header;
        if (type === 'meta') cs += 4;
        if (CONTAINERS.has(type) && cs < pos + size) node.children = parseBoxes(buf, cs, pos + size);
        boxes.push(node);
        pos += size;
    }
    return boxes;
}
function raw(buf, n) { return buf.subarray(n.start, n.end); }
function payload(buf, n) { return buf.subarray(n.start + n.header, n.end); }
function findChild(parent, type) {
    if (!parent.children) return null;
    return parent.children.find(c => c.type === type) || null;
}
function childPath(root, path) { let n = root; for (const t of path) { n = findChild(n, t); if (!n) return null; } return n; }
function isVideoTrak(buf, trak) {
    const hdlr = childPath(trak, ['mdia', 'hdlr']);
    if (!hdlr) return false;
    const p = payload(buf, hdlr);
    return String.fromCharCode(p[8], p[9], p[10], p[11]) === 'vide';
}
function findStbl(trak) { return childPath(trak, ['mdia', 'minf', 'stbl']); }
function stszInfo(buf, stsz) { const p = payload(buf, stsz); return { sampleSize: u32(p, 4), count: u32(p, 8) }; }

// ─── Patchs ──────────────────────────────────────────────────────────────────
function patchMdhdLang(buf, node) {
    const p = payload(buf, node);
    const out = new Uint8Array(p.length);
    out.set(p);
    const version = out[0];
    const langOff = (version === 1) ? 32 : 20;
    if (langOff + 2 <= out.length) { out[langOff] = 0x55; out[langOff + 1] = 0xC4; }
    return box('mdhd', out);
}

function patchHdlrName(buf, node) {
    const p = payload(buf, node);
    const handler = String.fromCharCode(p[8], p[9], p[10], p[11]);
    let name;
    if (handler === 'vide') name = 'VideoHandler';
    else if (handler === 'soun') name = 'SoundHandler';
    else return box('hdlr', p);
    const head = p.subarray(0, 24);
    const nameBytes = new TextEncoder().encode(name);
    return box('hdlr', concatBuffers([head, nameBytes, new Uint8Array([0])]));
}

function patchStsz(buf, node, fakeCount) {
    if (fakeCount < 1) return raw(buf, node);
    const p = payload(buf, node);
    const head = p.subarray(0, 4);
    const sampleSize = u32(p, 4);
    const count = u32(p, 8);
    const sizes = [];
    if (sampleSize !== 0) {
        for (let i = 0; i < count; i++) sizes.push(sampleSize);
    } else {
        for (let i = 0, off = 12; i < count && off + 4 <= p.length; i++, off += 4) sizes.push(u32(p, off));
    }
    for (let i = 0; i < fakeCount; i++) sizes.push(8);

    const out = new Uint8Array(12 + sizes.length * 4);
    out.set(head, 0);
    out.set(w32(0), 4);
    out.set(w32(sizes.length), 8);
    for (let i = 0; i < sizes.length; i++) out.set(w32(sizes[i]), 12 + i * 4);
    return box('stsz', out);
}

function patchStsc(buf, node, chunkCount) {
    if (chunkCount < 1) return raw(buf, node);
    const p = payload(buf, node);
    const head = p.subarray(0, 4);
    const count = u32(p, 4);
    const entries = [];
    for (let i = 0, off = 8; i < count && off + 12 <= p.length; i++, off += 12) {
        entries.push([u32(p, off), u32(p, off + 4), u32(p, off + 8)]);
    }
    const lastSDI = entries.length ? entries[entries.length - 1][2] : 1;
    entries.push([chunkCount + 1, 1, lastSDI]);

    const out = new Uint8Array(8 + entries.length * 12);
    out.set(head, 0);
    out.set(w32(entries.length), 4);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        out.set(w32(e[0]), 8 + i * 12);
        out.set(w32(e[1]), 8 + i * 12 + 4);
        out.set(w32(e[2]), 8 + i * 12 + 8);
    }
    return box('stsc', out);
}

function patchStco(buf, node, displacement, fakeOffset, fakeCount) {
    const p = payload(buf, node);
    const head = p.subarray(0, 4);
    const count = u32(p, 4);
    const offs = [];
    for (let i = 0, off = 8; i < count && off + 4 <= p.length; i++, off += 4) {
        offs.push((u32(p, off) + displacement) >>> 0);
    }
    for (let i = 0; i < fakeCount; i++) offs.push(fakeOffset >>> 0);

    const out = new Uint8Array(8 + offs.length * 4);
    out.set(head, 0);
    out.set(w32(offs.length), 4);
    for (let i = 0; i < offs.length; i++) out.set(w32(offs[i]), 8 + i * 4);
    return box('stco', out);
}

function patchCo64(buf, node, displacement, fakeOffset, fakeCount) {
    const p = payload(buf, node);
    const head = p.subarray(0, 4);
    const count = u32(p, 4);
    const offs = [];
    for (let i = 0, off = 8; i < count && off + 8 <= p.length; i++, off += 8) {
        offs.push(u64(p, off) + displacement);
    }
    for (let i = 0; i < fakeCount; i++) offs.push(fakeOffset);

    const out = new Uint8Array(8 + offs.length * 8);
    out.set(head, 0);
    out.set(w32(offs.length), 4);
    for (let i = 0; i < offs.length; i++) out.set(w64(offs[i]), 8 + i * 8);
    return box('co64', out);
}

// ─── Reconstruction recursive de l'arbre ─────────────────────────────────────
function rebuildBox(buf, node, displacement, fakeOffset, fakeCount, videoTrak, chunkCount, curTrak) {
    const t = node.type;

    if (STRIP_BOXES.has(t)) return null;
    if (t === 'mdhd') return patchMdhdLang(buf, node);
    if (t === 'hdlr') return patchHdlrName(buf, node);

    const inVideo = (curTrak === videoTrak);

    if (inVideo && t === 'stsz') return patchStsz(buf, node, fakeCount);
    if (inVideo && t === 'stts') return raw(buf, node);
    if (inVideo && t === 'stsc' && fakeCount > 0) return patchStsc(buf, node, chunkCount);
    if (t === 'stco') return patchStco(buf, node, displacement, fakeOffset, fakeCount);
    if (t === 'co64') return patchCo64(buf, node, displacement, fakeOffset, fakeCount);

    if (node.children) {
        const parts = [];
        if (t === 'meta') parts.push(payload(buf, node).subarray(0, 4)); // version+flags
        for (const child of node.children) {
            const prevTrak = curTrak;
            let nextTrak = curTrak;
            if (child.type === 'trak') nextTrak = child;
            const rebuilt = rebuildBox(buf, child, displacement, fakeOffset, fakeCount, videoTrak, chunkCount, nextTrak);
            if (rebuilt) parts.push(rebuilt);
        }
        return box(t, concatBuffers(parts));
    }

    return raw(buf, node);
}

// ─── Fonction d'entrée principale du serveur ──────────────────────────────────
export function patchMoov(moovBuffer, otherBoxesSizeBeforeMdat, mdatStart, mdatEnd) {
    const moovBuf = new Uint8Array(moovBuffer);
    
    // Parser le bloc moov
    const boxes = parseBoxes(moovBuf, 0, moovBuf.length);
    const moovNode = boxes.find(b => b.type === 'moov');
    if (!moovNode) throw new Error('Bloc moov introuvable dans les données reçues');

    // Recherche de la piste vidéo
    const traks = (moovNode.children || []).filter(b => b.type === 'trak');
    const videoTrak = traks.find(t => isVideoTrak(moovBuf, t));
    if (!videoTrak) throw new Error('Pas de piste vidéo dans le bloc moov');

    const stbl = findStbl(videoTrak);
    const stsz = stbl && findChild(stbl, 'stsz');
    const stsc = stbl && findChild(stbl, 'stsc');
    const stco = stbl && (findChild(stbl, 'stco') || findChild(stbl, 'co64'));
    if (!stsz || !stsc || !stco) throw new Error('Tables stsz/stsc/stco manquantes');

    // Calcul de fakeCount
    const info = stszInfo(moovBuf, stsz);
    const target = Math.floor(info.count * FAKE_NUM / FAKE_DEN);
    const fakeCount = Math.max(0, target - info.count);

    // Nombre de chunks existants
    const chunkCount = u32(payload(moovBuf, stco), 4);

    const rebuild = (disp, fakeOff) =>
        rebuildBox(moovBuf, moovNode, disp, fakeOff, fakeCount, videoTrak, chunkCount, null);

    // Passe 1 : Mesurer la croissance
    const tempMoov = rebuild(0, 0);
    
    // Passe 2 : Calculer le déplacement réel
    const displacement = otherBoxesSizeBeforeMdat + tempMoov.length - mdatStart;
    const fakeOffset = mdatEnd + displacement;

    // Passe finale : Reconstruire le moov définitif avec les bons offsets
    const finalMoov = rebuild(displacement, fakeOffset);

    return {
        patchedMoov: finalMoov,
        fakeCount: fakeCount
    };
}
