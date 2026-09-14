import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Constitution II — capability-driven, no hardcoded plugin identifiers.
 *
 * Workspace search reads the platform's own records only; it must never branch
 * on, or embed, a specific plugin id. The known ids are read from every plugin
 * package's own `everworks.plugin.id`, so a newly added plugin is covered
 * without editing this spec. Only string literals count, so prose in comments
 * that happens to contain a common word is not a false positive.
 */
const MODULE_ROOT = join(__dirname, '..');
const PLUGINS_ROOT = join(__dirname, '..', '..', '..', '..', 'plugins');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
        return path.endsWith('.ts') ? [path] : [];
    });
}

function knownPluginIds(): string[] {
    return readdirSync(PLUGINS_ROOT).flatMap((name) => {
        try {
            const manifest = JSON.parse(
                readFileSync(join(PLUGINS_ROOT, name, 'package.json'), 'utf8'),
            ) as {
                everworks?: { plugin?: { id?: string } };
            };
            const id = manifest.everworks?.plugin?.id;
            return id ? [id] : [];
        } catch {
            return [];
        }
    });
}

describe('workspace-search — no hardcoded plugin identifiers', () => {
    const ids = knownPluginIds();

    it('discovers the plugin catalogue (guards against a vacuous pass)', () => {
        expect(ids.length).toBeGreaterThan(10);
    });

    it('contains no plugin id as a string literal', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(MODULE_ROOT)) {
            const text = readFileSync(file, 'utf8');
            for (const id of ids) {
                const escaped = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
                if (new RegExp(`['"\`]${escaped}['"\`]`).test(text)) {
                    offenders.push(`${relative(MODULE_ROOT, file)} → ${id}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
