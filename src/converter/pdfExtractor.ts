/**
 * Pure-JavaScript single-page PDF slicer using `pdf-lib`.
 *
 * Microsoft Graph OneNote's `<img data-render-src="name:background" />` renders
 * every page present in an attached `application/pdf` multipart part. To render
 * only the specific PDF page corresponding to a reMarkable `.rm` annotation page
 * without client-side JPEG rasterization, we extract the target 0-based `pageIndex`
 * into a standalone 1-page PDF `Uint8Array`.
 */

import { PDFDocument } from 'pdf-lib';

export interface ExtractedPdfPageResult {
  readonly pdfBytes: Uint8Array;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly isLandscape: boolean;
}

/**
 * Loads a raw PDF byte buffer into a `pdf-lib` `PDFDocument` instance that can be
 * reused across multiple page extractions for the same reMarkable document.
 */
export async function loadSourcePdfDocument(pdfBytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
}

/**
 * Extracts a single 0-based `pageIndex` from an already-loaded `PDFDocument`,
 * returning both the standalone 1-page PDF `Uint8Array` and the page's effective
 * visual dimensions in points (`widthPt`, `heightPt`, `isLandscape`).
 *
 * Returns `null` if `pageIndex` is out of bounds (`< 0` or `>= getPageCount()`).
 */
export async function extractSinglePdfPageWithMetricsFromDocument(
  sourcePdf: PDFDocument,
  pageIndex: number
): Promise<ExtractedPdfPageResult | null> {
  const totalPages = sourcePdf.getPageCount();
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= totalPages) {
    console.warn(
      `[rmOneNote] PDF page index ${pageIndex} is out of bounds (total pages: ${totalPages}).`
    );
    return null;
  }

  const sourcePage = sourcePdf.getPage(pageIndex);
  const { width, height } = sourcePage.getSize();
  const rotation = ((sourcePage.getRotation().angle % 360) + 360) % 360;
  const widthPt = rotation === 90 || rotation === 270 ? height : width;
  const heightPt = rotation === 90 || rotation === 270 ? width : height;

  const singlePagePdf = await PDFDocument.create();
  const [copiedPage] = await singlePagePdf.copyPages(sourcePdf, [pageIndex]);
  singlePagePdf.addPage(copiedPage);
  const pdfBytes = await singlePagePdf.save();

  return {
    pdfBytes,
    widthPt,
    heightPt,
    isLandscape: widthPt > heightPt,
  };
}

/**
 * Extracts a single 0-based `pageIndex` from an already-loaded `PDFDocument`
 * and serializes it as a standalone 1-page PDF `Uint8Array`.
 *
 * Returns `null` if `pageIndex` is out of bounds (`< 0` or `>= getPageCount()`).
 */
export async function extractSinglePdfPageFromDocument(
  sourcePdf: PDFDocument,
  pageIndex: number
): Promise<Uint8Array | null> {
  const result = await extractSinglePdfPageWithMetricsFromDocument(sourcePdf, pageIndex);
  return result ? result.pdfBytes : null;
}

/**
 * Convenience helper that loads `pdfBytes` and slices out a single 0-based
 * `pageIndex` as a standalone 1-page PDF `Uint8Array`.
 */
export async function extractSinglePdfPage(
  pdfBytes: Uint8Array,
  pageIndex: number
): Promise<Uint8Array | null> {
  const sourcePdf = await loadSourcePdfDocument(pdfBytes);
  return extractSinglePdfPageFromDocument(sourcePdf, pageIndex);
}

