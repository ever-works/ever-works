import type { ExcelWorkbook } from './exceljs-types';

interface ExcelJsModule {
    Workbook: new () => ExcelWorkbook;
}

/**
 * Dynamic-import wrapper around `new exceljs.Workbook()`.
 *
 * Lives in its own module so the viewer spec can mock the single
 * helper instead of `vi.mock('exceljs', …)` — and uses an opaque
 * runtime computation for the module specifier so Vite's static
 * analyzer doesn't eagerly walk exceljs's dependency graph during
 * test discovery. Without that, vitest OOMs even with
 * `--max-old-space-size=8192` because exceljs pulls in jszip,
 * archiver, and a ~700-class typings tree the resolver parses.
 *
 * The runtime path is unchanged — Next.js's webpack still lazy-
 * loads exceljs the first time an operator opens an XLSX preview.
 */
export async function createExceljsWorkbook(): Promise<ExcelWorkbook> {
    // Compute the specifier at runtime so Vite can't constant-fold
    // the dynamic import target.
    const id = ['exceljs'].join('');
    const mod = (await import(/* @vite-ignore */ id)) as unknown as ExcelJsModule;
    return new mod.Workbook();
}
