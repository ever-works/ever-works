jest.mock('pdf-parse/lib/pdf-parse.js', () => jest.fn());
jest.mock('mammoth', () => ({
    __esModule: true,
    default: { convertToHtml: jest.fn() },
    convertToHtml: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParseMock = require('pdf-parse/lib/pdf-parse.js') as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammothMock = require('mammoth') as {
    default: { convertToHtml: jest.Mock };
    convertToHtml: jest.Mock;
};

import { KnowledgeBaseBufferExtractorService } from '../knowledge-base-buffer-extractor.service';

/**
 * EW-641 Phase 1B/c — covers the per-MIME routing decisions taken by
 * `KnowledgeBaseBufferExtractorService` including HTML / PDF / DOCX /
 * XLSX / CSV / TSV / PPTX routes. Notion + URL routes arrive later.
 *
 * PDF + DOCX rely on third-party libs (`pdf-parse`, `mammoth`) — those
 * are mocked at module level so the unit test stays hermetic + fast.
 * XLSX + PPTX use the real `exceljs` / `jszip` libs to build fixtures
 * in-memory; both are pure Node and have no I/O side effects.
 */
describe('KnowledgeBaseBufferExtractorService', () => {
    let service: KnowledgeBaseBufferExtractorService;

    beforeEach(() => {
        pdfParseMock.mockReset();
        mammothMock.default.convertToHtml.mockReset();
        mammothMock.convertToHtml.mockReset();
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
        it('calls mammoth.convertToHtml then Turndown and returns Markdown', async () => {
            mammothMock.default.convertToHtml.mockResolvedValueOnce({
                value: '<h1>Heading</h1><p>body</p>',
            });

            const result = await service.extract(
                Buffer.from('PK-fake-docx'),
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            );

            expect(result).not.toBeNull();
            expect(result!.via).toBe('docx-mammoth');
            expect(result!.markdown).toMatch(/^#\s+Heading/m);
            expect(result!.markdown).toContain('body');
            expect(mammothMock.default.convertToHtml).toHaveBeenCalledWith({
                buffer: expect.any(Buffer),
            });
        });

        it('throws on empty mammoth output', async () => {
            mammothMock.default.convertToHtml.mockResolvedValueOnce({ value: '   ' });
            await expect(
                service.extract(
                    Buffer.from('PK-fake-docx'),
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                ),
            ).rejects.toThrow(/empty HTML/);
        });

        it('rethrows mammoth errors with a clear label', async () => {
            mammothMock.default.convertToHtml.mockRejectedValueOnce(new Error('not a zip file'));
            await expect(
                service.extract(
                    Buffer.from('PK-fake-docx'),
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                ),
            ).rejects.toThrow(/KB DOCX extraction failed: not a zip file/);
        });
    });

    describe('XLSX extraction', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ExcelJS = require('exceljs');
        const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

        async function buildXlsxBuffer(
            sheets: Array<{ name: string; rows: unknown[][] }>,
        ): Promise<Buffer> {
            const wb = new ExcelJS.Workbook();
            for (const { name, rows } of sheets) {
                const ws = wb.addWorksheet(name);
                for (const row of rows) {
                    ws.addRow(row);
                }
            }
            return (await wb.xlsx.writeBuffer()) as Buffer;
        }

        it('renders each sheet as a Markdown table under an h2 heading', async () => {
            const buffer = await buildXlsxBuffer([
                {
                    name: 'People',
                    rows: [
                        ['Name', 'Role'],
                        ['Alice', 'PM'],
                        ['Bob', 'Eng'],
                    ],
                },
                {
                    name: 'Budgets',
                    rows: [
                        ['Quarter', 'Amount'],
                        ['Q1', 1000],
                        ['Q2', 2500],
                    ],
                },
            ]);

            const result = await service.extract(buffer, XLSX_MIME);

            expect(result).not.toBeNull();
            expect(result!.via).toBe('xlsx-exceljs');
            expect(result!.markdown).toMatch(/^##\s+People/m);
            expect(result!.markdown).toMatch(/\|\s+Name\s+\|\s+Role\s+\|/);
            expect(result!.markdown).toMatch(/\|\s+Alice\s+\|\s+PM\s+\|/);
            expect(result!.markdown).toMatch(/^##\s+Budgets/m);
            expect(result!.markdown).toMatch(/\|\s+Q2\s+\|\s+2500\s+\|/);
        });

        it('escapes pipes and newlines in cell values', async () => {
            const buffer = await buildXlsxBuffer([
                {
                    name: 'Tricky',
                    rows: [['Col'], ['a|b'], ['line1\nline2']],
                },
            ]);

            const result = await service.extract(buffer, XLSX_MIME);

            expect(result!.markdown).toContain('a\\|b');
            expect(result!.markdown).toContain('line1 line2');
            expect(result!.markdown).not.toContain('line1\nline2');
        });

        it('emits an empty-sheet marker for sheets with no header row', async () => {
            const buffer = await buildXlsxBuffer([{ name: 'Blank', rows: [] }]);
            const result = await service.extract(buffer, XLSX_MIME);
            expect(result!.markdown).toMatch(/## Blank[\s\S]*empty sheet/);
        });

        it('throws on a corrupt buffer with a clear label', async () => {
            await expect(service.extract(Buffer.from('not-a-zip'), XLSX_MIME)).rejects.toThrow(
                /KB XLSX extraction failed:/,
            );
        });
    });

    describe('CSV / TSV extraction', () => {
        it('renders a CSV buffer as a Markdown table via papaparse', async () => {
            const csv = 'name,role\nAlice,PM\nBob,Eng\n';
            const result = await service.extract(Buffer.from(csv, 'utf-8'), 'text/csv');
            expect(result).not.toBeNull();
            expect(result!.via).toBe('csv-papaparse');
            expect(result!.markdown).toMatch(/\|\s+name\s+\|\s+role\s+\|/);
            expect(result!.markdown).toMatch(/\|\s+Alice\s+\|\s+PM\s+\|/);
            expect(result!.markdown).toMatch(/\|\s+Bob\s+\|\s+Eng\s+\|/);
        });

        it('handles a TSV buffer with tab delimiter', async () => {
            const tsv = 'name\trole\nAlice\tPM\nBob\tEng\n';
            const result = await service.extract(
                Buffer.from(tsv, 'utf-8'),
                'text/tab-separated-values',
            );
            expect(result).not.toBeNull();
            expect(result!.via).toBe('tsv-papaparse');
            expect(result!.markdown).toMatch(/\|\s+Alice\s+\|\s+PM\s+\|/);
        });

        it('also accepts text/tsv alias', async () => {
            const result = await service.extract(Buffer.from('a\tb\n1\t2\n', 'utf-8'), 'text/tsv');
            expect(result?.via).toBe('tsv-papaparse');
        });

        it('throws on a CSV with no rows', async () => {
            await expect(
                service.extract(Buffer.from('\n\n\n', 'utf-8'), 'text/csv'),
            ).rejects.toThrow(/KB delimited-text extraction produced no rows/);
        });
    });

    describe('PPTX extraction', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const JSZip = require('jszip');
        const PPTX_MIME =
            'application/vnd.openxmlformats-officedocument.presentationml.presentation';

        function slideXml(...phrases: string[]): string {
            const paragraphs = phrases
                .map(
                    (p) =>
                        `<a:p><a:r><a:t>${p
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')}</a:t></a:r></a:p>`,
                )
                .join('');
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${paragraphs}</p:spTree></p:cSld></p:sld>`;
        }

        async function buildPptxBuffer(
            slides: Array<{ index: number; text: string[] }>,
            extraEntries: Record<string, string> = {},
        ): Promise<Buffer> {
            const zip = new JSZip();
            for (const { index, text } of slides) {
                zip.file(`ppt/slides/slide${index}.xml`, slideXml(...text));
            }
            for (const [path, body] of Object.entries(extraEntries)) {
                zip.file(path, body);
            }
            return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
        }

        it('extracts text from each slide and labels them in numeric order', async () => {
            const buffer = await buildPptxBuffer(
                [
                    // Intentionally out of order — extractor must sort numerically.
                    { index: 2, text: ['Second deck title', 'with subtitle'] },
                    { index: 1, text: ['Welcome to the deck'] },
                ],
                {
                    // Non-slide entries should be ignored.
                    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation/>',
                    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
                },
            );

            const result = await service.extract(buffer, PPTX_MIME);

            expect(result).not.toBeNull();
            expect(result!.via).toBe('pptx-jszip');
            expect(result!.markdown).toMatch(/^##\s+Slide 1/m);
            expect(result!.markdown).toContain('Welcome to the deck');
            expect(result!.markdown).toMatch(/^##\s+Slide 2/m);
            expect(result!.markdown).toContain('Second deck title with subtitle');
            // Slide 1 heading must come before Slide 2 heading (ordering check).
            const idx1 = result!.markdown.indexOf('## Slide 1');
            const idx2 = result!.markdown.indexOf('## Slide 2');
            expect(idx1).toBeGreaterThanOrEqual(0);
            expect(idx2).toBeGreaterThan(idx1);
        });

        it('decodes XML entities back to literal characters', async () => {
            const buffer = await buildPptxBuffer([
                { index: 1, text: ['Smith & Jones <Co>', 'price > 100'] },
            ]);
            const result = await service.extract(buffer, PPTX_MIME);
            expect(result!.markdown).toContain('Smith & Jones <Co>');
            expect(result!.markdown).toContain('price > 100');
            expect(result!.markdown).not.toContain('&amp;');
            expect(result!.markdown).not.toContain('&lt;');
        });

        it('emits a `(no text)` marker for slides without `<a:t>` nodes', async () => {
            const zip = new JSZip();
            // Slide with no <a:t> — e.g. an image-only slide.
            zip.file(
                'ppt/slides/slide1.xml',
                '<?xml version="1.0"?><p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>',
            );
            const buffer = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;

            const result = await service.extract(buffer, PPTX_MIME);
            expect(result!.markdown).toMatch(/## Slide 1[\s\S]*\(no text\)/);
        });

        it('throws when the deck contains no slides', async () => {
            const zip = new JSZip();
            zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
            const buffer = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;

            await expect(service.extract(buffer, PPTX_MIME)).rejects.toThrow(
                /KB PPTX extraction found no slides/,
            );
        });

        it('throws on a corrupt buffer with a clear label', async () => {
            await expect(service.extract(Buffer.from('not-a-zip-file'), PPTX_MIME)).rejects.toThrow(
                /KB PPTX extraction failed:/,
            );
        });
    });

    describe('unsupported MIME types', () => {
        it.each([
            // Legacy .doc binary format — mammoth doesn't support it.
            'application/msword',
            // Legacy .xls binary format — exceljs only reads OOXML.
            'application/vnd.ms-excel',
            // Legacy .ppt binary format — jszip can't read OLE/BIFF.
            'application/vnd.ms-powerpoint',
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
            expect(
                service.supports(
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            ).toBe(true);
            expect(service.supports('text/csv')).toBe(true);
            expect(service.supports('text/tab-separated-values')).toBe(true);
            expect(service.supports('text/tsv')).toBe(true);
            expect(
                service.supports(
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                ),
            ).toBe(true);
            expect(service.supports('application/msword')).toBe(false);
            expect(service.supports('application/vnd.ms-excel')).toBe(false);
            expect(service.supports('application/vnd.ms-powerpoint')).toBe(false);
            expect(service.supports('image/png')).toBe(false);
        });
    });
});
