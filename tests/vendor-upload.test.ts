// Tests for image upload support: magic-byte detection and image→PDF conversion.
// Every input (JPEG, PNG, HEIC, PDF) is validated before reaching the extraction layer.
// Images are converted to a single-page PDF before BlobStore.put — the downstream
// extraction and encryption paths see only PDFs.

import sharp from 'sharp';
import {
  detectFileType,
  sniffIsPdf,
  sniffIsJpeg,
  sniffIsPng,
  sniffIsHeic,
  withinSizeLimit,
  MAX_UPLOAD_BYTES,
  ERR_FILE_TYPE,
  ERR_FILE_SIZE,
} from '@/lib/upload/validate';
import { convertImageToPdf } from '@/lib/upload/convert';

// ── Magic-byte fixtures ────────────────────────────────────────────────────────

function makePdfMagic() {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
}

function makeJpegMagic() {
  // Minimal JPEG SOI + APP0 marker
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

function makePngMagic() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function makeHeicBuf(brand: string) {
  // 4-byte box size (0x00000018 = 24) + 'ftyp' + brand + minor version
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);              // box size
  buf.write('ftyp', 4, 'ascii');         // box type
  buf.write(brand, 8, 'ascii');          // major brand (4 chars)
  buf.writeUInt32BE(0, 12);              // minor version
  return buf;
}

// ── detectFileType ────────────────────────────────────────────────────────────

describe('detectFileType', () => {
  test('PDF returns pdf', () => expect(detectFileType(makePdfMagic())).toBe('pdf'));
  test('JPEG returns jpeg', () => expect(detectFileType(makeJpegMagic())).toBe('jpeg'));
  test('PNG returns png',  () => expect(detectFileType(makePngMagic())).toBe('png'));

  test.each(['heic', 'heix', 'mif1', 'msf1'])(
    'HEIC brand %s returns heic',
    (brand) => expect(detectFileType(makeHeicBuf(brand))).toBe('heic')
  );

  test('unknown returns null', () => {
    expect(detectFileType(Buffer.from('this is not a real document'))).toBeNull();
  });
  test('empty buffer returns null', () => {
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});

// ── sniffIsJpeg ───────────────────────────────────────────────────────────────

describe('sniffIsJpeg', () => {
  test('accepts FF D8 FF header', () => expect(sniffIsJpeg(makeJpegMagic())).toBe(true));
  test('rejects PDF',             () => expect(sniffIsJpeg(makePdfMagic())).toBe(false));
  test('rejects short buffer',    () => expect(sniffIsJpeg(Buffer.from([0xff, 0xd8]))).toBe(false));
  test('rejects empty',           () => expect(sniffIsJpeg(Buffer.alloc(0))).toBe(false));
});

// ── sniffIsPng ────────────────────────────────────────────────────────────────

describe('sniffIsPng', () => {
  test('accepts 89 50 4E 47 header', () => expect(sniffIsPng(makePngMagic())).toBe(true));
  test('rejects JPEG',               () => expect(sniffIsPng(makeJpegMagic())).toBe(false));
  test('rejects 3-byte buffer',      () => expect(sniffIsPng(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false));
});

// ── sniffIsHeic ───────────────────────────────────────────────────────────────

describe('sniffIsHeic', () => {
  test.each(['heic', 'heix', 'mif1', 'msf1'])(
    'accepts brand %s',
    (brand) => expect(sniffIsHeic(makeHeicBuf(brand))).toBe(true)
  );

  test('rejects buffer without ftyp at offset 4', () => {
    const buf = makeHeicBuf('heic');
    buf.write('mp4 ', 4, 'ascii'); // corrupt the ftyp marker
    expect(sniffIsHeic(buf)).toBe(false);
  });

  test('rejects unknown brand', () => {
    const buf = makeHeicBuf('avif'); // AVIF — not in our accepted HEIC brands
    expect(sniffIsHeic(buf)).toBe(false);
  });

  test('rejects PDF', () => expect(sniffIsHeic(makePdfMagic())).toBe(false));
  test('rejects buffer shorter than 12 bytes', () => {
    expect(sniffIsHeic(Buffer.alloc(11))).toBe(false);
  });
});

// ── withinSizeLimit ───────────────────────────────────────────────────────────

describe('withinSizeLimit (25 MB cap)', () => {
  test('accepts exactly MAX_UPLOAD_BYTES', () => {
    expect(withinSizeLimit(Buffer.alloc(MAX_UPLOAD_BYTES))).toBe(true);
  });
  test('rejects one byte over MAX_UPLOAD_BYTES', () => {
    expect(withinSizeLimit(Buffer.alloc(MAX_UPLOAD_BYTES + 1))).toBe(false);
  });
  test('accepts empty buffer', () => {
    expect(withinSizeLimit(Buffer.alloc(0))).toBe(true);
  });
  test('MAX_UPLOAD_BYTES is 25 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ── Named error strings ───────────────────────────────────────────────────────

describe('named error messages', () => {
  test('ERR_FILE_TYPE names the reason', () => {
    expect(ERR_FILE_TYPE).toMatch(/PDF|photo/i);
  });
  test('ERR_FILE_SIZE names the limit', () => {
    expect(ERR_FILE_SIZE).toMatch(/25 MB/i);
  });
});

// ── convertImageToPdf ─────────────────────────────────────────────────────────

describe('convertImageToPdf', () => {
  let minJpeg: Buffer;
  let minPng: Buffer;

  beforeAll(async () => {
    minJpeg = await sharp({
      create: { width: 20, height: 30, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg({ quality: 80 }).toBuffer();

    minPng = await sharp({
      create: { width: 30, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toBuffer();
  });

  test('JPEG input produces a PDF (starts with %PDF magic)', async () => {
    const pdf = await convertImageToPdf(minJpeg);
    expect(sniffIsPdf(pdf)).toBe(true);
  });

  test('PNG input produces a PDF', async () => {
    const pdf = await convertImageToPdf(minPng);
    expect(sniffIsPdf(pdf)).toBe(true);
  });

  test('output is a non-trivially-sized buffer (not empty or truncated)', async () => {
    const pdf = await convertImageToPdf(minJpeg);
    expect(pdf.length).toBeGreaterThan(500);
  });

  test('JPEG and PNG inputs both produce non-identical PDFs (content differs)', async () => {
    const pdfJ = await convertImageToPdf(minJpeg);
    const pdfP = await convertImageToPdf(minPng);
    expect(pdfJ.equals(pdfP)).toBe(false);
  });

  test('round-trip: JPEG → PDF passes the sniffIsPdf check', async () => {
    const pdf = await convertImageToPdf(minJpeg);
    expect(detectFileType(pdf)).toBe('pdf');
  });

  test('round-trip: PNG → PDF passes the sniffIsPdf check', async () => {
    const pdf = await convertImageToPdf(minPng);
    expect(detectFileType(pdf)).toBe('pdf');
  });

  test('output is different from input (conversion actually happened)', async () => {
    const pdf = await convertImageToPdf(minJpeg);
    expect(pdf.equals(minJpeg)).toBe(false);
  });
});
