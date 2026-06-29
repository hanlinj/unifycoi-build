// Image-to-PDF conversion for vendor uploads.
// Keeps every downstream artifact a PDF — extraction layer, storage layer,
// and engine tests are all PDF-only.
//
// Pipeline: imageBuffer → sharp (auto-rotate EXIF, resize) → JPEG → pdf-lib (embed) → PDF

import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

// Resize to a max of this dimension on the longest side before embedding.
// Phone photos can be 4000+ px wide; this keeps the embedded JPEG manageable
// while remaining fully legible for Vision extraction.
const MAX_IMAGE_PX = 2000;

/**
 * Convert a JPEG, PNG, or HEIC buffer into a single-page PDF.
 * Auto-rotates based on EXIF orientation (phone photos arrive in arbitrary orientations).
 * Output is a PDF buffer that passes the %PDF magic-byte sniff.
 */
export async function convertImageToPdf(imageBuffer: Buffer): Promise<Buffer> {
  // Auto-rotate + resize + normalise to JPEG for universal pdf-lib compatibility
  const jpegBuffer = await sharp(imageBuffer)
    .rotate()                                                          // auto-rotate via EXIF
    .resize(MAX_IMAGE_PX, MAX_IMAGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const meta = await sharp(jpegBuffer).metadata();
  const w = meta.width  ?? 794;
  const h = meta.height ?? 1123;

  const pdfDoc = await PDFDocument.create();
  const image  = await pdfDoc.embedJpg(jpegBuffer);
  const page   = pdfDoc.addPage([w, h]);
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });

  return Buffer.from(await pdfDoc.save());
}
