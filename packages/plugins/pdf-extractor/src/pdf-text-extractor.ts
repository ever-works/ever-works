import { PDFParse } from 'pdf-parse';
import type { PdfTextResult } from './types.js';

/**
 * Text-layer extraction from PDF buffers via pdf-parse.
 */
export class PdfTextExtractor {
	async extractText(buffer: Buffer, maxPages: number = 0): Promise<PdfTextResult> {
		const parser = new PDFParse({
			data: new Uint8Array(buffer)
		});

		const info = await parser.getInfo();
		const numPages = info.total;

		const pagesToParse = maxPages > 0 ? Math.min(maxPages, numPages) : numPages;

		const textResult = await parser.getText({
			first: pagesToParse
		});

		await parser.destroy();

		return {
			text: textResult.text.trim(),
			numPages,
			info: info.info ?? {}
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
