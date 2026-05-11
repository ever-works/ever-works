import Papa from 'papaparse';
import * as ExcelJS from 'exceljs';
import type { ItemData } from '@ever-works/contracts';
import { ItemExportService } from './item-export.service';
import { ALL_IMPORT_FIELDS } from './column-mapping';

const service = new ItemExportService();

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
    return {
        name: 'Test Item',
        description: 'A test item',
        source_url: 'https://example.com',
        category: 'Tools',
        tags: ['alpha', 'beta'],
        slug: 'test-item',
        featured: false,
        order: 0,
        images: ['https://example.com/a.png', 'https://example.com/b.png'],
        ...overrides,
    } as ItemData;
}

describe('ItemExportService', () => {
    describe('exportItems → CSV', () => {
        it('produces an empty CSV with only headers when items is empty', async () => {
            const payload = await service.exportItems([], 'csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            expect(payload.contentType).toBe('text/csv; charset=utf-8');
            expect(payload.filename).toMatch(/^items-export-\d{4}-\d{2}-\d{2}\.csv$/);
            expect(parsed.meta.fields).toEqual(Array.from(ALL_IMPORT_FIELDS));
            expect(parsed.data).toEqual([]);
        });

        it('serialises array fields with semicolon separators', async () => {
            const item = makeItem({
                tags: ['tag-1', 'tag-2'],
                images: ['https://a.test/1.png', 'https://a.test/2.png'],
            });
            const payload = await service.exportItems([item], 'csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            expect(parsed.data).toHaveLength(1);
            expect(parsed.data[0].tags).toBe('tag-1;tag-2');
            expect(parsed.data[0].images).toBe('https://a.test/1.png;https://a.test/2.png');
        });

        it('serialises booleans as the strings "true" / "false"', async () => {
            const a = makeItem({ featured: true });
            const b = makeItem({ name: 'Other', slug: 'other', featured: false });
            const payload = await service.exportItems([a, b], 'csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            expect(parsed.data[0].featured).toBe('true');
            expect(parsed.data[1].featured).toBe('false');
        });

        it('normalises Tag objects, Brand objects, and category arrays', async () => {
            const item = makeItem({
                category: ['Productivity', 'Analytics'],
                tags: [
                    { id: 't1', name: 'reporting' },
                    { id: 't2', name: 'dashboards' },
                ] as unknown as ItemData['tags'],
                brand: {
                    id: 'b1',
                    name: 'Acme',
                    logo_url: 'https://acme.test/logo.png',
                } as unknown as ItemData['brand'],
                brand_logo_url: undefined,
            });
            const payload = await service.exportItems([item], 'csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            const row = parsed.data[0];
            expect(row.category).toBe('');
            expect(row.categories).toBe('Productivity;Analytics');
            expect(row.tags).toBe('reporting;dashboards');
            expect(row.brand).toBe('Acme');
            expect(row.brand_logo_url).toBe('https://acme.test/logo.png');
        });

        it('keeps the single-category column when only one category is present', async () => {
            const item = makeItem({ category: 'Tools' });
            const payload = await service.exportItems([item], 'csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            expect(parsed.data[0].category).toBe('Tools');
            expect(parsed.data[0].categories).toBe('');
        });
    });

    describe('exportItems → XLSX', () => {
        it('produces a workbook with the expected header row + content type', async () => {
            const item = makeItem({ name: 'XLSX Row', slug: 'xlsx-row' });
            const payload = await service.exportItems([item], 'xlsx');
            expect(payload.contentType).toBe(
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
            expect(payload.filename).toMatch(/^items-export-\d{4}-\d{2}-\d{2}\.xlsx$/);
            expect(Buffer.isBuffer(payload.data)).toBe(true);

            const workbook = new ExcelJS.Workbook();
            // ExcelJS's `xlsx.load` accepts a `Buffer`-shaped argument; the
            // newer Node Buffer<ArrayBufferLike> type is wider than what its
            // d.ts declares, so cast through `any` for the test.
            await workbook.xlsx.load(payload.data as any);
            const sheet = workbook.worksheets[0];
            const headerRow = sheet.getRow(1);
            const headerValues = (headerRow.values as (string | undefined)[])
                .filter((value): value is string => typeof value === 'string');
            expect(headerValues).toEqual(Array.from(ALL_IMPORT_FIELDS));
            const dataRow = sheet.getRow(2);
            expect(dataRow.getCell(1).value).toBe('XLSX Row');
        });
    });

    describe('generateSample', () => {
        it('produces a CSV template with the two example rows', async () => {
            const payload = await service.generateSample('csv');
            const parsed = Papa.parse<Record<string, string>>(payload.data as string, {
                header: true,
                skipEmptyLines: true,
            });
            expect(payload.filename).toBe('items-import-template.csv');
            expect(parsed.data).toHaveLength(2);
            expect(parsed.data[0].name).toBe('Example App');
            expect(parsed.data[1].featured).toBe('true');
        });

        it('produces a XLSX template with the same content type as a regular export', async () => {
            const payload = await service.generateSample('xlsx');
            expect(payload.filename).toBe('items-import-template.xlsx');
            expect(payload.contentType).toBe(
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
        });
    });
});
