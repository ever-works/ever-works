import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '@officecli/sdk';
import type { OfficeExtension, OfficeExtractOptions, OfficeTextResult } from './types.js';

/**
 * OfficeCLI content command used to dump a document's text. Per the
 * `@officecli/sdk` contract, content commands (`view` / `raw` / `dump`) return
 * plain text when `asJson` is `false`. `dump` yields the whole document body;
 * the `format` argument selects the serialization (plain text vs markdown).
 */
const DUMP_COMMAND = 'dump';

/**
 * Text extraction from Office documents (.docx/.xlsx/.pptx) via the official
 * OfficeCLI Node SDK. The SDK spawns / reuses a resident `officecli` process
 * that serves the document over a named pipe; we open the document, forward a
 * single content command, and close the resident (which flushes and shuts down).
 *
 * OfficeCLI needs a real file path (it reads OOXML off disk), so the downloaded
 * bytes are written to a private temp directory that is always cleaned up.
 */
export class OfficeCliTextExtractor {
	async extractText(
		buffer: Buffer,
		extension: OfficeExtension,
		options: OfficeExtractOptions
	): Promise<OfficeTextResult> {
		const dir = await mkdtemp(join(tmpdir(), 'ew-officecli-'));
		const filePath = join(dir, `document.${extension}`);
		await writeFile(filePath, buffer);

		try {
			// `binary` left undefined lets the SDK resolve the bundled binary.
			const doc = await open(filePath, {
				binary: options.binary,
				timeoutMs: options.timeoutMs,
				autoInstall: true
			});

			try {
				const item: Record<string, unknown> = { command: DUMP_COMMAND };
				if (options.renderMode === 'markdown') {
					item.format = 'markdown';
				}

				// asJson=false → OfficeCLI returns the raw content text.
				const result = await doc.send(item, false, options.timeoutMs);

				return {
					text: this.coerceText(result),
					format: options.renderMode
				};
			} finally {
				// Stop the resident; it flushes to disk on shutdown. Best-effort —
				// a close failure must not mask a successful extraction.
				await doc.close().catch(() => undefined);
			}
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * Content commands return raw text, but the SDK will parse a JSON envelope
	 * into an object/array when the body happens to be JSON. Normalize any shape
	 * to a trimmed string.
	 */
	private coerceText(result: unknown): string {
		if (typeof result === 'string') {
			return result.trim();
		}
		if (result === null || result === undefined) {
			return '';
		}
		return JSON.stringify(result);
	}
}
