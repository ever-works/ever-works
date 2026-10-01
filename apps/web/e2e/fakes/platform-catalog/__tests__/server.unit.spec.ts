/**
 * The platform-catalog fixture server's own behaviour — and, more importantly, that the
 * fixture it serves is one the API's catalog reader **accepts whole**.
 *
 * The flags-on e2e job (`.github/workflows/e2e.yml`, `e2e-app-works-flags-on`) points the API
 * at this server through `EVER_WORKS_PLATFORM_CATALOG_BASE_URL`, and ACC-E2E-12
 * (`e2e/flow-app-launcher-apps.spec.ts`) compares the launcher's platform tiles with the
 * catalog read item for item. The reader drops what it refuses without failing the read — an
 * entry with one bad field or one `http` address is simply absent from BOTH sides of that
 * comparison, which then agrees about less than the fixture says; an oversize icon becomes an
 * initials tile; a refused document leaves no catalog at all. So the rules below are the reader's OWN
 * (`apps/api/src/app-launcher/platform-catalog.schema.ts`, the twin of the published JSON
 * Schema), imported rather than restated: a rule that changes there changes here.
 *
 * Like the fake GitHub's spec, this drives the real HTTP server on an ephemeral port: the
 * path the API builds, the status it sees and the bytes it inlines only exist once a socket
 * is involved.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_LAUNCHER_ENVIRONMENTS } from '@ever-works/contracts';

// The fake is plain ESM test infrastructure; `allowJs` in apps/web/tsconfig.json lets
// TypeScript infer its surface from the JSDoc.
import {
    DEFAULT_PORT,
    DEFAULT_REF,
    DEFAULT_REPO,
    PORT_ENV,
    createPlatformCatalogFake,
    loadCatalogFixture,
} from '../server.mjs';
// The API reader's rules, from the reader itself (see the header).
import {
    parseCatalogDocument,
    toCatalogIconDataUri,
} from '../../../../../api/src/app-launcher/platform-catalog.schema';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..');
const FIXTURE_INDEX = path.join(FIXTURE_DIR, 'platforms.json');

/**
 * The self platform's id — `DEFAULT_CATALOG_SELF_ID` in
 * `apps/api/src/app-launcher/platform-catalog.service.ts`. Restated because that module pulls
 * in `@ever-works/agent/cache`, which `apps/web` does not depend on; the lane never sets
 * `EVER_WORKS_PLATFORM_CATALOG_SELF_ID`, so the default is the id that must be present.
 */
const SELF_ID = 'ever-works';

/** The path the reader builds: `<base>/<owner>/<repo>/<ref>/<file>` (`indexUrl`/`iconUrl`). */
const INDEX_PATH = `/${DEFAULT_REPO}/${DEFAULT_REF}/platforms.json`;

interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

interface CatalogFake {
    readonly origin: string;
    readonly requestedPort: number;
    readonly repo: string;
    readonly ref: string;
    start(): Promise<string>;
    stop(): Promise<void>;
}

interface CatalogEntry {
    id: string;
    icon: string;
    urls: Record<string, string>;
}

/**
 * One request with the path sent **verbatim**. `fetch` normalises `..` segments before
 * anything leaves the process, which would make the traversal case below test the client
 * rather than the server.
 */
function raw(origin: string, rawPath: string, method = 'GET'): Promise<RawResponse> {
    const { hostname, port } = new URL(origin);
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path: rawPath, method }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                }),
            );
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function json(response: RawResponse): any {
    return JSON.parse(response.body.toString('utf8'));
}

function fixtureDocument(): { catalogVersion: string; platforms: CatalogEntry[] } {
    return JSON.parse(fs.readFileSync(FIXTURE_INDEX, 'utf8'));
}

function makeFake(options: Record<string, unknown> = {}): CatalogFake {
    return createPlatformCatalogFake({ port: 0, ...options }) as unknown as CatalogFake;
}

