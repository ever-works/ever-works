import type { ExcelWorkbook } from './exceljs-types';

interface ExcelJsModule {
    Workbook: new () => ExcelWorkbook;
}

/**
 * Dynamic-import wrapper around `new exceljs.Workbook()`.
 *
 * Lives in its own module so the viewer spec can mock the single
 * helper at the boundary (`vi.mock('./load-exceljs-workbook', …)`)
 * instead of `vi.mock('exceljs', …)` — the latter still forces
 * vitest to resolve exceljs's dep graph (jszip, archiver, ~700-class
 * typings) and OOMs on Windows even with `--max-old-space-size=8192`.
 *
 * The static `import('exceljs')` is required for Next.js: webpack
 * needs a literal specifier to code-split the package into its own
 * chunk. An opaque runtime computation here (`['exceljs'].join('')`)
 * makes webpack emit "Module not found: Can't resolve <dynamic>",
 * which poisons the dev manifest and 500s every route. Since the
 * test mock fully bypasses this module, no runtime obfuscation is
 * needed.
 */
export async function createExceljsWorkbook(): Promise<ExcelWorkbook> {
    const mod = (await import('exceljs')) as unknown as ExcelJsModule;
    return new mod.Workbook();
}
