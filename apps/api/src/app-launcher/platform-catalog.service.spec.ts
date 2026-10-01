// The service imports the cache barrel for the `CACHE_MANAGER` token and the
// `Cache` type only. This is a pure unit test (no Nest DI), so the barrel is
// stubbed — exactly as `works-template-catalog.service.spec.ts` does.
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: 'CACHE_MANAGER', Cache: class {} }));

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { APP_LAUNCHER_ICON_MAX_BYTES } from '@ever-works/contracts';
import type { Cache } from '@ever-works/agent/cache';
import {
    PLATFORM_CATALOG_FAILURE_TTL_MS,
    PLATFORM_CATALOG_FETCH_TIMEOUT_MS,
    PLATFORM_CATALOG_ICON_BATCH_SIZE,
    PLATFORM_CATALOG_LAST_GOOD_TTL_MS,
    PLATFORM_CATALOG_SUCCESS_TTL_MS,
    PlatformCatalogService,
} from './platform-catalog.service';

/**
 * APW-11 T8 — `PlatformCatalogService` (plan §5.2).
 *
 * ## The fixture is the catalog drafts' own file, not a copy
 *
 * The cases come from
 * `docs/specs/features/app-works/APW-11-app-launcher/catalog-draft/fixtures/platforms.fixture.json`
 * — the file whose `$comment` names this spec as its consumer. It is read from
 * the working tree (found by walking up to the directory that holds
 * `.deploy/k8s`; a wrong path throws rather than passing silently), so a case
 * added to the fixture is exercised here the moment it is added and there is no
 * second copy to drift. Its two byte-heavy icons are **generated here**, as the
 * fixture says: no 16 KB blob is committed anywhere.
 *
 * The fixture is deliberately not a valid catalog — several of its cases must
 * fail validation, which is the point — so the spec builds the index from
 * `cases[].entry` (in fixture order) and asserts each case's own `expect`
 * outcome: `javascript:`, `http:` and the 25th entry produce no tile
 * (ACC-11-08), an oversize icon keeps its entry without one (plan §9.2), an SVG
 * carrying `<script` or `<foreignObject` is refused while its platform stays,
 * and `evil/platforms` is refused at boot.
 *
 * ## No test can reach the network
 *
 * `globalThis.fetch` is replaced with a throwing stub in `beforeEach`, and the
 * service is handed an injected fetch whose every response is built here: the
 * index URL is asserted **as requested** (`…/ever-works/platforms/main/platforms.json`),
 * every icon URL is asserted, an unexpected URL fails the test rather than
 * escaping to the internet, and the batch of six is measured on real overlap.
 *
 * ACC ids asserted: ACC-11-05 (the running environment's addresses, and an entry
 * without one absent), ACC-11-07 (blocked source: S9 with no prior read, the
 * last good list after one), ACC-11-08 (`javascript:` / `http:` / 25th entry),
 * ACC-11-51 (the non-production override, both halves).
 */

/* -------------------------------------------------------------------------- */
/* The repository root and the draft fixture                                   */
/* -------------------------------------------------------------------------- */

/**
 * The repository root, found by walking up to the directory that holds
 * `.deploy/k8s` — never by counting `..`: a spec that silently read the wrong
 * file (or no file) would pass for the wrong reason.
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

const FIXTURE_PATH = join(
    repoRoot(),
    'docs',
    'specs',
    'features',
    'app-works',
    'APW-11-app-launcher',
    'catalog-draft',
    'fixtures',
    'platforms.fixture.json',
);

interface FixtureCase {
    name: string;
    expect: string;
    entry: Record<string, unknown> | null;
}

interface FixtureFile {
    $comment?: string;
    generatedIcons: Record<string, string>;
    cases: FixtureCase[];
}

const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT) as FixtureFile;

/** One fixture case's entry, by the name the fixture gives it. */
function fixtureEntry(name: string): Record<string, unknown> {
    const found = FIXTURE.cases.find((entry) => entry.name === name);
    if (!found || !found.entry) {
        throw new Error(
            `the draft fixture has no usable case "${name}" (cases: ${FIXTURE.cases
                .map((entry) => entry.name)
                .join(', ')})`,
        );
    }
    return found.entry;
}

/** Every case that carries an entry, in fixture order — the model catalog. */
function fixtureEntries(): Record<string, unknown>[] {
    return FIXTURE.cases.filter((entry) => entry.entry !== null).map((entry) => entry.entry!);
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';

/**
 * The icons the fixture says the spec writes at test time, plus a clean default
 * for every other path the model catalog references.
 */
const GENERATED_ICONS: Record<string, Uint8Array> = {
    // "Buffer.alloc(16385, 'x') wrapped in a minimal <svg> element — one byte
    // over APP_LAUNCHER_ICON_MAX_BYTES (16,384)."
    'icons/oversize.svg': Buffer.concat([
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),
        Buffer.alloc(16_385, 'x'),
        Buffer.from('</svg>'),
    ]),
    'icons/script.svg': Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ),
    'icons/foreign-object.svg': Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    ),
};

function iconBytesFor(iconPath: string): Uint8Array {
    return GENERATED_ICONS[iconPath] ?? Buffer.from(CLEAN_SVG);
}

/* -------------------------------------------------------------------------- */
/* A catalog served by the mocked fetch                                        */
/* -------------------------------------------------------------------------- */

const CATALOG_BASE = 'https://catalog.test';
const RAW_HOST = 'https://raw.githubusercontent.com';
const INDEX_SUFFIX = '/platforms.json';
const ICON_PATH_RE = /(icons\/[a-z0-9-]+\.(?:svg|png))$/;

