import type { ExcelCellValue } from './exceljs-types';

/**
 * EW-641 Phase 1B/d row 11 — render an exceljs `CellValue` as a
 * display string for the XLSX viewer grid.
 *
 * Mirrors the agent-side `formatExcelCellValue` helper used by the
 * server extractor (Phase 1B/c.3) so the inline preview matches what
 * the extractor stored in the Markdown body. The exceljs `CellValue`
 * union doesn't overlap with `Record<string, unknown>` structurally,
 * so we cast through `unknown` first (PR #921 lesson — same trap
 * called out in the user's recurring exceljs reminder).
 */
export function formatExcelCellValue(value: ExcelCellValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        const obj = value as unknown as Record<string, unknown>;
        if (typeof obj.text === 'string' && typeof obj.hyperlink !== 'string') {
            return obj.text;
        }
        if (Array.isArray(obj.richText)) {
            return obj.richText
                .map((seg) =>
                    seg && typeof seg === 'object' && 'text' in seg
                        ? String((seg as { text: unknown }).text ?? '')
                        : '',
                )
                .join('');
        }
        if ('result' in obj) {
            const r = obj.result;
            if (r === null || r === undefined) return '';
            if (typeof r === 'object') return JSON.stringify(r);
            return String(r);
        }
        if (typeof obj.hyperlink === 'string' && typeof obj.text === 'string') {
            return obj.text;
        }
    }
    return String(value);
}
