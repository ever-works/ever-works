import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { ItemData } from '@ever-works/contracts';
import {
    ALL_IMPORT_FIELDS,
    ARRAY_IMPORT_FIELDS,
    BOOLEAN_IMPORT_FIELDS,
    INTEGER_IMPORT_FIELDS,
    REQUIRED_IMPORT_FIELDS,
    URL_IMPORT_FIELDS,
    type ImportFieldName,
    inferColumnMapping,
    parseArrayCell,
    parseBooleanCell,
    parseIntegerCell,
} from './column-mapping';
import type {
    ColumnMapping,
    ImportDuplicateMatch,
    ImportRowData,
    ImportRowValidation,
    ImportValidationResponse,
    ImportValidationSummary,
} from './item-import-export.types';

/**
 * Parsed-file structure shared by CSV and XLSX paths. Headers preserve the
 * source's column order; rows are keyed by the *raw* header text so that
 * the validator can apply user-supplied (or auto-inferred) `ColumnMapping`
 * to translate them into our canonical field names.
 */
export interface ParsedFile {
    headers: string[];
    rows: Record<string, unknown>[];
}

/**
 * Maximum number of *data* rows accepted by the parsers. Defends against
 * accidental uploads of huge spreadsheets — the validate route layers a
 * tighter, per-directory `import_max_rows` ceiling on top of this.
 */
export const PARSER_HARD_ROW_CAP = 10_000;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parses CSV / XLSX item-import files and validates the resulting rows
 * against the column contract from `column-mapping.ts`. Pure logic — the
 * service never reads from disk or hits the network. The controller layer
 * is responsible for loading the request body, fetching existing items for
 * duplicate detection, and gating the call on `settings.import_enabled`.
 */
@Injectable()
export class ItemImportService {
    private readonly logger = new Logger(ItemImportService.name);

    /**
     * Parses a CSV buffer using Papaparse. The first row is treated as
     * the header row; subsequent rows become objects keyed by those
     * header strings. Empty trailing rows are dropped.
     */
    parseCSV(buffer: Buffer): ParsedFile {
        const text = buffer.toString('utf-8');
        const result = Papa.parse<Record<string, unknown>>(text, {
            header: true,
            skipEmptyLines: 'greedy',
            transformHeader: (header) => header.trim(),
        });
        if (result.errors.length > 0) {
            this.logger.warn(
                `Papaparse reported ${result.errors.length} CSV parse warnings: ${result.errors[0].message}`,
            );
        }
        const headers = result.meta.fields ?? [];
        const rows = (result.data ?? []).slice(0, PARSER_HARD_ROW_CAP);
        return { headers, rows };
    }

