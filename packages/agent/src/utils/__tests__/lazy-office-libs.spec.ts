import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadExcelJs, loadMammoth } from '../lazy-office-libs';

/**
 * `exceljs` and `mammoth` must stay off every import-time path of this
 * package. Both load `bluebird`, whose module init reads `new Error().stack`;
 * inside a Trigger.dev worker that read makes `source-map-support` parse the
 * ~19 MB source map of the bundle's largest chunk synchronously, which pushed
 * the deploy indexer past its fixed 20 s budget ("Failed to index deployment
 * ... Worker timed out") and slowed every worker cold start by seconds.
 */
describe('lazy-office-libs', () => {
    it('loads exceljs on demand and hands back a usable Workbook', async () => {
        const { Workbook } = await loadExcelJs();
        const workbook = new Workbook();
        workbook.addWorksheet('Items').addRow(['a', 'b']);
        const buffer = await workbook.xlsx.writeBuffer();
        expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it('loads mammoth on demand and exposes convertToHtml', async () => {
        const mammoth = await loadMammoth();
        expect(typeof mammoth.convertToHtml).toBe('function');
    });

    it('caches each module after the first load', async () => {
        const [firstExcel, secondExcel] = await Promise.all([loadExcelJs(), loadExcelJs()]);
        expect(secondExcel).toBe(firstExcel);
        expect(await loadMammoth()).toBe(await loadMammoth());
    });

    it('no source file imports exceljs, mammoth or bluebird eagerly', () => {
        const srcRoot = join(__dirname, '..', '..');
        const eager =
            /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+['"](exceljs|mammoth|bluebird|unzipper)['"]|require\(\s*['"](exceljs|mammoth|bluebird|unzipper)['"]\s*\)/m;
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(path);
                    continue;
                }
                if (!entry.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(entry.name)) continue;
                if (eager.test(readFileSync(path, 'utf8'))) {
                    offenders.push(relative(srcRoot, path).split(sep).join('/'));
                }
            }
        };
        walk(srcRoot);
        expect(offenders).toEqual([]);
    });
});
