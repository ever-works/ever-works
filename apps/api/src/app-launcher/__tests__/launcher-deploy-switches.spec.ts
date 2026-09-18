import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * APW-11 T31 — the App Launcher's operator switches, checked where they are
 * actually set rather than in one hand-run `git grep`.
 *
 * The task's Test line asks for `git grep -n "EVER_WORKS_APP_LAUNCHER_ENABLED\|
 * EVER_WORKS_PLATFORM_CATALOG"` to show all five variables in all three
 * manifests and in `.env.example`. That is a check someone has to remember to
 * run, and it cannot tell a variable that is set on the right container from
 * one that is set on the wrong one — which is the mistake that matters here,
 * because `PlatformCatalogService` (T8) fetches the catalog **inside the API
 * process** (plan §5.2, APW11-G06): a browser route cannot stand in for it, and
 * neither can a variable that only reaches the web container.
 *
 * So this spec reads the three manifests as YAML and asserts, per file:
 *
 *   1. the API container carries all five variables, and
 *   2. no other container carries the catalog variables — the API owns that
 *      read, and a copy on the web container would be a second, silently
 *      diverging configuration,
 *   3. `_ENV` is the environment of THAT file (`develop` / `stage` /
 *      `production`), never the `production` default (spec FR-10, APW11-G19),
 *      and
 *   4. the launcher switch is exactly `'true'` or `'false'` — the guard
 *      compares against the string `'true'`, so `1`/`yes`/an empty value would
 *      read as ON by a human and OFF by the code. The VALUE itself is not
 *      pinned: flipping it is the operator's whole operation (XC-10, FR-65),
 *      and a test that failed when someone turned the launcher on would be
 *      fighting the feature it guards.
 *
 * `.env.example` is checked for the same five names, so a developer's local
 * run has them documented with their defaults.
 */

/** The variables APW-11 introduces, and the container that must carry them. */
const CATALOG_VARIABLES = [
    'EVER_WORKS_PLATFORM_CATALOG_REPO',
    'EVER_WORKS_PLATFORM_CATALOG_REF',
    'EVER_WORKS_PLATFORM_CATALOG_ENV',
    'EVER_WORKS_PLATFORM_CATALOG_SELF_ID',
] as const;

const LAUNCHER_FLAG = 'EVER_WORKS_APP_LAUNCHER_ENABLED';

const EXPECTED_VARIABLES = [LAUNCHER_FLAG, ...CATALOG_VARIABLES];

/** `_ENV` is per file: the default `production` on stage shows the wrong addresses. */
const MANIFESTS: Array<{ file: string; environment: string }> = [
    { file: 'k8s-manifest.dev.yaml', environment: 'develop' },
    { file: 'k8s-manifest.stage.yaml', environment: 'stage' },
    { file: 'k8s-manifest.prod.yaml', environment: 'production' },
];

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
 * silently read the wrong file (or no file) would pass for the wrong reason.
 */
function repoRoot(): string {
    let dir = __dirname;
    for (let depth = 0; depth < 10; depth += 1) {
        if (existsSync(join(dir, '.deploy', 'k8s'))) {
            return dir;
        }
        dir = join(dir, '..');
    }
    throw new Error(`repository root not found by walking up from ${__dirname}`);
}

function deploymentsIn(file: string): Deployment[] {
    const text = readFileSync(join(repoRoot(), '.deploy', 'k8s', file), 'utf8');
    // Vacuity check: a file that failed to read, or that shrank to nothing,
    // must not be able to satisfy the assertions below by being empty.
    expect(text.length).toBeGreaterThan(1_000);

    const docs = parseAllDocuments(text);
    expect(docs.flatMap((doc) => doc.errors)).toEqual([]);

    const parsed = docs.map((doc) => doc.toJS() as Deployment | null).filter(Boolean);
    return parsed.filter((doc) => doc?.kind === 'Deployment') as Deployment[];
}

function apiContainer(deployments: Deployment[]): Container {
    const containers = deployments.flatMap(
        (deployment) => deployment.spec?.template?.spec?.containers ?? [],
    );
    const api = containers.find((container) => container.name.startsWith('ever-works-api'));
    if (!api) {
        throw new Error(
            `no ever-works-api container in the manifest (found: ${containers
                .map((container) => container.name)
                .join(', ')})`,
        );
    }
    return api;
}

function envValue(container: Container, name: string): unknown {
    return container.env?.find((entry) => entry.name === name)?.value;
}

describe('APW-11 T31 — the launcher switches in the deploy manifests', () => {
    it.each(MANIFESTS)('sets all five variables on the API container of $file', ({ file }) => {
        const deployments = deploymentsIn(file);
        expect(deployments.length).toBeGreaterThan(0);

        const api = apiContainer(deployments);
        for (const name of EXPECTED_VARIABLES) {
            expect(api.env?.some((entry) => entry.name === name)).toBe(true);
        }
    });

    it.each(MANIFESTS)(
        'sets $environment as the catalog environment of $file',
        ({ file, environment }) => {
            const api = apiContainer(deploymentsIn(file));

            expect(envValue(api, 'EVER_WORKS_PLATFORM_CATALOG_ENV')).toBe(environment);
        },
    );

    it.each(MANIFESTS)('leaves the catalog read to the API in $file', ({ file }) => {
        // Plan §5.2 / APW11-G06: the fetch happens in the API process. A copy of
        // these variables on the web container would be a second configuration
        // that nothing reads and that can silently disagree with the first.
        const deployments = deploymentsIn(file);
        const containers = deployments.flatMap(
            (deployment) => deployment.spec?.template?.spec?.containers ?? [],
        );
        const others = containers.filter(
            (container) => !container.name.startsWith('ever-works-api'),
        );

        expect(others.length).toBeGreaterThan(0);
        for (const container of others) {
            for (const name of CATALOG_VARIABLES) {
                expect(container.env?.some((entry) => entry.name === name) ?? false).toBe(false);
            }
        }
    });

    it.each(MANIFESTS)(
        'gives the launcher switch of $file a value the guard can read',
        ({ file }) => {
            const api = apiContainer(deploymentsIn(file));
            const value = envValue(api, LAUNCHER_FLAG);

            // `'true'` exactly, or `'false'`: the guard answers 404 unless the value
            // is the string `'true'`, so anything else is OFF to the code while
            // looking ON to a person editing the file.
            expect(['true', 'false']).toContain(value);
        },
    );

    it('documents the same five variables, with their defaults, in apps/api/.env.example', () => {
        const text = readFileSync(join(repoRoot(), 'apps', 'api', '.env.example'), 'utf8');
        expect(text.length).toBeGreaterThan(1_000);

        for (const name of EXPECTED_VARIABLES) {
            expect(text).toMatch(new RegExp(`^${name}=`, 'm'));
        }
        // The documented default is what an installation gets when it sets
        // nothing: the launcher off, and the catalog repo/ref/id the service
        // falls back to. `production` for `_ENV` is the documented default the
        // manifests deliberately override per environment.
        expect(text).toMatch(/^EVER_WORKS_APP_LAUNCHER_ENABLED=false$/m);
        expect(text).toMatch(/^EVER_WORKS_PLATFORM_CATALOG_REPO=ever-works\/platforms$/m);
        expect(text).toMatch(/^EVER_WORKS_PLATFORM_CATALOG_REF=main$/m);
        expect(text).toMatch(/^EVER_WORKS_PLATFORM_CATALOG_ENV=production$/m);
        expect(text).toMatch(/^EVER_WORKS_PLATFORM_CATALOG_SELF_ID=ever-works$/m);
    });
});