    /**
     * Parses an XLSX buffer using ExcelJS. Reads the first worksheet only;
     * the first row is treated as the header. Cell values are coerced to
     * strings where possible (numbers and booleans preserve their native
     * types so the per-field parsers can decide what to do with them).
     */
    async parseXLSX(buffer: Buffer): Promise<ParsedFile> {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) {
            return { headers: [], rows: [] };
        }
        const headerRow = sheet.getRow(1);
        const headers: string[] = [];
        headerRow.eachCell({ includeEmpty: false }, (cell) => {
            headers.push(String(cell.value ?? '').trim());
        });
        const rows: Record<string, unknown>[] = [];
        const rowCount = Math.min(sheet.rowCount - 1, PARSER_HARD_ROW_CAP);
        for (let r = 0; r < rowCount; r += 1) {
            const row = sheet.getRow(r + 2);
            if (!row || row.cellCount === 0) {
                continue;
            }
            const entry: Record<string, unknown> = {};
            let nonEmpty = false;
            for (let c = 0; c < headers.length; c += 1) {
                const cell = row.getCell(c + 1);
                const value = unwrapExcelCell(cell.value);
                if (value !== undefined && value !== null && String(value).length > 0) {
                    nonEmpty = true;
                }
                entry[headers[c]] = value;
            }
            if (nonEmpty) {
                rows.push(entry);
            }
        }
        return { headers, rows };
    }

    /**
     * Validates a parsed sheet against the column contract and against an
     * existing-items snapshot for duplicate detection.
     *
     * @param parsed       Output of `parseCSV` or `parseXLSX`
     * @param mapping      User-provided mapping (raw header → canonical field).
     *                     Pass an empty object to fall back to the auto-mapper.
     * @param existingItems Already-loaded items from the work's data repo
     *                     (used to compute the `duplicate` field on each row)
     */
    validateRows(
        parsed: ParsedFile,
        mapping: ColumnMapping,
        existingItems: ReadonlyArray<Pick<ItemData, 'slug' | 'source_url'>>,
    ): ImportValidationResponse {
        const suggestedMapping = inferColumnMapping(parsed.headers);
        const effectiveMapping = Object.keys(mapping).length > 0 ? mapping : suggestedMapping;
        const reverseMapping = invertMapping(effectiveMapping);

        const existingSlugs = new Set<string>();
        const existingUrls = new Set<string>();
        for (const item of existingItems) {
            if (item.slug) existingSlugs.add(item.slug);
            if (item.source_url) existingUrls.add(item.source_url);
        }

        const seenSlugs = new Set<string>();
        const seenUrls = new Set<string>();
        const validationResults: ImportRowValidation[] = [];
        let validCount = 0;
        let duplicateCount = 0;

        for (let i = 0; i < parsed.rows.length; i += 1) {
            const rowResult = this.validateSingleRow(parsed.rows[i], i, reverseMapping);
            if (rowResult.data) {
                const dup = detectDuplicate(
                    rowResult.data,
                    existingSlugs,
                    existingUrls,
                    seenSlugs,
                    seenUrls,
                );
                if (dup) {
                    rowResult.duplicate = dup;
                    duplicateCount += 1;
                }
                if (rowResult.data.slug) seenSlugs.add(rowResult.data.slug);
                if (rowResult.data.source_url) seenUrls.add(rowResult.data.source_url);
            }
            if (rowResult.valid) {
                validCount += 1;
            }
            validationResults.push(rowResult);
        }

        const summary: ImportValidationSummary = {
            total: parsed.rows.length,
            valid: validCount,
            invalid: parsed.rows.length - validCount,
            duplicates: duplicateCount,
        };

        return {
            headers: parsed.headers,
            suggestedMapping,
            validationResults,
            summary,
        };
    }

    /**
     * Re-runs the column-contract validators on a row of canonical-shape
     * `ImportRowData` that arrives from a client request (the execute
     * endpoint receives these directly in `body.rows[].data`). Unlike
     * `validateRows`, this method does not consult a column mapping — the
     * input is already in canonical shape — but it still:
     *
     *   - whitelists fields to `ALL_IMPORT_FIELDS` (drops anything extra),
     *   - re-parses array/boolean/integer cells through the same coercers,
     *   - re-checks required fields, URL fields, and the slug pattern.
     *
     * Used by `ItemImportExecutorService` to gate every row that gets
     * written to the data repo, even when the client claims `valid: true`.
     * Defense against tampered `/import-items` payloads bypassing the
     * Phase 2 validate endpoint.
     */
    revalidateImportRowData(input: unknown, rowIndex: number): ImportRowValidation {
        const raw =
            input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        return this.buildValidatedRow(rowIndex, (field) => raw[field]);
    }

    private validateSingleRow(
        raw: Record<string, unknown>,
        rowIndex: number,
        reverseMapping: Record<ImportFieldName, string>,
    ): ImportRowValidation {
        return this.buildValidatedRow(rowIndex, (field) => {
            const sourceHeader = reverseMapping[field];
            return sourceHeader ? raw[sourceHeader] : undefined;
        });
    }

    private buildValidatedRow(
        rowIndex: number,
        getField: (field: ImportFieldName) => unknown,
    ): ImportRowValidation {
        const errors: string[] = [];
        const warnings: string[] = [];
        const data: Partial<ImportRowData> = {};

        for (const field of ALL_IMPORT_FIELDS) {
            this.applyField(field, getField(field), data, errors, warnings);
        }

        for (const required of REQUIRED_IMPORT_FIELDS) {
            if (required === 'category') {
                const hasSingle = typeof data.category === 'string' && data.category.length > 0;
                const hasMulti = Array.isArray(data.categories) && data.categories.length > 0;
                if (!hasSingle && !hasMulti) {
                    errors.push(`Missing required field '${required}' (or 'categories')`);
                }
                continue;
            }
            const value = data[required as keyof ImportRowData];
            if (typeof value !== 'string' || value.length === 0) {
                errors.push(`Missing required field '${required}'`);
            }
        }

        if (data.slug && !SLUG_PATTERN.test(data.slug)) {
            errors.push(
                `Field 'slug' must be lowercase alphanumeric with single hyphens (got '${data.slug}')`,
            );
        }

        const valid = errors.length === 0;
        return {
            rowIndex,
            valid,
            errors,
            warnings,
            data: valid ? (data as ImportRowData) : undefined,
        };
    }

    private applyField(
        field: ImportFieldName,
        rawValue: unknown,
        data: Partial<ImportRowData>,
        errors: string[],
        warnings: string[],
    ): void {
        if (rawValue === undefined || rawValue === null) {
            return;
        }
        if (ARRAY_IMPORT_FIELDS.has(field)) {
            const arr = parseArrayCell(rawValue);
            if (arr.length === 0) {
                return;
            }
            if (URL_IMPORT_FIELDS.has(field)) {
                for (const url of arr) {
                    if (!isValidHttpUrl(url)) {
                        errors.push(`Field '${field}' has invalid URL: '${url}'`);
                    }
                }
            }
            (data as Record<string, unknown>)[field] = arr;
            return;
        }
        if (BOOLEAN_IMPORT_FIELDS.has(field)) {
            const bool = parseBooleanCell(rawValue);
            if (bool === undefined) {
                if (String(rawValue).trim().length > 0) {
                    warnings.push(
                        `Field '${field}' could not be parsed as a boolean; treating as missing`,
                    );
                }
                return;
            }
            (data as Record<string, unknown>)[field] = bool;
            return;
        }
        if (INTEGER_IMPORT_FIELDS.has(field)) {
            const int = parseIntegerCell(rawValue);
            if (int === undefined) {
                if (String(rawValue).trim().length > 0) {
                    errors.push(
                        `Field '${field}' must be a non-negative integer (got '${rawValue}')`,
                    );
                }
                return;
            }
            (data as Record<string, unknown>)[field] = int;
            return;
        }
        const text = String(rawValue).trim();
        if (text.length === 0) {
            return;
        }
        if (URL_IMPORT_FIELDS.has(field) && !isValidHttpUrl(text)) {
            errors.push(`Field '${field}' must be a valid http(s) URL (got '${text}')`);
            return;
        }
        (data as Record<string, unknown>)[field] = text;
    }
}

