'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { ExcelWorkbook } from './exceljs-types';
import { createExceljsWorkbook } from './load-exceljs-workbook';
import { formatExcelCellValue } from './format-excel-cell';

interface KbXlsxViewerCanvasProps {
    url: string;
    filename: string;
    /**
     * Maximum rows rendered per sheet — protects against pathological
     * "1 M row" workbooks freezing the main thread. Defaults to 500;
     * tests use smaller values to assert the truncation marker.
     */
    maxRowsPerSheet?: number;
    /**
     * Test seam — production code lazy-imports `exceljs` itself; the
     * vitest suite supplies a stub workbook factory so it doesn't
     * have to load the (~500 KB) browser bundle.
     */
    workbookFactory?: () => ExcelWorkbook;
    fetchImpl?: typeof fetch;
}

type CanvasStatus = 'loading' | 'ready' | 'failed';

const DEFAULT_MAX_ROWS_PER_SHEET = 500;

interface SheetSnapshot {
    name: string;
    rowCount: number;
    rows: string[][];
    truncated: boolean;
}

/**
 * EW-641 Phase 1B/d row 11 — XLSX render canvas.
 *
 * Loads the workbook via `exceljs` in the browser, takes a snapshot
 * of each sheet (up to `maxRowsPerSheet` rows), and renders the
 * active sheet as a sortable `<table>`. Sheet tabs let the operator
 * switch between worksheets without re-loading the file.
 *
 * Cell values are projected through `formatExcelCellValue` so the
 * inline preview matches what the server-side extractor (PR #921)
 * stored in the document Markdown body — rich text, hyperlinks,
 * formula results, dates, and the exceljs object cell variants all
 * round-trip the same way the Markdown render does.
 */