describe('platform-catalog fake — startup', () => {
    let fake: CatalogFake;

    afterEach(async () => {
        await fake?.stop();
    });

    it('starts in under a second and reports the fixture it serves on /_control/health', async () => {
        const startedAt = performance.now();
        fake = makeFake();
        await fake.start();
        const elapsed = performance.now() - startedAt;
        expect(elapsed, 'the lane waits on this server before booting the API').toBeLessThan(1000);

        const health = await raw(fake.origin, '/_control/health');
        expect(health.status).toBe(200);
        const document = fixtureDocument();
        expect(json(health)).toEqual({
            status: 'ok',
            repo: DEFAULT_REPO,
            ref: DEFAULT_REF,
            catalogVersion: document.catalogVersion,
            platforms: document.platforms.length,
            icons: new Set(document.platforms.map((entry) => entry.icon)).size,
        });
    });

    it('listens on its own port variable, never PORT (the runbook §4 trap the fake GitHub has)', () => {
        const savedPort = process.env.PORT;
        const savedOwn = process.env[PORT_ENV];
        try {
            process.env.PORT = '3100';
            delete process.env[PORT_ENV];
            const unset = createPlatformCatalogFake() as unknown as CatalogFake;
            expect(
                unset.requestedPort,
                'a PORT exported for the API must not move this server onto the API port',
            ).toBe(DEFAULT_PORT);

            process.env[PORT_ENV] = '4999';
            const set = createPlatformCatalogFake() as unknown as CatalogFake;
            expect(set.requestedPort).toBe(4999);

            process.env[PORT_ENV] = 'not-a-port';
            expect(() => createPlatformCatalogFake()).toThrow(PORT_ENV);
        } finally {
            if (savedPort === undefined) delete process.env.PORT;
            else process.env.PORT = savedPort;
            if (savedOwn === undefined) delete process.env[PORT_ENV];
            else process.env[PORT_ENV] = savedOwn;
        }
    });

    it('reads the coordinates the API reads, so the two agree by construction', async () => {
        const savedRepo = process.env.EVER_WORKS_PLATFORM_CATALOG_REPO;
        const savedRef = process.env.EVER_WORKS_PLATFORM_CATALOG_REF;
        try {
            process.env.EVER_WORKS_PLATFORM_CATALOG_REPO = 'ever-works/platforms-next';
            process.env.EVER_WORKS_PLATFORM_CATALOG_REF = 'v1.2.3';
            fake = makeFake();
            expect(fake.repo).toBe('ever-works/platforms-next');
            expect(fake.ref).toBe('v1.2.3');
            await fake.start();

            const moved = await raw(
                fake.origin,
                '/ever-works/platforms-next/v1.2.3/platforms.json',
            );
            expect(moved.status).toBe(200);
            const defaults = await raw(fake.origin, INDEX_PATH);
            expect(defaults.status, 'the default coordinates are not served once moved').toBe(404);
        } finally {
            if (savedRepo === undefined) delete process.env.EVER_WORKS_PLATFORM_CATALOG_REPO;
            else process.env.EVER_WORKS_PLATFORM_CATALOG_REPO = savedRepo;
            if (savedRef === undefined) delete process.env.EVER_WORKS_PLATFORM_CATALOG_REF;
            else process.env.EVER_WORKS_PLATFORM_CATALOG_REF = savedRef;
        }
    });

    it('refuses to start on a fixture it cannot serve, naming what is wrong', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-catalog-fake-'));
        try {
            fs.writeFileSync(path.join(dir, 'platforms.json'), '{ not json');
            expect(() => loadCatalogFixture(dir)).toThrow(/platforms\.json is not valid JSON/);

            fs.writeFileSync(
                path.join(dir, 'platforms.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    catalogVersion: '0.1.0',
                    platforms: [{ id: 'ever-missing', icon: 'icons/ever-missing.svg' }],
                }),
            );
            expect(() => loadCatalogFixture(dir)).toThrow(/icons\/ever-missing\.svg/);

            fs.writeFileSync(
                path.join(dir, 'platforms.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    catalogVersion: '0.1.0',
                    platforms: [{ id: 'ever-escape', icon: '../platforms.json' }],
                }),
            );
            expect(() => loadCatalogFixture(dir)).toThrow(/ever-escape/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('platform-catalog fake — what the API reads', () => {
    let fake: CatalogFake;

    beforeAll(async () => {
        fake = makeFake();
        await fake.start();
    });

    afterAll(async () => {
        await fake?.stop();
    });

    it('serves platforms.json at the raw-host path the reader builds, byte for byte', async () => {
        const response = await raw(fake.origin, INDEX_PATH);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        expect(response.body.equals(fs.readFileSync(FIXTURE_INDEX))).toBe(true);
    });

    it('is accepted WHOLE by the API reader — no entry dropped, no document error', async () => {
        const parsed = parseCatalogDocument(json(await raw(fake.origin, INDEX_PATH)));
        expect(
            'error' in parsed ? parsed.error : null,
            'the reader refused the document',
        ).toBeNull();
        if (!('catalog' in parsed)) return;
        expect(parsed.omissions, 'an omitted entry is a tile the launcher never renders').toEqual(
            [],
        );
        expect(parsed.catalog.platforms.map((entry) => entry.id).sort()).toEqual(
            fixtureDocument()
                .platforms.map((entry) => entry.id)
                .sort(),
        );
    });

    it('carries the self platform in every environment, so FR-13 comes from the catalog', () => {
        const self = fixtureDocument().platforms.find((entry) => entry.id === SELF_ID);
        expect(
            self,
            `the catalog must carry '${SELF_ID}': with other entries present and no self entry the ` +
                'launcher has NO current tile (the synthesised one is only for an empty catalog)',
        ).toBeDefined();
        for (const environment of APP_LAUNCHER_ENVIRONMENTS) {
            expect(self?.urls[environment], `${SELF_ID} has a ${environment} address`).toBeTruthy();
        }
    });

    it('lists more than the self tile in every environment, and exercises FR-10 in at least one', () => {
        const platforms = fixtureDocument().platforms;
        for (const environment of APP_LAUNCHER_ENVIRONMENTS) {
            const listed = platforms.filter((entry) => entry.urls[environment] !== undefined);
            expect(
                listed.length,
                `${environment}: the catalog-vs-launcher comparison needs more than one tile`,
            ).toBeGreaterThan(1);
        }
        expect(
            APP_LAUNCHER_ENVIRONMENTS.some((environment) =>
                platforms.some((entry) => entry.urls[environment] === undefined),
            ),
            'some entry lacks an address for some environment, so FR-10 has something to leave out',
        ).toBe(true);
    });

    it('carries no address that resolves to a real service (RFC 2606 example.com only)', () => {
        for (const entry of fixtureDocument().platforms) {
            for (const [environment, address] of Object.entries(entry.urls)) {
                const host = new URL(address).hostname;
                expect(
                    host === 'example.com' || host.endsWith('.example.com'),
                    `${entry.id}/${environment}: ${host} is not a reserved example host`,
                ).toBe(true);
            }
        }
    });

    it('serves every icon the catalog names, and each one inlines under the reader’s rules', async () => {
        for (const entry of fixtureDocument().platforms) {
            const response = await raw(
                fake.origin,
                `/${DEFAULT_REPO}/${DEFAULT_REF}/${entry.icon}`,
            );
            expect(response.status, `${entry.icon}`).toBe(200);
            expect(response.headers['content-type']).toBe(
                entry.icon.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
            );
            const inlined = toCatalogIconDataUri(entry.icon, new Uint8Array(response.body));
            expect(
                'reason' in inlined ? inlined.reason : null,
                `${entry.icon}: an icon the reader refuses renders as an initials tile`,
            ).toBeNull();
        }
    });

    it('answers only the API’s coordinates, refuses traversal and writes, and records every read', async () => {
        const misses = [
            '/ever-works/other/main/platforms.json',
            `/${DEFAULT_REPO}/develop/platforms.json`,
            `/${DEFAULT_REPO}/${DEFAULT_REF}/icons/not-in-the-catalog.svg`,
            `/${DEFAULT_REPO}/${DEFAULT_REF}/icons/../platforms.json`,
            `/${DEFAULT_REPO}/${DEFAULT_REF}/`,
            '/',
        ];
        for (const miss of misses) {
            expect((await raw(fake.origin, miss)).status, miss).toBe(404);
        }
        expect((await raw(fake.origin, INDEX_PATH, 'POST')).status).toBe(405);

        const calls = json(await raw(fake.origin, '/_control/calls'));
        const seen = (calls.calls as Array<{ method: string; path: string; status: number }>).map(
            (call) => `${call.method} ${call.path} ${call.status}`,
        );
        for (const miss of misses) {
            expect(seen, 'a miss is recorded, so a coordinate mismatch is visible').toContain(
                `GET ${miss} 404`,
            );
        }
        expect(seen).toContain(`GET ${INDEX_PATH} 200`);
        expect(seen).toContain(`POST ${INDEX_PATH} 405`);
        expect(
            seen.some((line) => line.includes('/_control/')),
            'the control routes are not catalog reads',
        ).toBe(false);
        expect(calls.count).toBe(calls.calls.length);
    });
});
