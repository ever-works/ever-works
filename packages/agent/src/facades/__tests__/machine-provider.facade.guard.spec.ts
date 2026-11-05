import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';

/**
 * Cloud computers (FL-17, T-09, Constitution I/II, spec ACC-FL17-01) — core
 * code never names a machine-provider plugin: it resolves providers through
 * `MachineProviderFacadeService` by capability. This walks the core trees and
 * fails on any mention of the first provider outside its own plugin package
 * (tests excluded: they may name a fixture). User copy shows the provider's
 * name from the plugin's own `providerName`, never from core.
 */

const ROOT = resolve(__dirname, '../../../../..');
const TREES = [
    'packages/agent/src',
    'apps/api/src',
    'apps/web/src',
    'apps/mcp/src',
    'apps/cli/src',
    'packages/contracts/src',
];
const PROVIDER = /digital\s*ocean/i;

/**
 * Mentions that are not a route to the provider, each pinned to one file and one
 * exact literal, so any OTHER mention in that file still fails.
 *
 * - The host-credential deny-list refuses the provider CLI's env namespace in a
 *   check's `envPassthrough` (a check must not read the host's cloud token). It
 *   names an environment variable family, never the provider plugin, and it must
 *   stay complete, so FL-17 does not apply to it.
 */
const PERMITTED_MENTIONS: Record<string, readonly string[]> = {
    'packages/contracts/src/tasks/check-env-host-credentials.types.ts': ["'DIGITALOCEAN_',"],
};

function namesTheProvider(relativePath: string, text: string): boolean {
    let rest = text;
    for (const literal of PERMITTED_MENTIONS[relativePath.split(sep).join('/')] ?? []) {
        rest = rest.split(literal).join('');
    }
    return PROVIDER.test(rest);
}

function walk(dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (
            entry === 'node_modules' ||
            entry === 'dist' ||
            entry === '__tests__' ||
            entry === '.next'
        )
            continue;
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, out);
        else if (
            /\.(ts|tsx)$/.test(entry) &&
            !/\.spec\.tsx?$/.test(entry) &&
            !/\.test\.tsx?$/.test(entry)
        )
            out.push(path);
    }
}

describe('machine providers are reached by capability only (FL-17)', () => {
    it('no core source file names the first provider', () => {
        const files: string[] = [];
        for (const tree of TREES) walk(join(ROOT, tree), files);
        expect(files.length).toBeGreaterThan(100);
        const offenders = files
            .map((file) => file.slice(ROOT.length + 1))
            .filter((relative) =>
                namesTheProvider(relative, readFileSync(join(ROOT, relative), 'utf8')),
            );
        expect(offenders).toEqual([]);
    });

    it('a permitted mention excuses only its exact literal in its own file', () => {
        const [path] = Object.keys(PERMITTED_MENTIONS);
        expect(namesTheProvider(path, "\t\t\t'DIGITALOCEAN_',\n")).toBe(false);
        expect(
            namesTheProvider(path, "'DIGITALOCEAN_',\nimport { x } from 'digitalocean-plugin';"),
        ).toBe(true);
        expect(namesTheProvider('packages/agent/src/other.ts', "'DIGITALOCEAN_',")).toBe(true);
    });
});
