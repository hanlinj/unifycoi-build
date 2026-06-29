// Content-type validation and size enforcement for vendor document uploads.
// All vendor documents (COI, W-9, ACH) must be PDFs.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// PDF magic: first 4 bytes are 0x25 0x50 0x44 0x46 ("%PDF")
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

/** Content-type detection by magic bytes — ignores filename extension and Content-Type header. */
export function sniffIsPdf(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return (
    buf[0] === PDF_MAGIC[0] &&
    buf[1] === PDF_MAGIC[1] &&
    buf[2] === PDF_MAGIC[2] &&
    buf[3] === PDF_MAGIC[3]
  );
}

/** Returns true when the buffer is within the allowed upload size. */
export function withinSizeLimit(buf: Buffer): boolean {
  return buf.length <= MAX_UPLOAD_BYTES;
}