export function KbXlsxViewerCanvas({
    url,
    filename,
    maxRowsPerSheet = DEFAULT_MAX_ROWS_PER_SHEET,
    workbookFactory,
    fetchImpl,
}: KbXlsxViewerCanvasProps) {
    const t = useTranslations('dashboard.workDetail.kb.xlsx');
    const [status, setStatus] = useState<CanvasStatus>('loading');
    const [sheets, setSheets] = useState<SheetSnapshot[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const requestRef = useRef(0);

    useEffect(() => {
        const reqId = ++requestRef.current;
        setStatus('loading');
        setError(null);
        setSheets([]);
        setActiveIndex(0);

        const run = async () => {
            try {
                const fetchFn = fetchImpl ?? fetch;
                const res = await fetchFn(url, { credentials: 'same-origin' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const arrayBuffer = await res.arrayBuffer();

                // Production path: lazy-load exceljs through a thin
                // wrapper so the spec can mock the helper without
                // resolving the full library graph.
                const wb: ExcelWorkbook = workbookFactory?.() ?? (await createExceljsWorkbook());
                await wb.xlsx.load(arrayBuffer);
                if (reqId !== requestRef.current) return;

                const snapshots = snapshotWorkbook(wb, maxRowsPerSheet);
                if (snapshots.length === 0) {
                    throw new Error(t('emptyWorkbook'));
                }
                setSheets(snapshots);
                setStatus('ready');
            } catch (e: unknown) {
                if (reqId !== requestRef.current) return;
                setError(e instanceof Error ? e.message : 'XLSX render failed');
                setStatus('failed');
            }
        };
        void run();
    }, [url, workbookFactory, fetchImpl, maxRowsPerSheet, t]);

    const activeSheet = sheets[activeIndex] ?? null;
    // Derive the rendered header + body rows so the table renders
    // deterministically across re-renders. First non-empty row is
    // treated as the header for the grid display — matches the
    // server-side extractor convention.
    const grid = useMemo(() => {
        if (!activeSheet || activeSheet.rows.length === 0) {
            return { headers: [] as string[], body: [] as string[][] };
        }
        const [first, ...rest] = activeSheet.rows;
        return { headers: first, body: rest };
    }, [activeSheet]);

    if (status === 'loading') {
        return (
            <div
                data-testid="kb-xlsx-loading"
                aria-live="polite"
                className={cn(
                    'flex h-48 items-center justify-center rounded-md border',
                    'border-border bg-card/30 text-sm text-text-muted',
                    'dark:border-border-dark dark:bg-card-primary-dark/20 dark:text-text-muted-dark/70',
                )}
            >
                {t('loading')}
            </div>
        );
    }

    if (status === 'failed') {
        return (
            <div
                data-testid="kb-xlsx-error"
                role="alert"
                className={cn(
                    'rounded-md border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm',
                    'text-red-700 dark:text-red-300',
                )}
            >
                {t('renderFailed', { error: error ?? 'unknown error' })}{' '}
                <a
                    href={url}
                    download={filename}
                    className="ml-1 underline hover:no-underline"
                    rel="noopener noreferrer"
                >
                    {t('download')}
                </a>
            </div>
        );
    }

    return (
        <div data-testid="kb-xlsx-canvas" className="flex flex-col gap-2">
            {sheets.length > 1 ? (
                <nav
                    aria-label={t('sheetTabsLabel')}
                    data-testid="kb-xlsx-sheet-tabs"
                    className="flex flex-wrap gap-1 border-b border-border dark:border-border-dark"
                >
                    {sheets.map((sheet, idx) => (
                        <button
                            key={`${sheet.name}-${idx}`}
                            type="button"
                            data-testid="kb-xlsx-sheet-tab"
                            data-sheet-index={idx}
                            data-active={idx === activeIndex ? 'true' : 'false'}
                            onClick={() => setActiveIndex(idx)}
                            className={cn(
                                'rounded-t border-b-2 px-2 py-1 text-xs',
                                idx === activeIndex
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-transparent text-text-muted hover:text-text dark:text-text-muted-dark/70 dark:hover:text-text-dark',
                            )}
                        >
                            {sheet.name}
                        </button>
                    ))}
                </nav>
            ) : null}

            {activeSheet ? (
                <div
                    className={cn(
                        'overflow-auto rounded-md border max-h-[32rem]',
                        'border-border dark:border-border-dark',
                        'bg-card dark:bg-card-primary-dark/40',
                    )}
                >
                    <table data-testid="kb-xlsx-table" className="min-w-full text-xs">
                        {grid.headers.length > 0 ? (
                            <thead className="bg-card-secondary dark:bg-card-primary-dark/60">
                                <tr>
                                    {grid.headers.map((cell, i) => (
                                        <th
                                            key={i}
                                            data-testid="kb-xlsx-th"
                                            className="border-b border-border px-2 py-1 text-left font-medium dark:border-border-dark"
                                        >
                                            {cell}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                        ) : null}
                        <tbody>
                            {grid.body.map((row, r) => (
                                <tr
                                    key={r}
                                    data-testid="kb-xlsx-tr"
                                    className="border-b border-border/40 dark:border-border-dark/60"
                                >
                                    {grid.headers.map((_, c) => (
                                        <td
                                            key={c}
                                            data-testid="kb-xlsx-td"
                                            className="px-2 py-1 align-top"
                                        >
                                            {row[c] ?? ''}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}

            {activeSheet?.truncated ? (
                <p
                    data-testid="kb-xlsx-truncated-notice"
                    className="text-xs italic text-amber-700 dark:text-amber-300"
                >
                    {t('truncated', {
                        cap: maxRowsPerSheet,
                        total: activeSheet.rowCount,
                    })}
                </p>
            ) : null}
        </div>
    );
}

/**
 * Walks every worksheet, projects cells to strings, and respects the
 * per-sheet row cap. Exported for the spec because it's the
 * trickiest piece — server-side `formatExcelCellValue` does the cell
 * conversion; this function adds row capping + iteration order +
 * sheet-name preservation.
 */
export function snapshotWorkbook(wb: ExcelWorkbook, maxRowsPerSheet: number): SheetSnapshot[] {
    const sheets: SheetSnapshot[] = [];
    for (const ws of wb.worksheets ?? []) {
        const rowCount = Math.max(0, ws.rowCount ?? 0);
        const limit = Math.min(rowCount, maxRowsPerSheet);
        const rows: string[][] = [];
        for (let r = 1; r <= limit; r += 1) {
            const row = ws.getRow(r);
            // exceljs leaves trailing blank rows reachable via getRow
            // even when `rowCount` reports a smaller value; skip
            // those so the rendered table doesn't have phantom rows.
            if (!row || row.cellCount === 0) continue;
            const cells: string[] = [];
            const width = Math.max(row.cellCount ?? 0, 1);
            for (let c = 1; c <= width; c += 1) {
                cells.push(formatExcelCellValue(row.getCell(c).value));
            }
            rows.push(cells);
        }
        sheets.push({
            name: ws.name?.trim() || `Sheet ${ws.id}`,
            rowCount,
            rows,
            truncated: rowCount > maxRowsPerSheet,
        });
    }
    return sheets;
}
