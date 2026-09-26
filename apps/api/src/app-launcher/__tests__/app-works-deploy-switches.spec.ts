import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * APW-01 T7's deployment half — `EVER_WORKS_APP_WORKS_ENABLED` in the API **and**
 * the web container of all three manifests.
 *
 * The launcher's spec next door (`launcher-deploy-switches.spec.ts`) asserts that
 * its catalog variables reach the API container and **no other**: the catalog is
 * fetched inside the API process, so a copy on the web container would be a
 * second configuration nothing reads. This switch is the exact opposite, and
 * that is why it needs its own guard rather than a line in that one:
 *
 *  - the **API** reads it through `config.everWorks.apps.worksEnabled()`, and
 *  - the **web** gate reads the same variable name at request time
 *    (`apps/web/src/lib/feature-flags/work-kinds.ts`),
 *
 * so publishing it to one side only is precisely how the picker and the API come
 * to disagree — the failure the one-convention decision exists to prevent.
 *
 * The VALUE is not pinned beyond `'true'`/`'false'`: flipping it is an operator's
 * whole operation, and a test that failed when someone switched App Works on
 * would be fighting the feature. What IS pinned is that the two containers agree
 * with each other in every file, because a half-flipped instance is the bug.
 */

const FILE = 'EVER_WORKS_APP_WORKS_ENABLED';

const MANIFESTS = ['k8s-manifest.dev.yaml', 'k8s-manifest.stage.yaml', 'k8s-manifest.prod.yaml'];

interface Container {
    name: string;
    env?: Array<{ name: string; value?: unknown }>;
}

interface Deployment {
    kind?: string;
    metadata?: { name?: string };
    spec?: { template?: { spec?: { containers?: Container[] } } };
}

/**
 * The repository root, found by walking up to the directory that holds
 * `.deploy/k8s` — never by counting `..`, and never by guessing: a spec that
 * silently read the wrong file would pass for the wrong reason.
 */
function repoRoot(): string {
    let dir = __dirname;
    for (let depth = 0; depth < 10; depth += 1) {
        if (existsSync(join(dir, '.deploy', 'k8s'))) return dir;
        dir = join(dir, '..');
    }
    throw new Error(`repository root not found by walking up from ${__dirname}`);
}

function containers(file: string): Container[] {
    const text = readFileSync(join(repoRoot(), '.deploy', 'k8s', file), 'utf8');
    // Vacuity check: a file that failed to read, or that shrank to nothing, must
    // not be able to satisfy the assertions below by being empty.
    expect(text.length).toBeGreaterThan(1_000);

    const docs = parseAllDocuments(text);
    expect(docs.flatMap((doc) => doc.errors)).toEqual([]);

    return docs
        .map((doc) => doc.toJS() as Deployment | null)
        .filter(Boolean)
        .filter((doc) => doc?.kind === 'Deployment')
        .flatMap((deployment) => deployment.spec?.template?.spec?.containers ?? []);
}

function apiContainer(file: string): Container {
    const found = containers(file).find((container) => container.name.startsWith('ever-works-api'));
    if (!found) throw new Error(`${file}: no ever-works-api container`);
    return found;
}

function webContainer(file: string): Container {
    const found = containers(file).find((container) => container.name.startsWith('ever-works-web'));
    if (!found) throw new Error(`${file}: no ever-works-web container`);
    return found;
}

function valueOf(container: Container, name: string): unknown {
    return container.env?.find((entry) => entry.name === name)?.value;
}

describe('APW-01 T7 — the App Works switch in the deploy manifests', () => {
    it.each(MANIFESTS)('reaches the API container of %s', (file) => {
        expect(apiContainer(file).env?.some((entry) => entry.name === FILE)).toBe(true);
    });

    it.each(MANIFESTS)('reaches the web container of %s too, deliberately', (file) => {
        // Not a copy that nothing reads: the web gate reads this variable at
        // request time. See the file's docstring.
        expect(webContainer(file).env?.some((entry) => entry.name === FILE)).toBe(true);
    });

    it.each(MANIFESTS)('gives %s a value the readers can act on', (file) => {
        expect(['true', 'false']).toContain(valueOf(apiContainer(file), FILE));
        expect(['true', 'false']).toContain(valueOf(webContainer(file), FILE));
    });

    it.each(MANIFESTS)('keeps the two halves of %s in step', (file) => {
        // A half-flipped instance is the bug this file exists to prevent: the
        // API would build an `app` Work the picker never offers, or the picker
        // would offer one the API refuses.
        expect(valueOf(webContainer(file), FILE)).toBe(valueOf(apiContainer(file), FILE));
    });

    it('documents the variable, with its default, in apps/api/.env.example', () => {
        const text = readFileSync(join(repoRoot(), 'apps', 'api', '.env.example'), 'utf8');
        expect(text.length).toBeGreaterThan(1_000);
        expect(text).toMatch(/^EVER_WORKS_APP_WORKS_ENABLED=false$/m);
    });
});
