/*
 * image-metadata-cleaner - lossless metadata/provenance stripping for JPEG, PNG and WebP.
 *
 * Zero dependencies. Runs in the browser (index.html) and in Node (cli.js, tests).
 *
 * What it removes: metadata container segments/chunks - EXIF, XMP, C2PA
 * Content Credentials (JPEG APP11 JUMBF, PNG caBX, WebP EXIF/XMP chunks),
 * Photoshop IRB, comments and other ancillary records.
 *
 * What it preserves: every pixel-carrying byte is copied verbatim (JPEG scan
 * data, PNG IDAT, WebP VP8/VP8L/VP8X image chunks), plus color-management
 * records (ICC profiles, PNG iCCP/sRGB/gAMA/cHRM) so the image renders the
 * same. Removing a metadata container never touches compressed pixel data.
 *
 * What it cannot do: invisible watermarks embedded in the pixels themselves
 * (for example Google DeepMind's SynthID, which OpenAI states is embedded in
 * ChatGPT-generated images) are part of the image data and are NOT removed.
 * See README.md for the sourced distinction.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ImageMetadataCleaner = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class CleanError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CleanError';
    }
  }

  function ascii(b, off, len) {
    let s = '';
    for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function u32be(b, off) {
    return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
  }

  function u32le(b, off) {
    return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
  }

  function u16be(b, off) {
    return (b[off] << 8) | b[off + 1];
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  function detectFormat(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
      return 'png';
    }
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    throw new CleanError('Unsupported file: expected a JPEG, PNG or WebP image.');
  }

  /* ----------------------------- JPEG ----------------------------- */

  // APPn segments that stay: APP0 carries JFIF version/density, APP2 the ICC
  // color profile, APP14 the Adobe color transform. Everything else in the
  // APP range can carry provenance or tool metadata and is removed.
  const JPEG_KEEP_APP = {
    0xe0: 'APP0 (JFIF header)',
    0xe2: 'APP2 (ICC color profile)',
    0xee: 'APP14 (Adobe color transform)',
  };

  const JPEG_MARKER_NAMES = {
    0xc0: 'SOF0 (baseline frame header)', 0xc1: 'SOF1', 0xc2: 'SOF2 (progressive frame header)',
    0xc4: 'DHT (Huffman table)', 0xdb: 'DQT (quantization table)',
    0xdd: 'DRI (restart interval)', 0xda: 'SOS (start of scan)',
  };

  function describeAppSegment(marker, seg) {
    const label = 'APP' + (marker - 0xe0);
    const head = ascii(seg, 4, 32);
    if (marker === 0xe1) {
      if (head.indexOf('Exif') === 0) return label + ' (EXIF metadata)';
      if (head.indexOf('http://ns.adobe.com/xap/1.0/') === 0) return label + ' (XMP metadata)';
      return label + ' (metadata)';
    }
    if (marker === 0xeb) {
      if (ascii(seg, 4, 2) === 'JP') {
        return label + ' (JUMBF box, used for C2PA Content Credentials)';
      }
      return label + ' (JPEG extension data)';
    }
    if (marker === 0xed && head.indexOf('Photoshop 3.0') === 0) return label + ' (Photoshop IRB metadata)';
    return label + ' (application metadata)';
  }

  function cleanJpeg(b) {
    const parts = [b.slice(0, 2)];
    const removed = [];
    const kept = ['SOI'];
    let scanBytes = 0;
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) throw new CleanError('Malformed JPEG: expected a marker at byte ' + i + '.');
      let j = i;
      while (j < b.length && b[j] === 0xff) j++; // marker fill bytes
      if (j >= b.length) throw new CleanError('Malformed JPEG: truncated marker.');
      const marker = b[j];
      if (marker === 0xd8) throw new CleanError('Malformed JPEG: unexpected second SOI marker.');
      if (marker === 0xd9) { // EOI without scan: copy through and stop
        parts.push(b.slice(i, j + 1));
        i = j + 1;
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // TEM / RSTn: no length field
        parts.push(b.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (j + 3 > b.length) throw new CleanError('Malformed JPEG: truncated segment length.');
      const len = u16be(b, j + 1);
      if (len < 2 || j + 1 + len > b.length) {
        throw new CleanError('Malformed JPEG: segment length out of range at byte ' + i + '.');
      }
      const seg = b.slice(i, j + 1 + len);
      if (marker === 0xda) {
        // Start of scan: the entropy-coded pixel data and everything after it
        // is copied byte-for-byte. This is the quality guarantee.
        parts.push(b.slice(i));
        scanBytes = b.length - i;
        kept.push('SOS + scan data (' + scanBytes + ' bytes, copied verbatim)');
        i = b.length;
        break;
      }
      if (marker >= 0xe0 && marker <= 0xef) {
        if (JPEG_KEEP_APP[marker]) {
          parts.push(seg);
          kept.push(JPEG_KEEP_APP[marker]);
        } else {
          removed.push({ name: describeAppSegment(marker, seg), bytes: seg.length });
        }
      } else if (marker === 0xfe) {
        removed.push({ name: 'COM (comment)', bytes: seg.length });
      } else {
        parts.push(seg);
        kept.push(JPEG_MARKER_NAMES[marker] || 'marker 0xFF' + marker.toString(16).toUpperCase());
      }
      i = j + 1 + len;
    }
    if (scanBytes === 0) throw new CleanError('Malformed JPEG: no image scan found.');
    if (i < b.length) {
      // Trailing bytes after EOI are not part of the image; drop them.
      removed.push({ name: 'trailing bytes after end of image', bytes: b.length - i });
    }
    return { data: concat(parts), removed, kept };
  }

  /* ----------------------------- PNG ------------------------------ */

  // Ancillary chunks that stay because they affect how pixels render
  // (color, transparency, physical size). Every other ancillary chunk is a
  // metadata carrier and is removed: tEXt, zTXt, iTXt, eXIf, caBX (C2PA),
  // tIME, and anything unknown.
  const PNG_KEEP_ANCILLARY = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS', 'bKGD', 'sBIT']);

  const PNG_LABELS = {
    IHDR: 'IHDR (image header)', PLTE: 'PLTE (palette)', IDAT: 'IDAT (pixel data)',
    IEND: 'IEND (end)', iCCP: 'iCCP (ICC color profile)', sRGB: 'sRGB (color space)',
    gAMA: 'gAMA (gamma)', cHRM: 'cHRM (chromaticity)', pHYs: 'pHYs (pixel dimensions)',
    tRNS: 'tRNS (transparency)', bKGD: 'bKGD (background)', sBIT: 'sBIT (significant bits)',
    tEXt: 'tEXt (text metadata)', zTXt: 'zTXt (compressed text metadata)',
    iTXt: 'iTXt (international text metadata)', eXIf: 'eXIf (EXIF metadata)',
    caBX: 'caBX (C2PA Content Credentials)', tIME: 'tIME (timestamp)',
  };

  function cleanPng(b) {
    const parts = [b.slice(0, 8)];
    const removed = [];
    const kept = ['PNG signature'];
    let i = 8;
    let sawIend = false;
    while (i < b.length) {
      if (i + 8 > b.length) throw new CleanError('Malformed PNG: truncated chunk header.');
      const len = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      const end = i + 12 + len;
      if (end > b.length) throw new CleanError('Malformed PNG: chunk "' + type + '" overruns the file.');
      const chunk = b.slice(i, end);
      const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
      if (critical || PNG_KEEP_ANCILLARY.has(type)) {
        parts.push(chunk);
        kept.push(PNG_LABELS[type] || type);
      } else {
        removed.push({ name: PNG_LABELS[type] || type + ' (ancillary chunk)', bytes: chunk.length });
      }
      i = end;
      if (type === 'IEND') { sawIend = true; break; }
    }
    if (!sawIend) throw new CleanError('Malformed PNG: no IEND chunk found.');
    if (i < b.length) {
      removed.push({ name: 'trailing bytes after IEND', bytes: b.length - i });
    }
    return { data: concat(parts), removed, kept };
  }

  /* ----------------------------- WebP ----------------------------- */

  // RIFF container: image chunks stay, metadata chunks go. VP8X feature flags
  // for EXIF (0x08) and XMP (0x04) are cleared when those chunks are removed;
  // the ICC flag (0x20) is kept because the ICC profile stays.
  const WEBP_REMOVE = { EXIF: 'EXIF (EXIF metadata)', 'XMP ': 'XMP (XMP metadata)' };
  const WEBP_LABELS = {
    VP8X: 'VP8X (extended header)', VP8: 'VP8 (lossy pixel data)',
    VP8L: 'VP8L (lossless pixel data)', ICCP: 'ICCP (ICC color profile)',
    ALPH: 'ALPH (alpha channel)', ANIM: 'ANIM (animation)', ANMF: 'ANMF (animation frame)',
  };

  function cleanWebp(b) {
    const chunks = [];
    const removed = [];
    const kept = [];
    let i = 12;
    while (i + 8 <= b.length) {
      const fourcc = ascii(b, i, 4);
      const size = u32le(b, i + 4);
      const end = i + 8 + size + (size & 1); // chunks are padded to even sizes
      if (end > b.length) throw new CleanError('Malformed WebP: chunk "' + fourcc + '" overruns the file.');
      const chunk = b.slice(i, end);
      if (WEBP_REMOVE[fourcc]) {
        removed.push({ name: WEBP_REMOVE[fourcc], bytes: chunk.length });
      } else {
        chunks.push(chunk);
        kept.push(WEBP_LABELS[fourcc] || fourcc);
      }
      i = end;
    }
    // Clear EXIF/XMP feature bits in VP8X when those chunks were dropped.
    let cleared = [];
    for (let c = 0; c < chunks.length; c++) {
      if (ascii(chunks[c], 0, 4) === 'VP8X') {
        const flagsOff = 8; // fourcc(4) + size(4)
        const flags = chunks[c][flagsOff];
        let next = flags;
        if (removed.some((r) => r.name.indexOf('EXIF') === 0)) next &= ~0x08;
        if (removed.some((r) => r.name.indexOf('XMP') === 0)) next &= ~0x04;
        if (next !== flags) {
          const copy = chunks[c].slice();
          copy[flagsOff] = next;
          chunks[c] = copy;
          if (flags & 0x08) cleared.push('EXIF');
          if (flags & 0x04) cleared.push('XMP');
        }
        break;
      }
    }
    const body = concat(chunks);
    const out = new Uint8Array(12 + body.length);
    out.set(b.slice(0, 12)); // 'RIFF' + size + 'WEBP'
    out[4] = (4 + body.length) & 0xff;
    out[5] = ((4 + body.length) >> 8) & 0xff;
    out[6] = ((4 + body.length) >> 16) & 0xff;
    out[7] = ((4 + body.length) >> 24) & 0xff;
    out.set(body, 12);
    if (cleared.length) kept.push('VP8X flags updated (cleared: ' + cleared.join(', ') + ')');
    return { data: out, removed, kept };
  }

  /* ---------------------------- public ---------------------------- */

  /**
   * Strip metadata from a JPEG, PNG or WebP image.
   * @param {Uint8Array} bytes raw file contents
   * @returns {{data: Uint8Array, report: {format: string, removed: Array,
   *   kept: string[], inputBytes: number, outputBytes: number}}}
   */
  function cleanImage(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const format = detectFormat(bytes);
    const result = format === 'jpeg' ? cleanJpeg(bytes) : format === 'png' ? cleanPng(bytes) : cleanWebp(bytes);
    let removedBytes = 0;
    for (const r of result.removed) removedBytes += r.bytes;
    return {
      data: result.data,
      report: {
        format,
        removed: result.removed,
        kept: result.kept,
        removedBytes,
        inputBytes: bytes.length,
        outputBytes: result.data.length,
      },
    };
  }

  return { cleanImage, detectFormat, CleanError };
});
