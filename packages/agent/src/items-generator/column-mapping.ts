/**
 * Single source of truth for the CSV/Excel item import + export column
 * contract used by EW-533. Both the import service (parse + validate) and
 * the export service (serialize) read from these constants — keep them
 * here, not duplicated in the services.
 */

import type { ColumnMapping } from './item-import-export.types';

/**
 * Separator for array-valued cells (e.g. `tag1;tag2;tag3`). Semicolon is
 * used because commas appear inside descriptive cells more often than
 * semicolons do.
 */
export const ARRAY_FIELD_SEPARATOR = ';';

/**
 * Required item fields. A row missing any of these is invalid.
 */
export const REQUIRED_IMPORT_FIELDS = [
    'name',
    'description',
    'source_url',
    'category',
] as const;

/**
 * Optional item fields. Missing values are tolerated.
 */
export const OPTIONAL_IMPORT_FIELDS = [
    'categories',
    'tags',
    'slug',
    'featured',
    'order',
    'brand',
    'brand_logo_url',
    'images',
] as const;

/**
 * All importable fields, in the canonical order used for export columns and
 * sample-file generation.
 */
export const ALL_IMPORT_FIELDS = [
    ...REQUIRED_IMPORT_FIELDS,
    ...OPTIONAL_IMPORT_FIELDS,
] as const;

export type ImportFieldName = (typeof ALL_IMPORT_FIELDS)[number];

/**
 * Fields whose values are arrays serialised as `value1;value2;value3`.
 */
export const ARRAY_IMPORT_FIELDS: ReadonlySet<ImportFieldName> = new Set([
    'categories',
    'tags',
    'images',
]);

/**
 * Fields whose values are booleans serialised as 'true'/'false'.
 */
export const BOOLEAN_IMPORT_FIELDS: ReadonlySet<ImportFieldName> = new Set([
    'featured',
]);

/**
 * Fields whose values are non-negative integers.
 */
export const INTEGER_IMPORT_FIELDS: ReadonlySet<ImportFieldName> = new Set([
    'order',
]);

/**
 * Fields whose values must be HTTP(S) URLs.
 */
export const URL_IMPORT_FIELDS: ReadonlySet<ImportFieldName> = new Set([
    'source_url',
    'brand_logo_url',
]);

/**
 * Header aliases accepted by the auto-mapper. The keys are case-insensitive,
 * and the matched value is the canonical field name. Extending this map is
 * the cheapest way to support new spreadsheet conventions without changing
 * the wizard UI.
 */
export const HEADER_ALIASES: Readonly<Record<string, ImportFieldName>> = {
    name: 'name',
    title: 'name',
    'item name': 'name',
    description: 'description',
    summary: 'description',
    source_url: 'source_url',
    'source url': 'source_url',
    url: 'source_url',
    website: 'source_url',
    link: 'source_url',
    category: 'category',
    categories: 'categories',
    tag: 'tags',
    tags: 'tags',
    slug: 'slug',
    featured: 'featured',
    order: 'order',
    'sort order': 'order',
    brand: 'brand',
    brand_logo_url: 'brand_logo_url',
    'brand logo url': 'brand_logo_url',
    'brand logo': 'brand_logo_url',
    image: 'images',
    images: 'images',
    image_url: 'images',
    image_urls: 'images',
};

const normalizeHeader = (header: string): string => header.trim().toLowerCase();

/**
 * Builds a default column mapping from a list of source headers, using
 * `HEADER_ALIASES` for fuzzy matching. Headers without a match are not
 * included; the user can still map them manually in the wizard.
 */
export const inferColumnMapping = (headers: readonly string[]): ColumnMapping => {
    const mapping: ColumnMapping = {};
    for (const header of headers) {
        const target = HEADER_ALIASES[normalizeHeader(header)];
        if (target) {
            mapping[header] = target;
        }
    }
    return mapping;
};

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'n', 'off']);

/**
 * Parses a cell value to a boolean. Returns `undefined` for empty or
 * unrecognised values; the caller decides whether that's an error.
 */
export const parseBooleanCell = (raw: unknown): boolean | undefined => {
    if (typeof raw === 'boolean') {
        return raw;
    }
    if (raw === null || raw === undefined) {
        return undefined;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
    if (TRUE_VALUES.has(normalized)) {
        return true;
    }
    if (FALSE_VALUES.has(normalized)) {
        return false;
    }
    return undefined;
};

/**
 * Parses a cell value to a non-negative integer. Returns `undefined` if the
 * value is empty, non-numeric, or negative.
 */
export const parseIntegerCell = (raw: unknown): number | undefined => {
    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    }
    if (raw === null || raw === undefined) {
        return undefined;
    }
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        return undefined;
    }
    return parsed;
};

/**
 * Splits a cell value on `ARRAY_FIELD_SEPARATOR`, trims each entry, and
 * drops empty strings. Returns an empty array for empty input.
 */
export const parseArrayCell = (raw: unknown): string[] => {
    if (Array.isArray(raw)) {
        return raw.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    }
    if (raw === null || raw === undefined) {
        return [];
    }
    return String(raw)
        .split(ARRAY_FIELD_SEPARATOR)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
};

/**
 * Serialises an array-valued field for export (inverse of `parseArrayCell`).
 */
export const serializeArrayCell = (values: readonly string[] | undefined): string =>
    values && values.length > 0 ? values.join(ARRAY_FIELD_SEPARATOR) : '';
