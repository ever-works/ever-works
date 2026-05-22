/**
 * Local structural type aliases for the exceljs surface our viewers
 * use. Importing `import type { Workbook }` from the `exceljs` package
 * directly triggers vitest's module resolver to walk the (very large)
 * exceljs dependency graph in JIT mode and OOMs the V8 worker on
 * Windows. The runtime path still uses the real `exceljs.Workbook`
 * via `(await import('exceljs')).Workbook` — only the type-side
 * dependency is severed.
 *
 * Mirrors the subset of the exceljs typing surface our code touches.
 * Update when the canvas reads new fields.
 */

export type ExcelCellValue =
    | string
    | number
    | boolean
    | Date
    | null
    | undefined
    | { text?: string; richText?: Array<{ text?: unknown }> }
    | { formula: string; result?: unknown }
    | { hyperlink: string; text?: string }
    | Record<string, unknown>;

export interface ExcelCell {
    value: ExcelCellValue;
}

export interface ExcelRow {
    cellCount: number;
    getCell(column: number): ExcelCell;
}

export interface ExcelWorksheet {
    id: number;
    name: string;
    rowCount: number;
    getRow(row: number): ExcelRow;
}

export interface ExcelWorkbookXlsx {
    load(buffer: ArrayBuffer): Promise<unknown>;
}

export interface ExcelWorkbook {
    worksheets: ExcelWorksheet[];
    xlsx: ExcelWorkbookXlsx;
}
