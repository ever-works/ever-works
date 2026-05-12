import Papa from 'papaparse';
import * as ExcelJS from 'exceljs';
import { ItemImportService } from './item-import.service';
import { ALL_IMPORT_FIELDS } from './column-mapping';

const service = new ItemImportService();

function csvBuffer(headers: string[], rows: Array<Record<string, string>>): Buffer {
    const text = Papa.unparse({
        fields: headers,
        data: rows.map((row) => headers.map((h) => row[h] ?? '')),
    });
    return Buffer.from(text, 'utf-8');
}

async function xlsxBuffer(
    headers: string[],
    rows: Array<Record<string, string | number | boolean>>,
): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Items');
    sheet.addRow(headers);
    for (const row of rows) {
        sheet.addRow(headers.map((h) => row[h] ?? ''));
    }
    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.from(buf);
}

describe('ItemImportService.parseCSV', () => {
    it('returns headers + row records keyed by header text', () => {
        const buffer = csvBuffer(
            ['name', 'description', 'source_url', 'category'],
            [
                {
                    name: 'A',
                    description: 'da',
                    source_url: 'https://a.test',
                    category: 'Tools',
                },
                {
                    name: 'B',
                    description: 'db',
                    source_url: 'https://b.test',
                    category: 'Tools',
                },
            ],
        );
        const result = service.parseCSV(buffer);
        expect(result.headers).toEqual(['name', 'description', 'source_url', 'category']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toMatchObject({ name: 'A', source_url: 'https://a.test' });
    });

    it('drops empty trailing lines', () => {
        const buffer = Buffer.from('name,description\nA,da\n\n\n', 'utf-8');
        const result = service.parseCSV(buffer);
        expect(result.rows).toHaveLength(1);
    });
});

describe('ItemImportService.parseXLSX', () => {
    it('reads headers + rows from the first worksheet', async () => {
        const buffer = await xlsxBuffer(
            ['name', 'description', 'source_url', 'category'],
            [
                {
                    name: 'XlA',
                    description: 'da',
                    source_url: 'https://xla.test',
                    category: 'Tools',
                },
            ],
        );
        const result = await service.parseXLSX(buffer);
        expect(result.headers).toEqual(['name', 'description', 'source_url', 'category']);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({ name: 'XlA', source_url: 'https://xla.test' });
    });
});

describe('ItemImportService.validateRows', () => {
    const baseHeaders = ['name', 'description', 'source_url', 'category'];
    const baseMapping = Object.fromEntries(baseHeaders.map((h) => [h, h]));

    it('flags rows missing required fields', () => {
        const parsed = {
            headers: baseHeaders,
            rows: [
                { name: '', description: 'd', source_url: 'https://a.test', category: 'Tools' },
                { name: 'Has Name', description: '', source_url: '', category: 'Tools' },
            ],
        };
        const result = service.validateRows(parsed, baseMapping, []);
        expect(result.summary.total).toBe(2);
        expect(result.summary.valid).toBe(0);
        expect(result.summary.invalid).toBe(2);
        expect(result.validationResults[0].errors).toContain("Missing required field 'name'");
        expect(result.validationResults[1].errors).toContain(
            "Missing required field 'description'",
        );
    });

    it('accepts a row that only has the singular `category` field', () => {
        const parsed = {
            headers: baseHeaders,
            rows: [
                {
                    name: 'A',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Productivity',
                },
            ],
        };
        const result = service.validateRows(parsed, baseMapping, []);
        expect(result.summary.valid).toBe(1);
        expect(result.validationResults[0].data?.category).toBe('Productivity');
    });

    it('accepts `categories` (semicolon-separated) in place of `category`', () => {
        const parsed = {
            headers: ['name', 'description', 'source_url', 'categories'],
            rows: [
                {
                    name: 'A',
                    description: 'd',
                    source_url: 'https://a.test',
                    categories: 'Tools;Analytics',
                },
            ],
        };
        const mapping = {
            name: 'name',
            description: 'description',
            source_url: 'source_url',
            categories: 'categories',
        };
        const result = service.validateRows(parsed, mapping, []);
        expect(result.summary.valid).toBe(1);
        expect(result.validationResults[0].data?.categories).toEqual(['Tools', 'Analytics']);
    });

    it('rejects an image with a non-http(s) URL (each element of array URL fields is validated)', () => {
        const parsed = {
            headers: [...baseHeaders, 'images'],
            rows: [
                {
                    name: 'A',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                    images: 'https://ok.test/1.png;javascript:alert(1)',
                },
            ],
        };
        const mapping = { ...baseMapping, images: 'images' };
        const result = service.validateRows(parsed, mapping, []);
        expect(result.validationResults[0].valid).toBe(false);
        expect(result.validationResults[0].errors[0]).toMatch(/images/);
        expect(result.validationResults[0].errors[0]).toMatch(/javascript:/);
    });

    it('rejects an invalid source_url with an error and no data', () => {
        const parsed = {
            headers: baseHeaders,
            rows: [{ name: 'A', description: 'd', source_url: 'not-a-url', category: 'Tools' }],
        };
        const result = service.validateRows(parsed, baseMapping, []);
        expect(result.summary.valid).toBe(0);
        expect(result.validationResults[0].valid).toBe(false);
        expect(result.validationResults[0].errors[0]).toMatch(/source_url/);
    });

    it('coerces featured/order via parsers and emits a warning for unparseable booleans', () => {
        const parsed = {
            headers: [...baseHeaders, 'featured', 'order'],
            rows: [
                {
                    name: 'A',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                    featured: 'true',
                    order: '3',
                },
                {
                    name: 'B',
                    description: 'd',
                    source_url: 'https://b.test',
                    category: 'Tools',
                    featured: 'maybe',
                    order: '',
                },
            ],
        };
        const mapping = { ...baseMapping, featured: 'featured', order: 'order' };
        const result = service.validateRows(parsed, mapping, []);
        expect(result.validationResults[0].data?.featured).toBe(true);
        expect(result.validationResults[0].data?.order).toBe(3);
        expect(result.validationResults[1].warnings[0]).toMatch(/featured/);
    });

    it('flags duplicates against existing items + within the batch itself', () => {
        const parsed = {
            headers: baseHeaders,
            rows: [
                {
                    name: 'Existing',
                    description: 'd',
                    source_url: 'https://existing.test',
                    category: 'Tools',
                },
                {
                    name: 'New',
                    description: 'd',
                    source_url: 'https://new.test',
                    category: 'Tools',
                },
                {
                    name: 'New Again',
                    description: 'd',
                    source_url: 'https://new.test',
                    category: 'Tools',
                },
            ],
        };
        const result = service.validateRows(parsed, baseMapping, [
            { slug: 'existing', source_url: 'https://existing.test' },
        ]);
        expect(result.validationResults[0].duplicate?.source_url).toBe('https://existing.test');
        expect(result.validationResults[1].duplicate).toBeUndefined();
        expect(result.validationResults[2].duplicate?.source_url).toBe('https://new.test');
        expect(result.summary.duplicates).toBe(2);
    });

    it('uses inferred mapping when caller supplies an empty mapping', () => {
        const parsed = {
            headers: ['Item Name', 'Summary', 'URL', 'Category'],
            rows: [
                {
                    'Item Name': 'Auto',
                    Summary: 'd',
                    URL: 'https://auto.test',
                    Category: 'Tools',
                },
            ],
        };
        const result = service.validateRows(parsed, {}, []);
        expect(result.summary.valid).toBe(1);
        expect(result.suggestedMapping).toMatchObject({
            'Item Name': 'name',
            Summary: 'description',
            URL: 'source_url',
            Category: 'category',
        });
    });

    it('flags two rows with the same name and no explicit slug as intra-batch duplicates', () => {
        // Both rows would have the executor compute slug='same-name', so the
        // second one would silently overwrite the first if validate didn't
        // catch the collision here.
        const parsed = {
            headers: baseHeaders,
            rows: [
                {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                },
                {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://b.test',
                    category: 'Tools',
                },
            ],
        };
        const result = service.validateRows(parsed, baseMapping, []);
        expect(result.validationResults[0].duplicate).toBeUndefined();
        expect(result.validationResults[1].duplicate?.slug).toBe('same-name');
        expect(result.summary.duplicates).toBe(1);
    });

    it('flags an explicit slug + a name that slugifies to the same string as a duplicate', () => {
        // Row 0 explicitly sets slug "my-tool"; row 1 has no slug but the
        // executor would derive slug="my-tool" from its name. Validate must
        // catch this canonical collision.
        const parsed = {
            headers: [...baseHeaders, 'slug'],
            rows: [
                {
                    name: 'Whatever',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                    slug: 'my-tool',
                },
                {
                    name: 'My Tool',
                    description: 'd',
                    source_url: 'https://b.test',
                    category: 'Tools',
                    slug: '',
                },
            ],
        };
        const mapping = { ...baseMapping, slug: 'slug' };
        const result = service.validateRows(parsed, mapping, []);
        expect(result.validationResults[1].duplicate?.slug).toBe('my-tool');
        expect(result.summary.duplicates).toBe(1);
    });

    it('flags a row whose slugified name matches an existing item slug', () => {
        const parsed = {
            headers: baseHeaders,
            rows: [
                {
                    name: 'Foo Bar',
                    description: 'd',
                    source_url: 'https://new.test',
                    category: 'Tools',
                },
            ],
        };
        const result = service.validateRows(parsed, baseMapping, [
            { slug: 'foo-bar', source_url: 'https://something-else.test' },
        ]);
        expect(result.validationResults[0].duplicate?.slug).toBe('foo-bar');
    });

    it('emits an error for a malformed slug', () => {
        const parsed = {
            headers: [...baseHeaders, 'slug'],
            rows: [
                {
                    name: 'A',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                    slug: 'NOT A SLUG',
                },
            ],
        };
        const mapping = { ...baseMapping, slug: 'slug' };
        const result = service.validateRows(parsed, mapping, []);
        expect(result.validationResults[0].errors[0]).toMatch(/slug/);
    });

    it('preserves the canonical column order in the response headers', () => {
        const parsed = { headers: ALL_IMPORT_FIELDS.slice(), rows: [] };
        const result = service.validateRows(parsed, {}, []);
        expect(result.headers).toEqual(ALL_IMPORT_FIELDS);
    });
});

describe('ItemImportService.revalidateImportRowData', () => {
    it('accepts a well-formed canonical row', () => {
        const result = service.revalidateImportRowData(
            {
                name: 'A',
                description: 'd',
                source_url: 'https://a.test',
                category: 'Tools',
            },
            0,
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.data?.name).toBe('A');
    });

    it('rejects rows missing required fields even when caller claims `valid`', () => {
        const result = service.revalidateImportRowData(
            { name: 'A', source_url: 'https://a.test', category: 'Tools' },
            0,
        );
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/description/);
        expect(result.data).toBeUndefined();
    });

    it('rejects a non-http(s) source_url (tamper guard against javascript: scheme)', () => {
        const result = service.revalidateImportRowData(
            {
                name: 'A',
                description: 'd',
                source_url: 'javascript:alert(1)',
                category: 'Tools',
            },
            0,
        );
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/source_url/);
    });

    it('rejects a slug that does not match the canonical kebab-case pattern', () => {
        const result = service.revalidateImportRowData(
            {
                name: 'A',
                description: 'd',
                source_url: 'https://a.test',
                category: 'Tools',
                slug: 'NOT A SLUG',
            },
            0,
        );
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/slug/);
    });

    it('strips unknown fields from the input', () => {
        const result = service.revalidateImportRowData(
            {
                name: 'A',
                description: 'd',
                source_url: 'https://a.test',
                category: 'Tools',
                __admin: true,
                rogue: '../etc/passwd',
            },
            0,
        );
        expect(result.valid).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).not.toHaveProperty('__admin');
        expect(result.data).not.toHaveProperty('rogue');
    });

    it('handles non-object input (null / array / primitive) by reporting required-field errors', () => {
        expect(service.revalidateImportRowData(null, 0).valid).toBe(false);
        expect(service.revalidateImportRowData([], 0).valid).toBe(false);
        expect(service.revalidateImportRowData('payload', 0).valid).toBe(false);
    });

    it('coerces booleans and integers through the same parsers as validateRows', () => {
        const result = service.revalidateImportRowData(
            {
                name: 'A',
                description: 'd',
                source_url: 'https://a.test',
                category: 'Tools',
                featured: 'true',
                order: '7',
            },
            0,
        );
        expect(result.valid).toBe(true);
        expect(result.data?.featured).toBe(true);
        expect(result.data?.order).toBe(7);
    });
});
