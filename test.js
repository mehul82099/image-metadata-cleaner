'use strict';
/*
 * Tests for image-metadata-cleaner. Every fixture is built byte-by-byte in
 * this file, so the tests assert exactly which container bytes are removed
 * and prove the pixel-carrying bytes survive verbatim.
 *
 * Run: node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanImage, detectFormat, CleanError } = require('./cleaner.js');

/* ------------------------- fixture helpers ------------------------- */

function bytes(...vals) {
  return Uint8Array.from(vals);
}

function cat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function str(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// CRC32 (PNG chunk CRCs), table-free implementation is fine for fixtures.
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16be(n) { return bytes((n >> 8) & 0xff, n & 0xff); }
function u32be(n) { return bytes((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff); }
function u32le(n) { return bytes(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); }

function jpegSegment(marker, payload) {
  return cat(bytes(0xff, marker), u16be(payload.length + 2), payload);
}

function buildJpeg({ withMetadata = true } = {}) {
  const parts = [bytes(0xff, 0xd8)]; // SOI
  parts.push(jpegSegment(0xe0, str('JFIF\0\x01\x02\x00\0\x01\0\x01\0\0'))); // APP0
  if (withMetadata) {
    parts.push(jpegSegment(0xe1, cat(str('Exif\0\0'), bytes(1, 2, 3, 4, 5)))); // APP1 EXIF
    parts.push(jpegSegment(0xe1, str('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'))); // APP1 XMP
    // APP11 JUMBF carrying a C2PA claim, as ChatGPT/C2PA images use
    parts.push(jpegSegment(0xeb, cat(str('JP'), u32be(24), str('jumb'), str('urn:c2pa:claim'))));
    parts.push(jpegSegment(0xed, str('Photoshop 3.0\x008BIM\x04\x04'))); // APP13
    parts.push(jpegSegment(0xfe, str('a comment'))); // COM
  }
  parts.push(jpegSegment(0xe2, str('ICC_PROFILE\0\x01\x01fake-icc-bytes'))); // APP2 ICC
  parts.push(jpegSegment(0xdb, bytes(0, 17, 18, 19, 20))); // DQT
  parts.push(jpegSegment(0xc0, bytes(8, 0, 1, 0, 1, 1, 1, 0x11, 0))); // SOF0 1x1
  parts.push(jpegSegment(0xc4, bytes(0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7))); // DHT
  const scan = cat(
    bytes(0xff, 0xda), u16be(8), bytes(1, 1, 0, 0, 63, 0), // SOS header
    bytes(0b10101010, 0x00, 0xff, 0x00, 0x11), // fake entropy-coded data (0xFF00 = stuffed byte)
    bytes(0xff, 0xd9), // EOI
  );
  parts.push(scan);
  return { file: cat(...parts), scan };
}

function pngChunk(type, payload) {
  const body = cat(str(type), payload);
  return cat(u32be(payload.length), body, u32be(crc32(body)));
}

function buildPng({ withMetadata = true } = {}) {
  const sig = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = pngChunk('IHDR', cat(u32be(1), u32be(1), bytes(8, 2, 0, 0, 0)));
  const parts = [sig, ihdr];
  if (withMetadata) {
    parts.push(pngChunk('tEXt', str('Software\0ChatGPT')));
    parts.push(pngChunk('iTXt', str('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')));
    parts.push(pngChunk('eXIf', bytes(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0)));
    parts.push(pngChunk('caBX', str('fake-c2pa-jumbf')));
    parts.push(pngChunk('tIME', bytes(0x07, 0xea, 11, 9, 12, 0, 0)));
  }
  parts.push(pngChunk('iCCP', cat(str('icc\0'), bytes(0, 9, 9, 9))));
  parts.push(pngChunk('pHYs', cat(u32be(2835), u32be(2835), bytes(1))));
  const idat = pngChunk('IDAT', bytes(0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf0, 0, 0, 0, 4, 0, 1));
  parts.push(idat);
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return { file: cat(...parts), idat };
}

function webpChunk(fourcc, payload) {
  const pad = payload.length & 1 ? bytes(0) : new Uint8Array(0);
  return cat(str(fourcc), u32le(payload.length), payload, pad);
}

function buildWebp({ withMetadata = true, flags = 0x2c } = {}) {
  // flags default: ICC (0x20) + EXIF (0x08) + XMP (0x04)
  const vp8x = webpChunk('VP8X', cat(bytes(flags, 0, 0, 0), bytes(0, 0, 0, 0, 0, 0)));
  const parts = [vp8x];
  parts.push(webpChunk('ICCP', bytes(1, 2, 3, 4)));
  if (withMetadata) {
    parts.push(webpChunk('EXIF', bytes(0x49, 0x49, 0x2a, 0, 5, 6, 7))); // odd size: exercises padding
    parts.push(webpChunk('XMP ', str('<x:xmpmeta>c2pa</x:xmpmeta>')));
  }
  const vp8l = webpChunk('VP8L', bytes(0x2f, 0, 0, 0, 0x88, 0x88, 0x08));
  parts.push(vp8l);
  const body = cat(...parts);
  return { file: cat(str('RIFF'), u32le(4 + body.length), str('WEBP'), body), vp8l };
}

function findSubarray(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/* ----------------------------- tests ----------------------------- */

test('detects formats and rejects unknown data', () => {
  assert.equal(detectFormat(buildJpeg().file), 'jpeg');
  assert.equal(detectFormat(buildPng().file), 'png');
  assert.equal(detectFormat(buildWebp().file), 'webp');
  assert.throws(() => detectFormat(str('not an image at all')), CleanError);
});

test('jpeg: removes EXIF, XMP, C2PA-JUMBF, Photoshop IRB and COM', () => {
  const { file } = buildJpeg();
  const { report } = cleanImage(file);
  const names = report.removed.map((r) => r.name).join(' | ');
  assert.match(names, /APP1 \(EXIF metadata\)/);
  assert.match(names, /APP1 \(XMP metadata\)/);
  assert.match(names, /APP11 \(JUMBF box, used for C2PA Content Credentials\)/);
  assert.match(names, /APP13 \(Photoshop IRB metadata\)/);
  assert.match(names, /COM \(comment\)/);
});

test('jpeg: keeps JFIF header, ICC profile and image tables', () => {
  const { file } = buildJpeg();
  const { report } = cleanImage(file);
  for (const want of ['APP0 (JFIF header)', 'APP2 (ICC color profile)', 'DQT (quantization table)',
    'SOF0 (baseline frame header)', 'DHT (Huffman table)']) {
    assert.ok(report.kept.includes(want), 'kept should include ' + want);
  }
});

test('jpeg: scan data (pixels) is byte-identical after cleaning', () => {
  const { file, scan } = buildJpeg();
  const { data } = cleanImage(file);
  const at = findSubarray(data, scan);
  assert.notEqual(at, -1, 'scan bytes must appear verbatim in the output');
  assert.equal(at + scan.length, data.length, 'scan must run to the end of the file');
});

test('jpeg: cleaning is idempotent and a clean file round-trips unchanged', () => {
  const { file } = buildJpeg({ withMetadata: false });
  const once = cleanImage(file);
  assert.deepEqual(once.data, file, 'file without metadata must be byte-identical');
  const twice = cleanImage(cleanImage(buildJpeg().file).data);
  assert.equal(twice.report.removed.length, 0);
});

test('jpeg: output size equals input minus removed container bytes', () => {
  const { file } = buildJpeg();
  const { report } = cleanImage(file);
  assert.equal(report.inputBytes - report.outputBytes, report.removedBytes);
});

test('jpeg: truncated file raises a clean error', () => {
  const { file } = buildJpeg();
  assert.throws(() => cleanImage(file.slice(0, 20)), CleanError);
});

test('png: removes tEXt, iTXt, eXIf, caBX (C2PA) and tIME', () => {
  const { file } = buildPng();
  const { report } = cleanImage(file);
  const names = report.removed.map((r) => r.name);
  for (const want of ['tEXt (text metadata)', 'iTXt (international text metadata)',
    'eXIf (EXIF metadata)', 'caBX (C2PA Content Credentials)', 'tIME (timestamp)']) {
    assert.ok(names.includes(want), 'removed should include ' + want);
  }
});

test('png: keeps critical chunks plus color and size records', () => {
  const { file } = buildPng();
  const { report } = cleanImage(file);
  for (const want of ['IHDR (image header)', 'IDAT (pixel data)', 'IEND (end)',
    'iCCP (ICC color profile)', 'pHYs (pixel dimensions)']) {
    assert.ok(report.kept.includes(want), 'kept should include ' + want);
  }
});

test('png: IDAT chunk is byte-identical after cleaning', () => {
  const { file, idat } = buildPng();
  const { data } = cleanImage(file);
  assert.notEqual(findSubarray(data, idat), -1, 'IDAT bytes must appear verbatim');
});

test('png: clean file round-trips unchanged and cleaning is idempotent', () => {
  const { file } = buildPng({ withMetadata: false });
  const once = cleanImage(file);
  assert.deepEqual(once.data, file);
  const twice = cleanImage(cleanImage(buildPng().file).data);
  assert.equal(twice.report.removed.length, 0);
});

test('png: chunk overrunning the file raises a clean error', () => {
  const { file } = buildPng();
  const truncated = file.slice(0, file.length - 6); // cut into IEND
  assert.throws(() => cleanImage(truncated), CleanError);
});

test('webp: removes EXIF and XMP chunks and clears their VP8X flags', () => {
  const { file } = buildWebp();
  const { data, report } = cleanImage(file);
  const names = report.removed.map((r) => r.name);
  assert.ok(names.some((n) => n.indexOf('EXIF') === 0));
  assert.ok(names.some((n) => n.indexOf('XMP') === 0));
  // VP8X flags byte: ICC bit (0x20) stays, EXIF (0x08) and XMP (0x04) cleared
  assert.equal(asciiOf(data, 12, 4), 'VP8X');
  assert.equal(data[12 + 8] & 0x20, 0x20, 'ICC flag kept');
  assert.equal(data[12 + 8] & 0x08, 0, 'EXIF flag cleared');
  assert.equal(data[12 + 8] & 0x04, 0, 'XMP flag cleared');
  assert.ok(report.kept.some((k) => k.indexOf('VP8X flags updated') === 0));
});

function asciiOf(b, off, len) {
  let s = '';
  for (let i = off; i < off + len; i++) s += String.fromCharCode(b[i]);
  return s;
}

test('webp: keeps ICC profile and pixel chunk byte-identical', () => {
  const { file, vp8l } = buildWebp();
  const { data, report } = cleanImage(file);
  assert.ok(report.kept.includes('ICCP (ICC color profile)'));
  assert.notEqual(findSubarray(data, vp8l), -1, 'VP8L pixel chunk must appear verbatim');
});

test('webp: RIFF size is recomputed correctly', () => {
  const { file } = buildWebp();
  const { data } = cleanImage(file);
  const riffSize = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  assert.equal(riffSize, data.length - 8);
});

test('webp: clean file round-trips unchanged and cleaning is idempotent', () => {
  const { file } = buildWebp({ withMetadata: false, flags: 0x20 });
  const once = cleanImage(file);
  assert.deepEqual(once.data, file);
  const twice = cleanImage(cleanImage(buildWebp().file).data);
  assert.equal(twice.report.removed.length, 0);
});

test('webp: odd-sized EXIF chunk padding is handled', () => {
  const { file } = buildWebp();
  const { data, report } = cleanImage(file);
  assert.equal(report.inputBytes - report.outputBytes, report.removedBytes);
  // output re-parses without error
  cleanImage(data);
});

test('all formats: real-world shaped reports sum correctly', () => {
  for (const build of [buildJpeg, buildPng, buildWebp]) {
    const { report } = cleanImage(build().file);
    assert.ok(report.removed.length >= 2);
    assert.ok(report.outputBytes < report.inputBytes);
    assert.ok(report.outputBytes > 0);
  }
});
