import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { format as formatDate } from 'date-fns';
import type { ItemData, Tag, Brand } from '@ever-works/contracts';
import { ALL_IMPORT_FIELDS, type ImportFieldName, serializeArrayCell } from './column-mapping';
import type { ExportFormat, ExportPayload } from './item-import-export.types';

/**
 * Sample rows shipped with the import template so users have a concrete
 * example of value formats (semicolon-separated arrays, true/false booleans).
 */
const SAMPLE_ROWS: ReadonlyArray<Record<ImportFieldName, string>> = [
    {
        name: 'Example App',
        description: 'A short description of what this item does',
        source_url: 'https://example.com',
        category: 'Productivity',
        categories: '',
        tags: 'time-tracking;productivity',
        slug: '',
        featured: 'false',
        order: '0',
        brand: '',
        brand_logo_url: '',
        images: '',
    },
    {
        name: 'Another Tool',
        description: 'Demonstrates multiple categories, tags, and images',
        source_url: 'https://another.example.com',
        category: '',
        categories: 'Productivity;Analytics',
        tags: 'reporting;dashboards',
        slug: 'another-tool',
        featured: 'true',
        order: '1',
        brand: 'Another Inc.',
        brand_logo_url: 'https://another.example.com/logo.png',
        images: 'https://another.example.com/screen1.png;https://another.example.com/screen2.png',
    },
];

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Serialises directory items to CSV / XLSX for EW-533 export. Pure logic
 * service — operates on already-loaded `ItemData[]`. The caller (works
 * controller) is responsible for loading items via `WorkQueryService`,
 * checking the per-directory `export_enabled` flag, and writing the
 * response headers + body.
 */
@Injectable()
export class ItemExportService {
    private readonly logger = new Logger(ItemExportService.name);

    /**
     * Top-level dispatcher. Returns serialised bytes + the matching
     * content type so the controller can plug it straight into the
     * response.
     */
    async exportItems(items: readonly ItemData[], format: ExportFormat): Promise<ExportPayload> {
        const rows = items.map((item) => this.flattenItem(item));
        if (format === 'csv') {
            return {
                data: this.serializeCSV(rows),
                contentType: CSV_CONTENT_TYPE,
                filename: this.buildFilename('items', 'csv'),
            };
        }
        return {
            data: await this.serializeXLSX(rows),
            contentType: XLSX_CONTENT_TYPE,
            filename: this.buildFilename('items', 'xlsx'),
        };
    }

    /**
     * Generates a blank import template (headers + 2 example rows) for
     * the user to fill in. Used by the import wizard in Phase 2.
     */
    async generateSample(format: ExportFormat): Promise<ExportPayload> {
        const rows = SAMPLE_ROWS.map((row) => ({ ...row }));
        if (format === 'csv') {
            return {
                data: this.serializeCSV(rows),
                contentType: CSV_CONTENT_TYPE,
                filename: 'items-import-template.csv',
            };
        }
        return {
            data: await this.serializeXLSX(rows),
            contentType: XLSX_CONTENT_TYPE,
            filename: 'items-import-template.xlsx',
        };
    }

    /**
     * Builds a download filename with the work slug + today's date. The
     * controller passes the work slug; falls back to a generic prefix
     * when called from `generateSample`.
     */
    buildFilename(slugOrPrefix: string, format: ExportFormat): string {
        const date = formatDate(new Date(), 'yyyy-MM-dd');
        return `${slugOrPrefix}-export-${date}.${format}`;
    }

    private serializeCSV(rows: ReadonlyArray<Record<ImportFieldName, string>>): string {
        return Papa.unparse(
            {
                fields: ALL_IMPORT_FIELDS as unknown as string[],
                data: rows.map((row) => ALL_IMPORT_FIELDS.map((field) => row[field] ?? '')),
            },
            { quotes: true, newline: '\r\n' },
        );
    }

    private async serializeXLSX(
        rows: ReadonlyArray<Record<ImportFieldName, string>>,
    ): Promise<Buffer> {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Ever Works';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Items');
        sheet.columns = ALL_IMPORT_FIELDS.map((field) => ({
            header: field,
            key: field,
            width: 24,
        }));
        for (const row of rows) {
            sheet.addRow(row);
        }
        // Freeze the header row for readability.
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        const buffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(buffer);
    }

    /**
     * Normalises a single `ItemData` (whose array/object-valued fields
     * have multiple shapes) into a flat string-only record keyed by the
     * canonical column names.
     */
    private flattenItem(item: ItemData): Record<ImportFieldName, string> {
        const categories = normalizeCategoryArray(item.category);
        const tags = normalizeTagArray(item.tags);
        const images = item.images ? Array.from(item.images) : [];
        const brand = normalizeBrand(item.brand);
        const brandLogo = normalizeBrandLogo(item.brand, item.brand_logo_url);
        return {
            name: item.name ?? '',
            description: item.description ?? '',
            source_url: item.source_url ?? '',
            category: categories.length === 1 ? categories[0] : '',
            categories: categories.length > 1 ? serializeArrayCell(categories) : '',
            tags: serializeArrayCell(tags),
            slug: item.slug ?? '',
            featured: item.featured ? 'true' : 'false',
            order: typeof item.order === 'number' ? String(item.order) : '',
            brand,
            brand_logo_url: brandLogo,
            images: serializeArrayCell(images),
        };
    }
}

function normalizeCategoryArray(value: ItemData['category']): string[] {
    if (typeof value === 'string') {
        return value.length > 0 ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.filter(
            (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        );
    }
    return [];
}

function normalizeTagArray(value: ItemData['tags']): string[] {
    if (!value) {
        return [];
    }
    const entries = Array.from(value as readonly (string | Tag)[]);
    return entries
        .map((entry) => {
            if (typeof entry === 'string') {
                return entry;
            }
            return entry.name ?? '';
        })
        .filter((entry) => entry.length > 0);
}

function normalizeBrand(value: ItemData['brand']): string {
    if (!value) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    return (value as Brand).name ?? '';
}

function normalizeBrandLogo(
    brand: ItemData['brand'],
    directLogo: ItemData['brand_logo_url'],
): string {
    if (directLogo) {
        return directLogo;
    }
    if (brand && typeof brand !== 'string') {
        return (brand as Brand).logo_url ?? '';
    }
    return '';
}