interface ServedRequest {
    url: string;
    init?: RequestInit;
}

interface CatalogServer {
    fetchImpl: typeof fetch;
    requests: ServedRequest[];
    urls: string[];
    /** The most icon/index requests in flight at once (plan §5.2's batch of 6). */
    peakInFlight: number;
    setCatalog(catalog: string): void;
    setBlocked(blocked: boolean): void;
}

function okResponse(body: string | Uint8Array): Response {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    return {
        ok: true,
        status: 200,
        text: async () => bytes.toString('utf8'),
        arrayBuffer: async () =>
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
        headers: { get: () => null },
    } as unknown as Response;
}

function errorResponse(status: number): Response {
    return {
        ok: false,
        status,
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
    } as unknown as Response;
}

/** A catalog index carrying the given entries (fixture cases by default). */
function catalogOf(entries: unknown[], catalogVersion = '1.0.0'): string {
    return JSON.stringify({ schemaVersion: 1, catalogVersion, platforms: entries });
}

function modelCatalog(): string {
    return catalogOf(fixtureEntries());
}

/** The fixture's 25th-entry case: the first valid entry repeated under 25 ids. */
function twentyFiveEntries(): Record<string, unknown>[] {
    const template = fixtureEntry('valid');
    return Array.from({ length: 25 }, (_unused, index) => ({
        ...template,
        id: `ever-${index + 1}`,
        name: `Ever ${index + 1}`,
        icon: `icons/ever-${index + 1}.svg`,
        order: index + 1,
    }));
}

/**
 * The mocked fetch: routes `…/platforms.json` and `…/icons/<file>` and throws
 * on anything else, so an unexpected URL fails the test instead of leaving the
 * process. Every request is recorded, which is how the URL assertions below are
 * made.
 */
function installCatalogServer(
    options: { catalog?: string; blocked?: boolean; iconStatus?: number } = {},
): CatalogServer {
    let catalog = options.catalog ?? modelCatalog();
    let blocked = options.blocked === true;
    let inFlight = 0;
    const requests: ServedRequest[] = [];

    const handler = async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        requests.push({ url, init });

        if (blocked) {
            const aborted = new Error('The operation was aborted due to timeout');
            aborted.name = 'AbortError';
            throw aborted;
        }

        inFlight += 1;
        server.peakInFlight = Math.max(server.peakInFlight, inFlight);
        try {
            // A real await, so "six at a time" is measured on genuine overlap
            // rather than on the synchronous part of the handler.
            await new Promise((resolve) => setTimeout(resolve, 0));

            if (url.endsWith(INDEX_SUFFIX)) {
                return okResponse(catalog);
            }
            const iconMatch = ICON_PATH_RE.exec(url);
            if (iconMatch) {
                if (options.iconStatus && options.iconStatus >= 400) {
                    return errorResponse(options.iconStatus);
                }
                return okResponse(iconBytesFor(iconMatch[1]));
            }
            throw new Error(`unexpected catalog request: ${url}`);
        } finally {
            inFlight -= 1;
        }
    };

    const server: CatalogServer = {
        fetchImpl: ((input: unknown, init?: RequestInit) =>
            handler(input, init)) as unknown as typeof fetch,
        requests,
        urls: requests.map((entry) => entry.url),
        peakInFlight: 0,
        setCatalog(next: string) {
            catalog = next;
        },
        setBlocked(next: boolean) {
            blocked = next;
        },
    };

    // `urls` must stay a live view of `requests` for the assertions below.
    Object.defineProperty(server, 'urls', { get: () => requests.map((entry) => entry.url) });

    return server;
}

/* -------------------------------------------------------------------------- */
/* A cache with real TTL semantics                                             */
/* -------------------------------------------------------------------------- */

/**
 * A Map-backed cache that records every write (key and TTL) and honours TTLs
 * the way a store does — `ttl: 0` never expires. `expireTimedEntries()` is what
 * the passage of time does to it, which is how the spec proves the 1-hour, the
 * 30-second and the "no TTL at all" behaviours without waiting.
 */
class FakeCache {
    readonly writes: Array<{ key: string; ttl: number | undefined }> = [];
    private readonly entries = new Map<string, { value: unknown; ttl: number; storedAt: number }>();

