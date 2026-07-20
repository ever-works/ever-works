/**
 * Output format the extractor should ask OfficeCLI for. `text` is the plain
 * text-layer content; `markdown` is a lightly-structured markdown serialization.
 */
export type OfficeRenderMode = 'text' | 'markdown';

/**
 * File extensions this plugin knows how to hand to OfficeCLI.
 */
export type OfficeExtension = 'docx' | 'xlsx' | 'pptx';

/**
 * Options forwarded from the plugin to the OfficeCLI text extractor.
 */
export interface OfficeExtractOptions {
	/** Plain text or markdown output. */
	readonly renderMode: OfficeRenderMode;
	/** Optional absolute path to a specific `officecli` binary (settings override). */
	readonly binary?: string;
	/** Connect + command timeout in ms forwarded to the OfficeCLI SDK. */
	readonly timeoutMs: number;
}

/**
 * Result of a single OfficeCLI extraction.
 */
export interface OfficeTextResult {
	/** Extracted document content in the requested render mode. */
	readonly text: string;
	/** The render mode the content was produced in. */
	readonly format: OfficeRenderMode;
}
