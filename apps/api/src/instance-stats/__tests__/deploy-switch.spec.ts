import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseAllDocuments } from 'yaml';

/**
 * Ever Works' own cloud deployments ship with the statistics module OFF
 * (`EVER_STATS_ENABLED: "false"` on the API container of all three
 * manifests) until Ever Platform's statistics endpoint is ready for them.
 * Turning it on for an environment is a deliberate edit of this guard and the
 * manifest in the same change. Self-hosted installations keep the default (on)
 * — the env samples document the variable commented out, so the default applies.
 */
const MANIFESTS = ['k8s-manifest.dev.yaml', 'k8s-manifest.stage.yaml', 'k8s-manifest.prod.yaml'];

interface Container {
    name: string;
    env?: Array<{ name: string; value?: unknown; valueFrom?: unknown }>;
}

function repoRoot(): string {
    let dir = __dirname;
    for (let depth = 0; depth < 10; depth += 1) {
        if (existsSync(join(dir, '.deploy', 'k8s'))) return dir;
        dir = join(dir, '..');
    }
    throw new Error(`repository root not found from ${__dirname}`);
}

function apiContainer(file: string): Container {
    const text = readFileSync(join(repoRoot(), '.deploy', 'k8s', file), 'utf8');
    expect(text.length).toBeGreaterThan(1_000);
    const docs = parseAllDocuments(text);
    expect(docs.flatMap((doc) => doc.errors)).toEqual([]);
    const containers = docs
        .map(
            (doc) =>
                doc.toJS() as {
                    kind?: string;
                    spec?: { template?: { spec?: { containers?: Container[] } } };
                },
        )
        .filter((doc) => doc?.kind === 'Deployment')
        .flatMap((doc) => doc.spec?.template?.spec?.containers ?? []);
    const api = containers.find((container) => container.name.startsWith('ever-works-api'));
    if (!api) throw new Error(`${file}: no ever-works-api container`);
    return api;
}

describe('anonymous usage statistics — deployment switch', () => {
    it.each(MANIFESTS)('%s ships the module off on the API container', (file) => {
        const entries = (apiContainer(file).env ?? []).filter(
            (entry) => entry.name === 'EVER_STATS_ENABLED',
        );
        expect(entries).toHaveLength(1);
        // A literal, readable value — never one hidden behind a Secret.
        expect(entries[0].valueFrom).toBeUndefined();
        expect(entries[0].value).toBe('false');
    });

    it.each([join('apps', 'api', '.env.example'), '.env.compose'])(
        '%s documents every statistics variable, commented out so the defaults apply',
        (file) => {
            const text = readFileSync(join(repoRoot(), file), 'utf8');
            for (const name of [
                'EVER_STATS_ENABLED',
                'EVER_STATS_API_URL',
                'EVER_PLATFORM_API_URL',
                'EVER_STATS_COUNTRY',
                'EVER_STATS_SEND_INTERVAL_S',
                'EVER_INSTALL_SOURCE',
                'EVER_WORKS_STATS_SINK',
            ]) {
                expect(text).toMatch(new RegExp(`^# ${name}=`, 'm'));
                expect(text).not.toMatch(new RegExp(`^${name}=`, 'm'));
            }
        },
    );
});