    async get<T>(key: string): Promise<T | undefined> {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.ttl > 0 && Date.now() - entry.storedAt >= entry.ttl) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value as T;
    }

    async set<T>(key: string, value: T, ttl?: number): Promise<T> {
        this.entries.set(key, { value, ttl: ttl ?? 0, storedAt: Date.now() });
        this.writes.push({ key, ttl });
        return value;
    }

    async del(key: string): Promise<boolean> {
        return this.entries.delete(key);
    }

    /** Everything that carries a TTL is gone; everything stored with `0` stays. */
    expireTimedEntries(): void {
        for (const [key, entry] of [...this.entries.entries()]) {
            if (entry.ttl > 0) {
                this.entries.delete(key);
            }
        }
    }

    keys(): string[] {
        return [...this.entries.keys()];
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    ttlFor(key: string): number | undefined {
        return this.entries.get(key)?.ttl;
    }

    writesFor(key: string): Array<number | undefined> {
        return this.writes.filter((entry) => entry.key === key).map((entry) => entry.ttl);
    }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

interface Harness {
    service: PlatformCatalogService;
    cache: FakeCache;
    server: CatalogServer;
}

/** Set the documented defaults for one test (every variable is restored after it). */
function setCatalogEnv(overrides: Record<string, string | undefined> = {}): void {
    process.env.NODE_ENV = 'test';
    process.env.EVER_WORKS_E2E_FAKES = '1';
    process.env.EVER_WORKS_PLATFORM_CATALOG_BASE_URL = CATALOG_BASE;
    process.env.EVER_WORKS_PLATFORM_CATALOG_ENV = 'production';
    process.env.EVER_WORKS_PLATFORM_CATALOG_REPO = 'ever-works/platforms';
    delete process.env.EVER_WORKS_PLATFORM_CATALOG_REF;
    delete process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID;

    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
}

function makeHarness(
    options: {
        server?: CatalogServer;
        cache?: FakeCache;
        env?: Record<string, string | undefined>;
        injectFetch?: boolean;
    } = {},
): Harness {
    setCatalogEnv(options.env);
    const server = options.server ?? installCatalogServer();
    const cache = options.cache ?? new FakeCache();
    const service = new PlatformCatalogService(
        cache as unknown as Cache,
        options.injectFetch === false ? undefined : server.fetchImpl,
    );
    return { service, cache, server };
}

function spyOnLogger(): { warn: jest.SpyInstance; error: jest.SpyInstance; log: jest.SpyInstance } {
    return {
        warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
        error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
        log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    };
}

function messagesOf(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
}

function messagesContaining(spy: jest.SpyInstance, needle: string): string[] {
    return messagesOf(spy).filter((message) => message.includes(needle));
}

function keysOf(items: Array<{ key: string }>): string[] {
    return items.map((item) => item.key);
}

beforeEach(() => {
    // Nothing in this suite may reach the network: the default fetch throws.
    globalThis.fetch = jest.fn(() => {
        throw new Error('a test attempted a real network request');
    }) as unknown as typeof fetch;
});

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
});

afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

/* -------------------------------------------------------------------------- */