function invertMapping(mapping: ColumnMapping): Record<ImportFieldName, string> {
    const reversed: Partial<Record<ImportFieldName, string>> = {};
    for (const [source, target] of Object.entries(mapping)) {
        if (isImportFieldName(target)) {
            reversed[target] = source;
        }
    }
    return reversed as Record<ImportFieldName, string>;
}

function isImportFieldName(value: string): value is ImportFieldName {
    return (ALL_IMPORT_FIELDS as readonly string[]).includes(value);
}

function detectDuplicate(
    row: ImportRowData,
    existingSlugs: ReadonlySet<string>,
    existingUrls: ReadonlySet<string>,
    seenSlugs: ReadonlySet<string>,
    seenUrls: ReadonlySet<string>,
): ImportDuplicateMatch | undefined {
    const match: ImportDuplicateMatch = {};
    if (row.slug && (existingSlugs.has(row.slug) || seenSlugs.has(row.slug))) {
        match.slug = row.slug;
    }
    if (row.source_url && (existingUrls.has(row.source_url) || seenUrls.has(row.source_url))) {
        match.source_url = row.source_url;
    }
    return match.slug || match.source_url ? match : undefined;
}

function isValidHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function unwrapExcelCell(value: ExcelJS.CellValue): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value !== 'object') {
        return value;
    }
    const record = value as unknown as Record<string, unknown>;
    if (typeof record.text === 'string') {
        return record.text;
    }
    if ('result' in record) {
        return record.result;
    }
    if (Array.isArray(record.richText)) {
        const parts = record.richText as Array<{ text?: string }>;
        return parts.map((part) => part.text ?? '').join('');
    }
    return value;
}
