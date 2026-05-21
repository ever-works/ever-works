import { Injectable, Logger } from '@nestjs/common';
import TurndownService from 'turndown';

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
 * MIME routing in this PR:
 *  - text/markdown, text/x-markdown, application/x-markdown, text/plain →
 *    passthrough (utf-8 decode + truncation cap)
 *  - text/html, application/xhtml+xml → Turndown-based HTML → Markdown
 *  - everything else → `null` (caller marks `extractionStatus='skipped'`
 *    with a "no extractor route" reason)
 *
 * PDF / DOCX / XLSX / PPTX / Notion arrive in follow-up commits — each
 * needs its own native Node library or extractor-plugin bridge. The
 * routing table below makes the additions one-line edits.
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
    extract(buffer: Buffer, mimeType: string): { markdown: string; via: string } | null {
        const normalized = this.normalizeMime(mimeType);

        if (KnowledgeBaseBufferExtractorService.TEXT_PASSTHROUGH.has(normalized)) {
            return { markdown: this.decodeText(buffer), via: 'text-passthrough' };
        }

        if (KnowledgeBaseBufferExtractorService.HTML_MIMES.has(normalized)) {
            return { markdown: this.extractHtml(buffer), via: 'html-turndown' };
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
            KnowledgeBaseBufferExtractorService.HTML_MIMES.has(normalized)
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
}
