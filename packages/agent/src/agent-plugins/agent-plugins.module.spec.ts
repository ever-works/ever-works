import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Module-shape guard.
 *
 * Nest lets a module list a provider in `exports` that appears in neither
 * `providers` nor `imports`. That compiles, passes every unit test, and fails
 * only when the DI container is actually built — which the API's
 * `generate:openapi` gate does NOT do, because it runs in preview mode and
 * never instantiates providers. The result is a pod that crash-loops at boot
 * with every check green.
 *
 * This happened while building this module: six providers were appended to
 * `exports` while the edit that was supposed to add them to `providers` had
 * silently matched nothing. A static check is cheap and catches exactly that.
 *
 * It reads the source rather than importing the module so it needs no
 * database, no TypeORM connection and no Nest container.
 */

const MODULE_PATH = join(__dirname, 'agent-plugins.module.ts');

function block(source: string, key: 'providers' | 'exports' | 'imports'): string {
    const start = source.indexOf(`${key}: [`);
    if (start === -1) return '';
    let depth = 0;
    for (let i = source.indexOf('[', start); i < source.length; i += 1) {
        if (source[i] === '[') depth += 1;
        else if (source[i] === ']') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return '';
}

/** Bare identifiers listed on their own line in a decorator array. */
function identifiers(text: string): string[] {
    return [...text.matchAll(/^\s*([A-Z][A-Za-z0-9_]*|[A-Z][A-Z0-9_]*),\s*$/gmu)].map(
        (match) => match[1],
    );
}

/**
 * Everything a `providers` array supplies: bare classes AND the tokens of
 * object-literal providers.
 *
 * The second half matters — `{ provide: SOME_TOKEN, useExisting: X }` supplies
 * `SOME_TOKEN`, and a checker that only reads bare identifiers would report
 * the token as exported-but-not-provided. That false positive would train
 * whoever hits it to disable this guard, which is worse than not having it.
 */
function suppliedBy(text: string): Set<string> {
    const names = identifiers(text);
    const tokens = [...text.matchAll(/provide:\s*([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
        (match) => match[1],
    );
    return new Set([...names, ...tokens]);
}

describe('AgentPluginsModule shape', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');

    it('provides or imports everything it exports', () => {
        const provided = suppliedBy(block(source, 'providers'));
        const imported = new Set(identifiers(block(source, 'imports')));
        const exported = identifiers(block(source, 'exports'));

        expect(exported.length).toBeGreaterThan(0);

        const unsatisfied = exported.filter((name) => !provided.has(name) && !imported.has(name));

        expect(unsatisfied).toEqual([]);
    });

    it('still binds the skills-provider token through useExisting', () => {
        // The facade consumes this @Optional(); losing the binding would make
        // package skills silently vanish rather than fail loudly.
        expect(source).toContain('provide: AGENT_PLUGIN_SKILL_SOURCE');
        expect(source).toContain('useExisting: AgentPluginPackageCatalogService');
    });

    it('registers every entity it queries with forFeature', () => {
        // Registering an entity ONLY in the inventory compiles, boots, and then
        // throws EntityMetadataNotFoundError on the first query.
        const imports = block(source, 'imports');
        for (const entity of [
            'AgentPluginPackage',
            'AgentPluginPackageAllowlist',
            'McpServerConnection',
        ]) {
            expect(imports).toContain(entity);
        }
    });
});