describe('APW-11 T8 — PlatformCatalogService', () => {
    describe('the draft fixture (vacuity guard)', () => {
        it("is the catalog drafts' own fixture, carrying the cases this spec asserts", () => {
            expect(FIXTURE_PATH).toMatch(
                /docs[\\/]specs[\\/]features[\\/]app-works[\\/]APW-11-app-launcher[\\/]catalog-draft[\\/]fixtures[\\/]platforms\.fixture\.json$/,
            );
            expect(FIXTURE_TEXT.length).toBeGreaterThan(1_000);
            expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(12);

            const names = FIXTURE.cases.map((entry) => entry.name);
            for (const name of [
                'valid',
                'missingDevelopUrl',
                'javascriptUrl',
                'httpUrl',
                'oversizeIcon',
                'scriptIcon',
                'twentyFifthEntry',
            ]) {
                expect(names).toContain(name);
            }

            // The fixture's three generated icons are described, not committed —
            // which is why this spec writes their bytes.
            expect(Object.keys(FIXTURE.generatedIcons)).toEqual(
                expect.arrayContaining([
                    'icons/oversize.svg',
                    'icons/script.svg',
                    'icons/foreign-object.svg',
                ]),
            );
            expect(GENERATED_ICONS['icons/oversize.svg'].byteLength).toBeGreaterThan(
                APP_LAUNCHER_ICON_MAX_BYTES,
            );
        });
    });

    describe('repository coordinates (plan §5.2 SSRF containment)', () => {
        it('refuses a repo outside the ever-works org at BOOT', () => {
            for (const repo of [
                'evil/platforms',
                'attacker/ever-works',
                'ever-works/Platforms',
                'ever-works/platforms/../../etc',
                'https://evil.test/platforms',
                'ever-works',
            ]) {
                setCatalogEnv({ EVER_WORKS_PLATFORM_CATALOG_REPO: repo });
                expect(
                    () =>
                        new PlatformCatalogService(
                            new FakeCache() as unknown as Cache,
                            installCatalogServer().fetchImpl,
                        ),
                ).toThrow(/EVER_WORKS_PLATFORM_CATALOG_REPO must match/);
            }
        });

        it('defaults to ever-works/platforms and reads it at the raw host', async () => {
            const { service, server } = makeHarness({
                env: {
                    EVER_WORKS_PLATFORM_CATALOG_REPO: undefined,
                    EVER_WORKS_PLATFORM_CATALOG_BASE_URL: undefined,
                },
            });
            const result = await service.read('production');

            expect(server.urls[0]).toBe(`${RAW_HOST}/ever-works/platforms/main/platforms.json`);
            expect(result.catalogVersion).toBe('1.0.0');
            expect(result.platforms.length).toBeGreaterThan(0);
        });

        it('refuses a repo mutated after boot, on the read itself', async () => {
            const { service } = makeHarness();
            process.env.EVER_WORKS_PLATFORM_CATALOG_REPO = 'evil/platforms';

            await expect(service.read()).rejects.toThrow(
                /EVER_WORKS_PLATFORM_CATALOG_REPO must match/,
            );
        });

        it('reads the configured repo and ref', async () => {
            const { service, server } = makeHarness({
                env: {
                    EVER_WORKS_PLATFORM_CATALOG_REPO: 'ever-works/ever-platforms',
                    EVER_WORKS_PLATFORM_CATALOG_REF: 'v1.2.3',
                },
            });
            const logger = spyOnLogger();
            await service.read('production');

            expect(server.urls[0]).toBe(
                `${CATALOG_BASE}/ever-works/ever-platforms/v1.2.3/platforms.json`,
            );
            // A tag is a pinned ref: no supply-chain warning (plan §5.2:635).
            expect(messagesContaining(logger.warn, 'mutable ref')).toEqual([]);
        });

        it('warns once when the ref is a mutable branch', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness();
            await service.read('production');
            await service.read('production');

            expect(messagesContaining(logger.warn, 'mutable ref')).toHaveLength(1);
        });
    });

    describe('validation — the fixture cases, one at a time (FR-9…FR-11, ACC-11-08)', () => {
        it('lists the valid cases and drops the rest with the reasons the fixture states', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness();
            const result = await service.read('production');

            // valid, missingDevelopUrl, oversizeIcon, scriptIcon, foreignObjectIcon
            // — in FR-11 order (order, then name).
            expect(keysOf(result.platforms)).toEqual([
                'platform:ever-example',
                'platform:ever-no-develop',
                'platform:ever-oversize-icon',
                'platform:ever-script-icon',
                'platform:ever-foreign-object-icon',
            ]);
            expect(result.catalogAvailable).toBe(true);
            expect(result.stale).toBe(false);

            // javascript:, http: and the userinfo address drop their entries
            // (ACC-11-08 + plan §4.6's userinfo rule).
            const omitted = messagesContaining(logger.warn, 'app_launcher.item.omitted');
            expect(omitted).toHaveLength(7);
            expect(
                omitted.filter((message) => message.includes('"reason":"unsafeUrl"')).map(idOf),
            ).toEqual(['ever-javascript', 'ever-http', 'ever-userinfo']);
            expect(
                omitted.filter((message) => message.includes('"reason":"invalidEntry"')).map(idOf),
            ).toEqual([
                'ever-bad-icon-path',
                'ever-unknown-status',
                'ever-long-description',
                'ever-example', // the duplicate id loses, per the fixture's duplicateId case
            ]);

            expect(service.telemetry().omitted).toEqual({
                invalidEntry: 4,
                unsafeUrl: 3,
                overLimit: 0,
            });
        });

        it('drops the 25th entry (cap 24, FR-11, ACC-11-08)', async () => {
            const logger = spyOnLogger();
            const entries = twentyFiveEntries();
            expect(entries).toHaveLength(25);

            const { service } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf(entries) }),
            });
            const result = await service.read('production');

            expect(result.platforms).toHaveLength(24);
            expect(keysOf(result.platforms)[0]).toBe('platform:ever-1');
            expect(keysOf(result.platforms)[23]).toBe('platform:ever-24');
            expect(keysOf(result.platforms)).not.toContain('platform:ever-25');

            const overLimit = messagesContaining(logger.warn, '"reason":"overLimit"');
            expect(overLimit).toHaveLength(1);
            expect(overLimit[0]).toContain('ever-25');
            expect(service.telemetry().omitted.overLimit).toBe(1);
        });

        it('drops the whole entry when any environment carries an unsafe address, even one this read never uses', async () => {
            // The fixture's javascriptUrl case has only a production address. The
            // stricter question is an entry whose OTHER environment is poisoned:
            // FR-11 drops the entry, so a poisoned catalog can never render from
            // another environment.
            const poisoned = {
                ...fixtureEntry('valid'),
                id: 'ever-poisoned-develop',
                icon: 'icons/ever-poisoned-develop.svg',
                urls: {
                    production: 'https://poisoned.example.com',
                    develop: 'javascript:alert(1)',
                },
            };
            const { service } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf([poisoned]) }),
            });

            const result = await service.read('production');
            expect(result.platforms).toEqual([]);

            const develop = await service.read('develop');
            expect(develop.platforms).toEqual([]);
            expect(service.telemetry().omitted.unsafeUrl).toBe(1);
        });

        it('refuses a catalog whose schemaVersion this reader does not understand', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness({
                server: installCatalogServer({
                    catalog: JSON.stringify({
                        schemaVersion: 2,
                        catalogVersion: '1.0.0',
                        platforms: [],
                    }),
                }),
            });

            const result = await service.read('production');
            expect(result.catalogAvailable).toBe(false);
            expect(result.platforms).toEqual([]);
            expect(
                messagesContaining(logger.warn, 'app_launcher.catalog.refresh_failed'),
            ).toHaveLength(1);
        });

        it('drops an entry with an unknown url key rather than guessing its environment', async () => {
            const unknownEnvironment = {
                ...fixtureEntry('valid'),
                id: 'ever-preview-env',
                icon: 'icons/ever-preview-env.svg',
                urls: {
                    production: 'https://preview-env.example.com',
                    preview: 'https://preview.example.com',
                },
            };
            const { service } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf([unknownEnvironment]) }),
            });

            const result = await service.read('production');
            expect(result.platforms).toEqual([]);
            expect(service.telemetry().omitted.invalidEntry).toBe(1);
        });
    });

    describe('icons (FR-14, plan §5.2:656-663, §9.2:916)', () => {
        it('inlines a clean SVG as a data URI within the 16,384-byte cap', async () => {
            const { service } = makeHarness();
            const result = await service.read('production');
            const example = result.platforms.find((item) => item.key === 'platform:ever-example');

            expect(example?.iconDataUri).toBe(
                `data:image/svg+xml;base64,${Buffer.from(CLEAN_SVG).toString('base64')}`,
            );
            const decoded = Buffer.from(example!.iconDataUri!.split(',')[1], 'base64');
            expect(decoded.byteLength).toBeLessThanOrEqual(APP_LAUNCHER_ICON_MAX_BYTES);
            expect(decoded.toString('utf8')).toBe(CLEAN_SVG);
        });

        it('keeps the entry and drops the icon when it is one byte over the cap', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness();
            const result = await service.read('production');
            const oversize = result.platforms.find(
                (item) => item.key === 'platform:ever-oversize-icon',
            );

            expect(oversize).toBeDefined();
            expect(oversize?.name).toBe('Ever Oversize Icon');
            expect(oversize?.url).toBe('https://oversize.example.com/');
            expect(oversize?.iconDataUri).toBeUndefined();
            expect(service.telemetry().iconsOmitted.oversizeIcon).toBe(1);
            expect(messagesContaining(logger.warn, '"reason":"oversizeIcon"')).toHaveLength(1);
        });

        it('refuses an SVG carrying a script element, keeping the platform', async () => {
            const { service } = makeHarness();
            const result = await service.read('production');
            const script = result.platforms.find(
                (item) => item.key === 'platform:ever-script-icon',
            );

            expect(script?.iconDataUri).toBeUndefined();
            expect(script?.url).toBe('https://script-icon.example.com/');
            expect(service.telemetry().iconsOmitted.unsafeSvg).toBe(2);
        });

        it('refuses an SVG carrying foreignObject, keeping the platform', async () => {
            const { service } = makeHarness();
            const result = await service.read('production');
            const foreign = result.platforms.find(
                (item) => item.key === 'platform:ever-foreign-object-icon',
            );

            expect(foreign?.iconDataUri).toBeUndefined();
            expect(foreign?.name).toBe('Ever Foreign Object Icon');
        });

        it('keeps the entry without an icon when the icon cannot be read', async () => {
            const { service } = makeHarness({ server: installCatalogServer({ iconStatus: 404 }) });
            const result = await service.read('production');

            expect(result.platforms.length).toBe(5);
            expect(result.platforms.every((item) => item.iconDataUri === undefined)).toBe(true);
            expect(service.telemetry().iconsOmitted.unreadableIcon).toBe(5);
        });

        it('fetches icons in batches of six, at the catalog host (plan §5.2:657)', async () => {
            const entries = twentyFiveEntries().slice(0, 24);
            const { service, server } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf(entries) }),
            });
            const result = await service.read('production');

            expect(result.platforms).toHaveLength(24);
            expect(PLATFORM_CATALOG_ICON_BATCH_SIZE).toBe(6);
            expect(server.peakInFlight).toBe(PLATFORM_CATALOG_ICON_BATCH_SIZE);
            expect(server.urls.filter((url) => ICON_PATH_RE.test(url))).toHaveLength(24);
            expect(server.urls[1]).toBe(
                `${CATALOG_BASE}/ever-works/platforms/main/icons/ever-1.svg`,
            );
        });
    });

    describe('the environment (FR-10, ACC-11-05)', () => {
        it('shows the addresses of the running environment, which differ per environment', async () => {
            const { service } = makeHarness();
            const production = await service.read('production');
            const stage = await service.read('stage');
            const develop = await service.read('develop');

            expect(
                production.platforms.find((item) => item.key === 'platform:ever-example')?.url,
            ).toBe('https://example.com/');
            expect(stage.platforms.find((item) => item.key === 'platform:ever-example')?.url).toBe(
                'https://stage.example.com/',
            );
            expect(
                develop.platforms.find((item) => item.key === 'platform:ever-example')?.url,
            ).toBe('https://dev.example.com/');
            expect(stage.environment).toBe('stage');
        });

        it('omits an entry with no address for the running environment (FR-10, ACC-11-05)', async () => {
            const { service } = makeHarness();

            // The fixture's missingDevelopUrl case carries production + stage only.
            const production = await service.read('production');
            const stage = await service.read('stage');
            const develop = await service.read('develop');

            expect(keysOf(production.platforms)).toContain('platform:ever-no-develop');
            expect(keysOf(stage.platforms)).toContain('platform:ever-no-develop');
            expect(keysOf(develop.platforms)).not.toContain('platform:ever-no-develop');
            // develop also loses the production-only entries.
            expect(keysOf(develop.platforms)).toEqual(['platform:ever-example']);
        });

        it('defaults to EVER_WORKS_PLATFORM_CATALOG_ENV, then to production', async () => {
            const staged = makeHarness({ env: { EVER_WORKS_PLATFORM_CATALOG_ENV: 'stage' } });
            expect((await staged.service.read()).environment).toBe('stage');

            const defaulted = makeHarness({ env: { EVER_WORKS_PLATFORM_CATALOG_ENV: undefined } });
            const result = await defaulted.service.read();
            expect(result.environment).toBe('production');
            expect(result.platforms.find((item) => item.key === 'platform:ever-example')?.url).toBe(
                'https://example.com/',
            );
        });

        it('marks the self id as current and moves it with the self id (FR-13)', async () => {
            const defaulted = makeHarness();
            const byDefault = await defaulted.service.read('production');
            // The fixture carries no ever-works entry, so nothing is "You're here".
            expect(byDefault.platforms.some((item) => item.current === true)).toBe(false);

            const moved = makeHarness({
                env: { EVER_WORKS_PLATFORM_CATALOG_SELF_ID: 'ever-no-develop' },
            });
            const items = await moved.service.list('production');
            expect(items.filter((item) => item.current === true).map((item) => item.key)).toEqual([
                'platform:ever-no-develop',
            ]);
        });

        it('returns entries in FR-11 order (order, then name) whatever order the file uses', async () => {
            const shuffled = [
                fixtureEntry('oversizeIcon'),
                fixtureEntry('valid'),
                fixtureEntry('scriptIcon'),
            ];
            const { service } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf(shuffled) }),
            });
            const items = await service.list('production');

            expect(items.map((item) => item.order)).toEqual([40, 45, 46]);
            expect(items.map((item) => item.catalogOrder)).toEqual([40, 45, 46]);
        });
    });

    describe('the non-production source override (ACC-11-51, APW11-G06)', () => {
        it('is ignored with NODE_ENV=production, even with the switch set', async () => {
            const { service, server } = makeHarness({
                env: {
                    NODE_ENV: 'production',
                    EVER_WORKS_E2E_FAKES: '1',
                    EVER_WORKS_PLATFORM_CATALOG_BASE_URL: CATALOG_BASE,
                },
            });
            const result = await service.read('production');

            expect(server.urls[0]).toBe(`${RAW_HOST}/ever-works/platforms/main/platforms.json`);
            expect(server.urls.every((url) => !url.includes('catalog.test'))).toBe(true);
            expect(result.platforms.length).toBeGreaterThan(0);
        });

        it('is applied when NODE_ENV is not production and the fakes switch is on', async () => {
            const { service, server } = makeHarness();
            await service.read('production');

            expect(server.urls[0]).toBe(`${CATALOG_BASE}/ever-works/platforms/main/platforms.json`);
        });

        it('replaces the raw host for the icons as well as the index', async () => {
            const { service, server } = makeHarness();
            await service.read('production');

            const iconUrls = server.urls.filter((url) => ICON_PATH_RE.test(url));
            expect(iconUrls.length).toBeGreaterThan(0);
            expect(
                iconUrls.every((url) =>
                    url.startsWith(`${CATALOG_BASE}/ever-works/platforms/main/icons/`),
                ),
            ).toBe(true);
        });

        it('is not applied without the fakes switch (and accepts 1 or true, refuses anything else)', async () => {
            for (const value of [undefined, '', '0', 'false', 'no']) {
                const { service, server } = makeHarness({ env: { EVER_WORKS_E2E_FAKES: value } });
                await service.read('production');
                expect(server.urls[0]).toBe(`${RAW_HOST}/ever-works/platforms/main/platforms.json`);
            }
            for (const value of ['1', 'true']) {
                const { service, server } = makeHarness({ env: { EVER_WORKS_E2E_FAKES: value } });
                await service.read('production');
                expect(server.urls[0]).toBe(
                    `${CATALOG_BASE}/ever-works/platforms/main/platforms.json`,
                );
            }
        });

        it('is not applied when the override is unset or unusable', async () => {
            for (const value of [
                undefined,
                '',
                'not a url',
                'file:///etc/passwd',
                'ftp://catalog.test',
            ]) {
                const { service, server } = makeHarness({
                    env: { EVER_WORKS_PLATFORM_CATALOG_BASE_URL: value },
                });
                await service.read('production');
                expect(server.urls[0]).toBe(`${RAW_HOST}/ever-works/platforms/main/platforms.json`);
            }
        });

        it('still applies every safety rule while it is active (CONTRACTS R-40)', async () => {
            // Same fixture cases, same rules: the override moves the SOURCE, and
            // nothing else.
            const { service } = makeHarness();
            const result = await service.read('production');

            expect(keysOf(result.platforms)).toEqual([
                'platform:ever-example',
                'platform:ever-no-develop',
                'platform:ever-oversize-icon',
                'platform:ever-script-icon',
                'platform:ever-foreign-object-icon',
            ]);
            expect(
                result.platforms.find((item) => item.key === 'platform:ever-oversize-icon')
                    ?.iconDataUri,
            ).toBeUndefined();
            expect(
                result.platforms.find((item) => item.key === 'platform:ever-script-icon')
                    ?.iconDataUri,
            ).toBeUndefined();
            expect(service.telemetry().omitted).toEqual({
                invalidEntry: 4,
                unsafeUrl: 3,
                overLimit: 0,
            });
        });

        it('still drops the 25th entry while it is active', async () => {
            const entries = twentyFiveEntries();
            const { service } = makeHarness({
                server: installCatalogServer({ catalog: catalogOf(entries) }),
            });
            const result = await service.read('production');

            expect(result.platforms).toHaveLength(24);
            expect(service.telemetry().omitted.overLimit).toBe(1);
        });
    });

    describe('the cache (FR-12, ACC-11-07)', () => {
        it('caches a successful read for an hour and keeps it out of the source on the next call', async () => {
            const { service, cache, server } = makeHarness();
            await service.read('production');
            const fetchCountAfterFirstRead = server.urls.length;

            await service.read('production');

            expect(server.urls.length).toBe(fetchCountAfterFirstRead);
            expect(cache.writesFor('platform-catalog:main')).toEqual([
                PLATFORM_CATALOG_SUCCESS_TTL_MS,
            ]);
            expect(PLATFORM_CATALOG_SUCCESS_TTL_MS).toBe(3_600_000);
        });

        it('keeps a separate :last-good entry with no TTL', async () => {
            const { service, cache } = makeHarness();
            await service.read('production');

            expect(cache.writesFor('platform-catalog:main:last-good')).toEqual([
                PLATFORM_CATALOG_LAST_GOOD_TTL_MS,
            ]);
            expect(PLATFORM_CATALOG_LAST_GOOD_TTL_MS).toBe(0);
            expect(cache.ttlFor('platform-catalog:main:last-good')).toBe(0);

            // What time does: the timed entry lapses, the last-good one does not.
            cache.expireTimedEntries();
            expect(cache.has('platform-catalog:main')).toBe(false);
            expect(cache.has('platform-catalog:main:last-good')).toBe(true);
        });

        it('serves the last good catalog when a later read is blocked (ACC-11-07, S10)', async () => {
            const { service, cache, server } = makeHarness();
            const first = await service.read('production');
            const fetchCountAfterFirstRead = server.urls.length;

            cache.expireTimedEntries(); // the hour passes; the last-good copy stays
            server.setBlocked(true);

            const blocked = await service.read('production');

            expect(blocked.platforms).toEqual(first.platforms);
            expect(blocked.catalogVersion).toBe(first.catalogVersion);
            expect(blocked.catalogAvailable).toBe(true);
            expect(blocked.stale).toBe(true);
            expect(blocked.environment).toBe('production');
            expect(server.urls.length).toBe(fetchCountAfterFirstRead + 1);
        });

        it('reports catalogAvailable: false with no prior read and retries after the 30 s failure TTL', async () => {
            const { service, cache, server } = makeHarness({
                server: installCatalogServer({ blocked: true }),
            });

            const first = await service.read('production');
            expect(first).toEqual({
                environment: 'production',
                catalogVersion: null,
                catalogAvailable: false,
                stale: false,
                platforms: [],
            });
            expect(await service.list('production')).toEqual([]);
            expect(cache.writesFor('platform-catalog:main')).toEqual([
                PLATFORM_CATALOG_FAILURE_TTL_MS,
            ]);
            expect(PLATFORM_CATALOG_FAILURE_TTL_MS).toBe(30_000);

            // Within the failure window the source is not asked again (FR-12).
            const second = await service.read('production');
            expect(second.catalogAvailable).toBe(false);
            expect(server.urls.length).toBe(1);

            // Past it, the read is retried and the healthy source is served.
            cache.expireTimedEntries();
            server.setBlocked(false);
            const recovered = await service.read('production');
            expect(recovered.catalogAvailable).toBe(true);
            expect(recovered.stale).toBe(false);
            expect(recovered.platforms.length).toBeGreaterThan(0);
            expect(server.urls.length).toBeGreaterThan(1);
        });

        it('treats an unreadable or malformed catalog as a failed read, keeping the last good one', async () => {
            const { service, cache, server } = makeHarness();
            const first = await service.read('production');

            cache.expireTimedEntries();
            server.setCatalog('{ not json');

            const afterMalformed = await service.read('production');
            expect(afterMalformed.platforms).toEqual(first.platforms);
            expect(afterMalformed.stale).toBe(true);

            cache.expireTimedEntries();
            server.setCatalog(catalogOf([])); // a valid, empty catalog

            const afterEmpty = await service.read('production');
            expect(afterEmpty.platforms).toEqual([]);
            expect(afterEmpty.catalogAvailable).toBe(true);
            expect(afterEmpty.stale).toBe(false);
        });

        it('keys the cache by ref, so a ref change cannot serve the previous ref', async () => {
            const { service, cache } = makeHarness();
            await service.read('production');
            expect(cache.keys()).toEqual(
                expect.arrayContaining([
                    'platform-catalog:main',
                    'platform-catalog:main:last-good',
                ]),
            );

            process.env.EVER_WORKS_PLATFORM_CATALOG_REF = 'v2.0.0';
            await service.read('production');
            expect(cache.keys()).toEqual(
                expect.arrayContaining([
                    'platform-catalog:v2.0.0',
                    'platform-catalog:v2.0.0:last-good',
                ]),
            );
        });

        it('serves a cached catalog for every environment without re-reading', async () => {
            const { service, server } = makeHarness();
            await service.read('production');
            const afterFirst = server.urls.length;

            await service.read('stage');
            await service.read('develop');

            expect(server.urls.length).toBe(afterFirst);
        });

        it('degrades to reading the source when no cache is bound, and says so once', async () => {
            const logger = spyOnLogger();
            const server = installCatalogServer();
            setCatalogEnv();
            const service = new PlatformCatalogService(undefined, server.fetchImpl);

            await service.read('production');
            const afterFirst = server.urls.length;
            await service.read('production');

            expect(server.urls.length).toBeGreaterThan(afterFirst);
            expect(messagesContaining(logger.warn, 'No CACHE_MANAGER is bound')).toHaveLength(1);
        });
    });

    describe('app_launcher.catalog.environment_unset (FR-10, APW11-G19)', () => {
        it('logs an error and counts it when _ENV is unset outside production', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness({
                env: { EVER_WORKS_PLATFORM_CATALOG_ENV: undefined },
            });

            const result = await service.read();

            expect(result.environment).toBe('production');
            expect(result.platforms.length).toBeGreaterThan(0);
            const logged = messagesContaining(
                logger.error,
                'app_launcher.catalog.environment_unset',
            );
            expect(logged).toHaveLength(1);
            expect(logged[0]).toContain('"reason":"unset"');
            expect(service.telemetry().environmentUnset).toBe(1);
        });

        it('logs the same event for an unrecognised value, and still serves production', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness({
                env: { EVER_WORKS_PLATFORM_CATALOG_ENV: 'staging' },
            });

            const result = await service.read();

            expect(result.environment).toBe('production');
            const logged = messagesContaining(
                logger.error,
                'app_launcher.catalog.environment_unset',
            );
            expect(logged).toHaveLength(1);
            expect(logged[0]).toContain('"reason":"invalid"');
            expect(logged[0]).toContain('staging');
        });

        it('says nothing when _ENV is set, or when the installation IS production', async () => {
            const logger = spyOnLogger();

            const configured = makeHarness({ env: { EVER_WORKS_PLATFORM_CATALOG_ENV: 'stage' } });
            await configured.service.read();
            expect(
                messagesContaining(logger.error, 'app_launcher.catalog.environment_unset'),
            ).toEqual([]);

            logger.error.mockClear();
            const deployed = makeHarness({
                env: { NODE_ENV: 'production', EVER_WORKS_PLATFORM_CATALOG_ENV: undefined },
            });
            await deployed.service.read();
            expect(
                messagesContaining(logger.error, 'app_launcher.catalog.environment_unset'),
            ).toEqual([]);
        });

        it('reports on a refresh, not on every request', async () => {
            const logger = spyOnLogger();
            const { service, cache } = makeHarness({
                env: { EVER_WORKS_PLATFORM_CATALOG_ENV: undefined },
            });

            await service.read();
            await service.read(); // served from the cache: nothing new to report
            expect(
                messagesContaining(logger.error, 'app_launcher.catalog.environment_unset'),
            ).toHaveLength(1);

            cache.expireTimedEntries();
            await service.read();
            expect(
                messagesContaining(logger.error, 'app_launcher.catalog.environment_unset'),
            ).toHaveLength(2);
            expect(service.telemetry().environmentUnset).toBe(2);
        });

        it('emits app_launcher.catalog.refreshed with the entry and drop counts (plan §9.1)', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness();

            await service.read('production');

            const refreshed = messagesContaining(logger.log, 'app_launcher.catalog.refreshed');
            expect(refreshed).toHaveLength(1);
            expect(refreshed[0]).toContain('"entries":5');
            expect(refreshed[0]).toContain('"dropped":7');
            expect(refreshed[0]).toMatch(/"durationMs":\d+/);
            expect(service.telemetry().refreshed).toBe(1);
        });
    });

    describe('the request itself (plan §5.2:656)', () => {
        it('sends a User-Agent and an 8 s abort signal on every request', async () => {
            const { service, server } = makeHarness();
            await service.read('production');

            expect(PLATFORM_CATALOG_FETCH_TIMEOUT_MS).toBe(8_000);
            for (const request of server.requests) {
                expect(request.init?.headers).toMatchObject({
                    'User-Agent': expect.stringContaining('ever-works'),
                });
                expect(request.init?.signal).toBeInstanceOf(AbortSignal);
            }
        });

        it('reports a timeout as an unavailable catalog, never as a throw', async () => {
            const logger = spyOnLogger();
            const { service } = makeHarness({ server: installCatalogServer({ blocked: true }) });

            const result = await service.read('production');

            expect(result.catalogAvailable).toBe(false);
            expect(result.platforms).toEqual([]);
            expect(
                messagesContaining(logger.warn, 'app_launcher.catalog.refresh_failed'),
            ).toHaveLength(1);
            expect(service.telemetry().refreshFailed).toBe(1);
        });

        it('uses globalThis.fetch when no implementation is injected', async () => {
            const server = installCatalogServer();
            const globalFetch = jest.fn(server.fetchImpl) as unknown as typeof fetch;
            globalThis.fetch = globalFetch;
            setCatalogEnv();

            const service = new PlatformCatalogService(new FakeCache() as unknown as Cache);
            const result = await service.read('production');

            expect(result.platforms.length).toBe(5);
            expect(globalFetch).toHaveBeenCalled();
        });
    });

    describe('list() and the item shape (plan §4.1 step 1)', () => {
        it('returns the tiles the registry consumes, with their preference defaults', async () => {
            const { service } = makeHarness();
            const items = await service.list('production');
            expect(items).toEqual((await service.read('production')).platforms);

            for (const item of items) {
                expect(item.kind).toBe('platform');
                expect(item.section).toBe('platforms');
                expect(item.manageState).toBe('listed');
                expect(item.visible).toBe(true);
                expect(item.pinned).toBe(false);
                expect(item.pinOrder).toBeNull();
                expect(item.key).toMatch(/^platform:[a-z0-9-]+$/);
                expect(item.url).toMatch(/^https:\/\//);
                expect(item.host).toBe(new URL(item.url!).host);
                expect(item.description!.length).toBeLessThanOrEqual(80);
                expect(item.name.length).toBeLessThanOrEqual(40);
                expect(item.status === 'available' || item.status === 'beta').toBe(true);
                expect(item.catalogOrder).toBe(item.order);
            }
        });

        it('names the entries the fixture declares, with the hosts their addresses carry', async () => {
            const { service } = makeHarness();
            const items = await service.list('production');
            const example = items.find((item) => item.key === 'platform:ever-example')!;

            expect(example.name).toBe('Ever Example');
            expect(example.description).toBe('A well-formed catalog entry.');
            expect(example.order).toBe(40);
            expect(example.status).toBe('available');
            expect(example.url).toBe('https://example.com/');
            expect(example.host).toBe('example.com');
        });

        it("returns nothing when the catalog is unavailable — the current-platform tile is the caller's", async () => {
            const { service } = makeHarness({ server: installCatalogServer({ blocked: true }) });

            // plan §4.1 step 1 gives the synthesised `platform:<selfId>` tile to the
            // caller (T9), because the catalog itself must not carry platform names.
            expect(await service.list('production')).toEqual([]);
        });
    });
});

/** The `id` of an `app_launcher.item.omitted` log line, for a stable assertion. */
function idOf(message: string): string {
    const match = /"id":"([^"]+)"/.exec(message);
    if (!match) {
        throw new Error(`no id in omission line: ${message}`);
    }
    return match[1];
}
