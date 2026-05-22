import { describe, expect, it } from 'vitest';
import { formatExcelCellValue } from './format-excel-cell';

/**
 * EW-641 Phase 1B/d row 11 — `formatExcelCellValue` projects an
 * exceljs `CellValue` to a display string. Mirrors the agent-side
 * helper (PR #921 lesson — cast through `unknown` because the
 * `CellValue` union doesn't structurally overlap with
 * `Record<string, unknown>`).
 */
describe('formatExcelCellValue', () => {
    it('returns empty string for null / undefined', () => {
        expect(formatExcelCellValue(null)).toBe('');
        expect(formatExcelCellValue(undefined)).toBe('');
    });

    it('stringifies primitives', () => {
        expect(formatExcelCellValue('hello')).toBe('hello');
        expect(formatExcelCellValue(42)).toBe('42');
        expect(formatExcelCellValue(true)).toBe('true');
        expect(formatExcelCellValue(false)).toBe('false');
    });

    it('serialises Date to ISO string', () => {
        const d = new Date('2026-05-22T03:30:00Z');
        expect(formatExcelCellValue(d)).toBe('2026-05-22T03:30:00.000Z');
    });

    it('flattens richText to concatenated segment text', () => {
        const value = {
            richText: [
                { text: 'Brand ' },
                { text: 'voice' },
                {}, // missing text → empty
            ],
        };
        expect(formatExcelCellValue(value as never)).toBe('Brand voice');
    });

    it('returns the formula result, JSON for object results', () => {
        expect(formatExcelCellValue({ formula: 'SUM(A1:A3)', result: 42 } as never)).toBe('42');
        expect(formatExcelCellValue({ formula: 'X', result: null } as never)).toBe('');
        expect(formatExcelCellValue({ formula: 'X', result: { error: '#REF!' } } as never)).toBe(
            '{"error":"#REF!"}',
        );
    });

    it('returns the visible text for hyperlink cells', () => {
        const value = { text: 'Anthropic', hyperlink: 'https://anthropic.com' };
        expect(formatExcelCellValue(value as never)).toBe('Anthropic');
    });

    it('returns the bare text when the cell carries `text` without hyperlink', () => {
        expect(formatExcelCellValue({ text: 'plain' } as never)).toBe('plain');
    });

    it('falls back to String() for unknown object shapes', () => {
        // Symbols + arbitrary objects without text/richText/result/
        // hyperlink hit the `String(value)` tail.
        const value = { custom: 1 };
        expect(formatExcelCellValue(value as never)).toBe('[object Object]');
    });
});
