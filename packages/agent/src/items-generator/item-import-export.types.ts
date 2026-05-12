/**
 * Shared TypeScript contracts for the CSV/Excel item import + export feature
 * (EW-533). These types are consumed by:
 *   - the import service (parse → validate → execute)
 *   - the export service (serialize items → CSV/XLSX)
 *   - the API layer (request/response shapes)
 *   - the web app (preview wizard, results step)
 *
 * Phase 0 introduces only the shapes; the services and routes that consume
 * them land in later phases.
 */

/**
 * Column mapping the user (or the auto-mapper) declares between source
 * file headers and target item fields.
 *
 * Example: `{ "Item Name": "name", "URL": "source_url" }`.
 */
export type ColumnMapping = Record<string, string>;

/**
 * What to do when an incoming row matches an existing item by `slug` or
 * `source_url`.
 *
 *   - `skip`   — leave the existing item untouched (the row counts as skipped).
 *   - `update` — overwrite the existing item with the row's fields.
 */
export type ImportDuplicateStrategy = 'skip' | 'update';

/**
 * Information about a duplicate match found during validation. At least one
 * of `slug` or `source_url` is set.
 */
export interface ImportDuplicateMatch {
    slug?: string;
    source_url?: string;
}

/**
 * Per-row result emitted by the validation pass. The array index in
 * `validationResults[i]` matches `rowIndex` (0-based, header row excluded).
 */
export interface ImportRowValidation {
    rowIndex: number;
    valid: boolean;
    errors: string[];
    warnings: string[];
    /**
     * Parsed and normalised payload. Present when validation succeeded
     * (or partially succeeded — see `errors`/`warnings`).
     */
    data?: ImportRowData;
    /**
     * Set when the row collides with an existing item. The execute step
     * applies the user-selected `ImportDuplicateStrategy`.
     */
    duplicate?: ImportDuplicateMatch;
}

/**
 * Shape of a single normalised row, post-mapping and post-coercion. Mirrors
 * the column contract defined in `column-mapping.ts`. Field names match
 * `SubmitItemDto` so the executor can hand rows straight to the existing
 * single-item write pipeline in Phase 3.
 */
export interface ImportRowData {
    name: string;
    description: string;
    source_url: string;
    category?: string;
    categories?: string[];
    tags?: string[];
    slug?: string;
    featured?: boolean;
    order?: number;
    brand?: string;
    brand_logo_url?: string;
    images?: string[];
}

/**
 * Per-row error surfaced in the final import result. Distinct from
 * `ImportRowValidation.errors` (which are dry-run errors) — these are
 * errors that occurred during the actual write.
 */
export interface ImportResultError {
    rowIndex: number;
    message: string;
}

/**
 * Aggregate result of executing a validated batch.
 */
export interface ImportResult {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    errors: ImportResultError[];
}

/**
 * Output of the validation pass (returned by the dry-run validate endpoint).
 */
export interface ImportValidationSummary {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
}

/**
 * Full payload returned by the validate endpoint.
 */
export interface ImportValidationResponse {
    headers: string[];
    suggestedMapping: ColumnMapping;
    validationResults: ImportRowValidation[];
    summary: ImportValidationSummary;
}

/**
 * Supported export formats. `csv` is plain UTF-8 text; `xlsx` is an Excel
 * workbook generated via ExcelJS.
 */
export type ExportFormat = 'csv' | 'xlsx';

/**
 * Metadata about a generated export payload — consumed by the API layer
 * to set Content-Type and Content-Disposition headers.
 */
export interface ExportPayload {
    data: string | Buffer;
    filename: string;
    contentType: string;
}

/**
 * Response shape for the export-settings probe used by the web export button
 * to hide itself when the feature is disabled for a directory.
 */
export interface ExportSettingsResponse {
    export_enabled: boolean;
}
