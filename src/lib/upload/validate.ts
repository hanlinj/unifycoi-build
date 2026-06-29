// Content-type validation and size enforcement for vendor document uploads.
// Validation is always by magic bytes — never by extension or Content-Type header.
// Images are accepted in addition to PDFs; callers convert them to PDF before persistence.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB (phone photos can be 8-12 MB)

// Named error strings used by both the API route and the UI.
export const ERR_FILE_SIZE = 'Files must be under 25 MB.';
export const ERR_FILE_TYPE = 'Only PDF or photo files accepted.';

export type AcceptedFileType = 'pdf' | 'jpeg' | 'png' | 'heic';

// ── Magic byte constants ───────────────────────────────────────────────────────

// PDF: %PDF at byte 0
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;
// JPEG: FF D8 FF at byte 0
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
// PNG: 89 50 4E 47 at byte 0
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
// HEIC: ISOBMFF container — bytes 4-7 are 'ftyp'; bytes 8-11 are the brand.
// The box-size prefix (bytes 0-3) is variable, so we check from offset 4.
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1']);

// ── Type detection ─────────────────────────────────────────────────────────────

export function sniffIsPdf(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return buf[0] === PDF_MAGIC[0] && buf[1] === PDF_MAGIC[1] && buf[2] === PDF_MAGIC[2] && buf[3] === PDF_MAGIC[3];
}

export function sniffIsJpeg(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  return buf[0] === JPEG_MAGIC[0] && buf[1] === JPEG_MAGIC[1] && buf[2] === JPEG_MAGIC[2];
}

export function sniffIsPng(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return buf[0] === PNG_MAGIC[0] && buf[1] === PNG_MAGIC[1] && buf[2] === PNG_MAGIC[2] && buf[3] === PNG_MAGIC[3];
}

export function sniffIsHeic(buf: Buffer): boolean {
  // Need at least 12 bytes: 4-byte size prefix + 'ftyp' + 4-byte brand
  if (buf.length < 12) return false;
  // Check 'ftyp' box marker at offset 4
  if (buf[4] !== 0x66 || buf[5] !== 0x74 || buf[6] !== 0x79 || buf[7] !== 0x70) return false;
  const brand = buf.subarray(8, 12).toString('ascii');
  return HEIC_BRANDS.has(brand);
}

/** Detect file type by magic bytes. Returns null for unrecognised formats. */
export function detectFileType(buf: Buffer): AcceptedFileType | null {
  if (sniffIsPdf(buf))  return 'pdf';
  if (sniffIsJpeg(buf)) return 'jpeg';
  if (sniffIsPng(buf))  return 'png';
  if (sniffIsHeic(buf)) return 'heic';
  return null;
}

/** Returns true when the buffer is within the allowed upload size. */
export function withinSizeLimit(buf: Buffer): boolean {
  return buf.length <= MAX_UPLOAD_BYTES;
}
