import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { PdfTextResult } from './types.js';

/**
 * Text-layer extraction from PDF buffers via unpdf.
 */
export class PdfTextExtractor {
	async extractText(buffer: Buffer, maxPages: number = 0): Promise<PdfTextResult> {
		const pdf = await getDocumentProxy(new Uint8Array(buffer));
		const totalPages = pdf.numPages;

		const { text } = await extractText(pdf, { mergePages: false });
		const { info } = await getMeta(pdf);

		const pages = maxPages > 0 ? text.slice(0, Math.min(maxPages, totalPages)) : text;
		const combined = pages.join('\n');

		await pdf.destroy();

		return {
			text: combined.trim(),
			numPages: totalPages,
			info: info ?? {}
		};
	}

	/** Meaningful characters per page — low density indicates a scanned PDF. */
	calculateTextDensity(text: string, numPages: number): number {
		if (numPages <= 0) {
			return 0;
		}

		const meaningfulChars = text.replace(/\s+/g, '').length;
		return meaningfulChars / numPages;
	}
}
