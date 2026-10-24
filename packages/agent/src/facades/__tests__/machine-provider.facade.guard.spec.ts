import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Cloud computers (FL-17, T-09, Constitution I/II, spec ACC-FL17-01) — core
 * code never names a machine-provider plugin: it resolves providers through
 * `MachineProviderFacadeService` by capability. This walks the core trees and
 * fails on any mention of the first provider outside its own plugin package
 * (tests excluded: they may name a fixture). User copy shows the provider's
 * name from the plugin's own `providerName`, never from core.
 */

const ROOT = resolve(__dirname, '../../../../..');
const TREES = ['packages/agent/src', 'apps/api/src', 'apps/web/src', 'apps/mcp/src', 'apps/cli/src', 'packages/contracts/src'];
const PROVIDER = /digital\s*ocean/i;

function walk(dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__' || entry === '.next') continue;
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, out);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.spec\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
    }
}

describe('machine providers are reached by capability only (FL-17)', () => {
    it('no core source file names the first provider', () => {
        const files: string[] = [];
        for (const tree of TREES) walk(join(ROOT, tree), files);
        expect(files.length).toBeGreaterThan(100);
        const offenders = files.filter((file) => PROVIDER.test(readFileSync(file, 'utf8')));
        expect(offenders.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
    });
});
