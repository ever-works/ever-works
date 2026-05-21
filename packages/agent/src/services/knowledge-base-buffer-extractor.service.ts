import { Injectable, Logger } from '@nestjs/common';
import TurndownService from 'turndown';
import mammoth from 'mammoth';
// `pdf-parse`'s index.js runs a debug self-test against a bundled PDF
// when imported as the default. Import the lib entry directly so we
// avoid the side-effect — `pdf-parse/lib/pdf-parse.js` exposes the same
// function without the self-test wrapper.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (
    data: Buffer,
) => Promise<{ text: string; numpages?: number }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * EW-641 Phase 1B/c — in-process extractor that converts an uploaded
 * file's raw bytes to Markdown without going through the URL-based
 * `ContentExtractorFacadeService`.
 *
 * Rationale: the upload pipeline already has the bytes in memory after
 * the multipart parse, so the URL-based facade (which uses `axios.get`
 * to refetch the file) would add a self-referential HTTP round-trip
 * that breaks for non-public storage backends. This service operates
 * on the buffer directly.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §9.3 (extract phase).
 *
 * MIME routing as of EW-641 Phase 1B/c.2:
 *  - text/markdown, text/x-markdown, application/x-markdown, text/plain →
 *    passthrough (utf-8 decode + truncation cap)
 *  - text/html, application/xhtml+xml → Turndown-based HTML → Markdown
 *  - application/pdf → `pdf-parse`, text wrapped as a fenced Markdown body
 *  - application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *    (DOCX) → `mammoth.convertToHtml` → Turndown
 *  - everything else → `null` (caller marks `extractionStatus='skipped'`
 *    with a "no extractor route" reason)
 *
 * XLSX / CSV / PPTX / Notion arrive in follow-up commits — each needs
 * its own native Node library or extractor-plugin bridge. The routing
 * table below makes the additions one-line edits.
 */
@Injectable()
export class KnowledgeBaseBufferExtractorService {
    /**
     * Max bytes we'll inline into a KB document body. Matches the cap
     * used in `KnowledgeBaseService.bodyForTextMimeType` so behaviour is
     * symmetric across the two extraction paths. Spec §22 enforces a
     * 1 MiB body limit on KB documents.
     */
    private static readonly MAX_INLINE_BYTES = 1_048_576;

    private static readonly TEXT_PASSTHROUGH = new Set([
        'text/markdown',
        'text/x-markdown',
        'application/x-markdown',
        'text/plain',
    ]);

