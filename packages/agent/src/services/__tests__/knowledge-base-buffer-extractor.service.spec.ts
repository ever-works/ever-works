import { KnowledgeBaseBufferExtractorService } from '../knowledge-base-buffer-extractor.service';

/**
 * EW-641 Phase 1B/c — covers the per-MIME routing decisions taken by
 * `KnowledgeBaseBufferExtractorService` plus the HTML → Markdown
 * conversion that lands first. PDF / DOCX / XLSX / PPTX routes are
 * covered in follow-up commits as each gets a native Node library
 * binding.
 */
describe('KnowledgeBaseBufferExtractorService', () => {
    let service: KnowledgeBaseBufferExtractorService;

    beforeEach(() => {
        service = new KnowledgeBaseBufferExtractorService();
    });

    describe('text passthrough', () => {
        it.each([
            'text/markdown',
            'text/x-markdown',
            'application/x-markdown',
            'text/plain',
            'text/markdown; charset=utf-8',
            'TEXT/MARKDOWN',
        ])('decodes %s as utf-8 verbatim', (mime) => {
            const result = service.extract(Buffer.from('# brand voice\n\nbody', 'utf-8'), mime);
            expect(result).not.toBeNull();
            expect(result!.markdown).toBe('# brand voice\n\nbody');
            expect(result!.via).toBe('text-passthrough');
        });

        it('truncates passthrough bodies that exceed the 1 MiB cap', () => {
            const big = Buffer.alloc(2 * 1024 * 1024, 'a');
            const result = service.extract(big, 'text/plain');
            expect(result).not.toBeNull();
            expect(result!.markdown.length).toBeLessThan(big.length);
            expect(result!.markdown).toMatch(/truncated: original exceeded 1 MiB/);
        });
    });

    describe('HTML extraction', () => {
        it('converts simple HTML to Markdown via Turndown', () => {
            const html =
                '<h1>Brand voice</h1><p>Clear, confident, never breathless.</p><ul><li>One</li><li>Two</li></ul>';
            const result = service.extract(Buffer.from(html, 'utf-8'), 'text/html');
            expect(result).not.toBeNull();
            expect(result!.via).toBe('html-turndown');
            expect(result!.markdown).toContain('# Brand voice');
            expect(result!.markdown).toContain('Clear, confident, never breathless.');
            expect(result!.markdown).toMatch(/[-*]\s+One/);
            expect(result!.markdown).toMatch(/[-*]\s+Two/);
        });

        it('uses atx-style headings + fenced code blocks (matches local-content-extractor)', () => {
            const html =
                '<h2>Section</h2><pre><code class="language-ts">const x: number = 1;</code></pre>';
            const result = service.extract(Buffer.from(html, 'utf-8'), 'application/xhtml+xml');
            expect(result).not.toBeNull();
            expect(result!.markdown).toMatch(/^##\s+Section/m);
            expect(result!.markdown).toMatch(/```ts\n[\s\S]*?const x: number = 1;[\s\S]*?\n```/);
        });

        it('handles MIME with charset parameter', () => {
            const result = service.extract(
                Buffer.from('<p>hi</p>', 'utf-8'),
                'text/html; charset=utf-8',
            );
            expect(result).not.toBeNull();
            expect(result!.via).toBe('html-turndown');
            expect(result!.markdown).toBe('hi');
        });
    });

    describe('unsupported MIME types', () => {
        it.each([
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'image/png',
            'video/mp4',
            'application/octet-stream',
        ])('returns null for %s (caller marks upload skipped)', (mime) => {
            const result = service.extract(Buffer.from([0, 1, 2, 3]), mime);
            expect(result).toBeNull();
        });

        it('supports() agrees with extract()', () => {
            expect(service.supports('text/markdown')).toBe(true);
            expect(service.supports('text/html')).toBe(true);
            expect(service.supports('application/xhtml+xml')).toBe(true);
            expect(service.supports('application/pdf')).toBe(false);
            expect(service.supports('image/png')).toBe(false);
        });
    });
});
