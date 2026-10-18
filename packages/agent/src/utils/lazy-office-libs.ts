import type * as ExcelJS from 'exceljs';

/**
 * `exceljs` and `mammoth` load on first use, never at import time.
 *
 * Both pull in `bluebird` (mammoth directly, exceljs through `unzipper`), and
 * bluebird's module init reads `new Error().stack` to find its own file
 * bounds. Inside a Trigger.dev worker `source-map-support` is installed, so
 * that single `.stack` read synchronously parses the source map of the
 * worker's largest bundle chunk (~19 MB): ~3.5 s of the ~7 s the deploy
 * indexer needed on a fast machine, and the reason it blew its fixed 20 s
 * budget on the CI runner ("Failed to index deployment ... Worker timed out").
 * The same cost hit every worker cold start. Only XLSX / DOCX import, export
 * and Knowledge Base uploads need these libraries, so they load lazily (once,
 * cached) and nothing imports them eagerly.
 *
 * Use `import type` for their types; `loadExcelJs()` / `loadMammoth()` for
 * the values.
 */

export type ExcelJsModule = typeof ExcelJS;
export type MammothModule = typeof import('mammoth');

/**
 * Resolve the CJS module object from a dynamic `import()` result: prefer its
 * `default` (what a static `import x from` binds under `esModuleInterop`)
 * when that carries the expected export, else the namespace itself.
 */
function unwrapDefault<T extends object>(mod: T, probe: keyof T): T {
    const fallback = (mod as T & { default?: T }).default;
    if (fallback && typeof fallback === 'object' && probe in fallback) {
        return fallback;
    }
    return mod;
}

let excelJsModule: Promise<ExcelJsModule> | undefined;

export function loadExcelJs(): Promise<ExcelJsModule> {
    excelJsModule ??= import('exceljs').then(
        (mod) => unwrapDefault<ExcelJsModule>(mod, 'Workbook'),
        (error: unknown) => {
            excelJsModule = undefined;
            throw error;
        },
    );
    return excelJsModule;
}

let mammothModule: Promise<MammothModule> | undefined;

export function loadMammoth(): Promise<MammothModule> {
    mammothModule ??= import('mammoth').then(
        (mod) => unwrapDefault<MammothModule>(mod, 'convertToHtml'),
        (error: unknown) => {
            mammothModule = undefined;
            throw error;
        },
    );
    return mammothModule;
}