    private static readonly HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);

    private static readonly PDF_MIMES = new Set(['application/pdf', 'application/x-pdf']);

    /**
     * MS Word OOXML format (`.docx`). The older binary `.doc` format
     * (application/msword) is intentionally NOT included — mammoth only
     * supports OOXML and silently produces garbage on legacy `.doc`
     * files. Operators uploading legacy `.doc` files see the standard
     * "no extractor route" skip + can convert and re-upload.
     */
    private static readonly DOCX_MIMES = new Set([
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);

    private readonly logger = new Logger(KnowledgeBaseBufferExtractorService.name);
    private readonly turndown: TurndownService;

    constructor() {
        // Match the local-content-extractor plugin's Turndown config so
        // HTML uploaded into the KB renders to the same Markdown style
        // the website-fetch path produces.
        this.turndown = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
        });
        this.turndown.addRule('codeBlock', {
            filter: ['pre'],
            replacement: (content, node) => {
                const code = (
                    node as unknown as {
                        querySelector?: (sel: string) => { className?: string } | null;
                    }
                ).querySelector?.('code');
                const language = code?.className?.match(/language-(\w+)/)?.[1] ?? '';
                return `\n\`\`\`${language}\n${content.trim()}\n\`\`\`\n`;
            },
        });
    }

    /**
     * Returns the extracted Markdown body, or `null` if the MIME type
     * has no extractor route in this build. Callers (currently
     * `KnowledgeBaseService.extractAndMaterialize`) translate `null`
     * into `extractionStatus='skipped'` with an explicit reason.
     *
     * Never throws for unsupported MIME types — only throws when an
     * extractor was selected but failed mid-extraction.
     */
    async extract(
        buffer: Buffer,
        mimeType: string,
    ): Promise<{ markdown: string; via: string } | null> {
        const normalized = this.normalizeMime(mimeType);

        if (KnowledgeBaseBufferExtractorService.TEXT_PASSTHROUGH.has(normalized)) {
            return { markdown: this.decodeText(buffer), via: 'text-passthrough' };
        }

        if (KnowledgeBaseBufferExtractorService.HTML_MIMES.has(normalized)) {
            return { markdown: this.extractHtml(buffer), via: 'html-turndown' };
        }

        if (KnowledgeBaseBufferExtractorService.PDF_MIMES.has(normalized)) {
            return { markdown: await this.extractPdf(buffer), via: 'pdf-parse' };
        }

        if (KnowledgeBaseBufferExtractorService.DOCX_MIMES.has(normalized)) {
            return { markdown: await this.extractDocx(buffer), via: 'docx-mammoth' };
        }

        this.logger.debug(
            `KB buffer extractor: no route for ${mimeType} (normalized=${normalized})`,
        );
        return null;
    }

    /**
     * Public surface for callers that want to decide branching without
     * round-tripping through `extract()`. Used by tests + future code
     * (e.g. classifying an upload to skip the bytes-load when the route
     * doesn't exist).
     */
    supports(mimeType: string): boolean {
        const normalized = this.normalizeMime(mimeType);
        return (
            KnowledgeBaseBufferExtractorService.TEXT_PASSTHROUGH.has(normalized) ||
            KnowledgeBaseBufferExtractorService.HTML_MIMES.has(normalized) ||
            KnowledgeBaseBufferExtractorService.PDF_MIMES.has(normalized) ||
            KnowledgeBaseBufferExtractorService.DOCX_MIMES.has(normalized)
        );
    }

    private normalizeMime(mimeType: string): string {
        return mimeType.split(';')[0].trim().toLowerCase();
    }

    private decodeText(buffer: Buffer): string {
        if (buffer.length <= KnowledgeBaseBufferExtractorService.MAX_INLINE_BYTES) {
            return buffer.toString('utf-8');
        }
        return (
            buffer
                .slice(0, KnowledgeBaseBufferExtractorService.MAX_INLINE_BYTES)
                .toString('utf-8') + '\n\n<!-- truncated: original exceeded 1 MiB -->'
        );
    }

    private extractHtml(buffer: Buffer): string {
        const html = this.decodeText(buffer);
        try {
            const markdown = this.turndown.turndown(html);
            return markdown.trim();
        } catch (error) {
            // Turndown can throw on degenerate input (e.g. literal '<' in
            // pre blocks with mismatched closing tags). Re-throw with a
            // clearer label so the activity-log row + upload error column
            // surface what failed.
            throw new Error(`KB HTML→Markdown extraction failed: ${(error as Error).message}`);
        }
    }

    private async extractPdf(buffer: Buffer): Promise<string> {
        let result: { text: string; numpages?: number };
        try {
            result = await pdfParse(buffer);
        } catch (error) {
            throw new Error(`KB PDF extraction failed: ${(error as Error).message}`);
        }
        const text = (result.text ?? '').trim();
        if (!text) {
            // Image-only PDF / unparseable structure. Returning an empty
            // body would produce a useless KB doc; surface as a hard
            // error so the caller marks the upload failed and the
            // operator either retries with a text PDF or waits for the
            // OCR path (Phase 3, spec §9.3 image-extraction note).
            throw new Error(
                'KB PDF extraction produced no text — likely an image-only PDF; OCR is Phase 3',
            );
        }
        return this.capInlineBody(text);
    }

    private async extractDocx(buffer: Buffer): Promise<string> {
        // Mammoth's typed surface exposes `convertToHtml` but not the
        // (runtime-available) `convertToMarkdown`. Going HTML → Turndown
        // gives us the same destination via the typed path and reuses
        // the Turndown configuration already set up for HTML uploads.
        let result: { value: string };
        try {
            result = await mammoth.convertToHtml({ buffer });
        } catch (error) {
            throw new Error(`KB DOCX extraction failed: ${(error as Error).message}`);
        }
        const html = (result.value ?? '').trim();
        if (!html) {
            throw new Error('KB DOCX extraction produced empty HTML');
        }
        let markdown: string;
        try {
            markdown = this.turndown.turndown(html).trim();
        } catch (error) {
            throw new Error(`KB DOCX HTML→Markdown conversion failed: ${(error as Error).message}`);
        }
        if (!markdown) {
            throw new Error('KB DOCX extraction produced empty Markdown after Turndown pass');
        }
        return this.capInlineBody(markdown);
    }

    /**
     * Apply the same 1 MiB cap used for text passthrough so a
     * 500-page PDF doesn't blow past the spec §22 inline-body limit.
     */
    private capInlineBody(text: string): string {
        const bytes = Buffer.byteLength(text, 'utf-8');
        if (bytes <= KnowledgeBaseBufferExtractorService.MAX_INLINE_BYTES) {
            return text;
        }
        // Cheap conservative trim — utf-8 chars can be up to 4 bytes, so
        // slice at MAX/4 chars to be safe + add the marker.
        return (
            text.slice(0, KnowledgeBaseBufferExtractorService.MAX_INLINE_BYTES / 4) +
            '\n\n<!-- truncated: extracted body exceeded 1 MiB -->'
        );
    }
}
