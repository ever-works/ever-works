jest.mock('pdf-parse/lib/pdf-parse.js', () => jest.fn());
jest.mock('mammoth', () => ({
    __esModule: true,
    default: { convertToMarkdown: jest.fn() },
    convertToMarkdown: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParseMock = require('pdf-parse/lib/pdf-parse.js') as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammothMock = require('mammoth') as {
    default: { convertToMarkdown: jest.Mock };
    convertToMarkdown: jest.Mock;
};

import { KnowledgeBaseBufferExtractorService } from '../knowledge-base-buffer-extractor.service';

/**
 * EW-641 Phase 1B/c.2 — covers the per-MIME routing decisions taken by
 * `KnowledgeBaseBufferExtractorService` including the HTML / PDF / DOCX
 * routes. XLSX / CSV / PPTX / Notion routes arrive in follow-up commits.
 *
 * PDF + DOCX rely on third-party libs (`pdf-parse`, `mammoth`) — those
 * are mocked at module level so the unit test stays hermetic + fast.
 */
describe('KnowledgeBaseBufferExtractorService', () => {
    let service: KnowledgeBaseBufferExtractorService;

    beforeEach(() => {
        pdfParseMock.mockReset();
        mammothMock.default.convertToMarkdown.mockReset();
        mammothMock.convertToMarkdown.mockReset();
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
        ])('decodes %s as utf-8 verbatim', async (mime) => {
            const result = await service.extract(
                Buffer.from('# brand voice\n\nbody', 'utf-8'),
                mime,
            );
            expect(result).not.toBeNull();
            expect(result!.markdown).toBe('# brand voice\n\nbody');
            expect(result!.via).toBe('text-passthrough');
        });

        it('truncates passthrough bodies that exceed the 1 MiB cap', async () => {
            const big = Buffer.alloc(2 * 1024 * 1024, 'a');
            const result = await service.extract(big, 'text/plain');
            expect(result).not.toBeNull();
            expect(result!.markdown.length).toBeLessThan(big.length);
            expect(result!.markdown).toMatch(/truncated: original exceeded 1 MiB/);
        });
    });

    describe('HTML extraction', () => {
        it('converts simple HTML to Markdown via Turndown', async () => {
            const html =
                '<h1>Brand voice</h1><p>Clear, confident, never breathless.</p><ul><li>One</li><li>Two</li></ul>';
            const result = await service.extract(Buffer.from(html, 'utf-8'), 'text/html');
            expect(result).not.toBeNull();
            expect(result!.via).toBe('html-turndown');
            expect(result!.markdown).toContain('# Brand voice');
            expect(result!.markdown).toContain('Clear, confident, never breathless.');
            expect(result!.markdown).toMatch(/[-*]\s+One/);
            expect(result!.markdown).toMatch(/[-*]\s+Two/);
        });

        it('uses atx-style headings + fenced code blocks (matches local-content-extractor)', async () => {
            const html =
                '<h2>Section</h2><pre><code class="language-ts">const x: number = 1;</code></pre>';
            const result = await service.extract(
                Buffer.from(html, 'utf-8'),
                'application/xhtml+xml',
            );
            expect(result).not.toBeNull();
            expect(result!.markdown).toMatch(/^##\s+Section/m);
            expect(result!.markdown).toMatch(/```ts\n[\s\S]*?const x: number = 1;[\s\S]*?\n```/);
        });

        it('handles MIME with charset parameter', async () => {
            const result = await service.extract(
                Buffer.from('<p>hi</p>', 'utf-8'),
                'text/html; charset=utf-8',
            );
            expect(result).not.toBeNull();
            expect(result!.via).toBe('html-turndown');
            expect(result!.markdown).toBe('hi');
        });
    });

    describe('PDF extraction', () => {
        it('calls pdf-parse and returns text wrapped via the cap helper', async () => {
            pdfParseMock.mockResolvedValueOnce({
                text: 'Page 1 body.\n\nPage 2 body.',
                numpages: 2,
            });

            const result = await service.extract(Buffer.from('%PDF-fake'), 'application/pdf');

            expect(result).not.toBeNull();
            expect(result!.via).toBe('pdf-parse');
            expect(result!.markdown).toBe('Page 1 body.\n\nPage 2 body.');
            expect(pdfParseMock).toHaveBeenCalledTimes(1);
        });

        it('also accepts application/x-pdf alias', async () => {
            pdfParseMock.mockResolvedValueOnce({ text: 'hi' });
            const result = await service.extract(Buffer.from('%PDF-fake'), 'application/x-pdf');
            expect(result?.via).toBe('pdf-parse');
        });

        it('throws when pdf-parse yields no text (likely image-only PDF)', async () => {
            pdfParseMock.mockResolvedValueOnce({ text: '   \n\n', numpages: 3 });
            await expect(
                service.extract(Buffer.from('%PDF-fake'), 'application/pdf'),
            ).rejects.toThrow(/image-only PDF.*OCR is Phase 3/);
        });

        it('rethrows underlying pdf-parse errors with a clear label', async () => {
            pdfParseMock.mockRejectedValueOnce(new Error('corrupt header'));
            await expect(
                service.extract(Buffer.from('not-a-pdf'), 'application/pdf'),
            ).rejects.toThrow(/KB PDF extraction failed: corrupt header/);
        });
    });

    describe('DOCX extraction', () => {
        it('calls mammoth.convertToMarkdown and returns the value', async () => {
            mammothMock.default.convertToMarkdown.mockResolvedValueOnce({
                value: '# Heading\n\nbody',
            });

            const result = await service.extract(
                Buffer.from('PK-fake-docx'),
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            );

            expect(result).not.toBeNull();
            expect(result!.via).toBe('docx-mammoth');
            expect(result!.markdown).toBe('# Heading\n\nbody');
            expect(mammothMock.default.convertToMarkdown).toHaveBeenCalledWith({
                buffer: expect.any(Buffer),
            });
        });

        it('throws on empty mammoth output', async () => {
            mammothMock.default.convertToMarkdown.mockResolvedValueOnce({ value: '   ' });
            await expect(
                service.extract(
                    Buffer.from('PK-fake-docx'),
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                ),
            ).rejects.toThrow(/empty Markdown/);
        });

        it('rethrows mammoth errors with a clear label', async () => {
            mammothMock.default.convertToMarkdown.mockRejectedValueOnce(
                new Error('not a zip file'),
            );
            await expect(
                service.extract(
                    Buffer.from('PK-fake-docx'),
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                ),
            ).rejects.toThrow(/KB DOCX extraction failed: not a zip file/);
        });
    });

    describe('unsupported MIME types', () => {
        it.each([
            // Legacy .doc binary format — mammoth doesn't support it.
            'application/msword',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'image/png',
            'video/mp4',
            'application/octet-stream',
        ])('returns null for %s (caller marks upload skipped)', async (mime) => {
            const result = await service.extract(Buffer.from([0, 1, 2, 3]), mime);
            expect(result).toBeNull();
        });

        it('supports() agrees with extract()', () => {
            expect(service.supports('text/markdown')).toBe(true);
            expect(service.supports('text/html')).toBe(true);
            expect(service.supports('application/xhtml+xml')).toBe(true);
            expect(service.supports('application/pdf')).toBe(true);
            expect(service.supports('application/x-pdf')).toBe(true);
            expect(
                service.supports(
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                ),
            ).toBe(true);
            expect(service.supports('application/msword')).toBe(false);
            expect(
                service.supports(
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            ).toBe(false);
            expect(service.supports('image/png')).toBe(false);
        });
    });
});
