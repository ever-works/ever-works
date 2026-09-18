import 'reflect-metadata';
import {
    type CanActivate,
    type ExecutionContext,
    Injectable,
    type INestApplication,
    ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import {
    APP_LAUNCHER_FILTER_MAX_LENGTH,
    APP_LAUNCHER_MAX_CHANGES_PER_SAVE,
    APP_LAUNCHER_PIN_LIMIT,
    type AppLauncherItem,
    type AppLauncherListResponse,
    type AppLauncherPreferenceChange,
    type AppLauncherSavePreferencesResponse,
} from '@ever-works/contracts';
import {
    AppLauncherPinLimitError,
    AppLauncherService,
    type AppLauncherListOptions,
    type AppLauncherPlatformInput,
    type AppLauncherScope,
} from '@ever-works/agent/app-launcher';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as request from 'supertest';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ScopeContextService } from '../scope/scope-context.service';
import { AppLauncherModule } from './app-launcher.module';
import {
    APP_LAUNCHER_ITEM_KEY_PATTERN,
    APP_LAUNCHER_PLATFORM_READS_PER_MINUTE,
    APP_LAUNCHER_PLATFORMS_CACHE_CONTROL,
    APP_LAUNCHER_READS_PER_MINUTE,
    APP_LAUNCHER_WRITES_PER_MINUTE,
    AppLauncherController,
    AppLauncherPlatformsController,
    ListAppLauncherQueryDto,
    SaveAppLauncherPreferencesDto,
} from './app-launcher.controller';
import { AppLauncherEnabledGuard } from './guards/app-launcher-enabled.guard';
import {
    PlatformCatalogService,
    type PlatformCatalogItem,
    type PlatformCatalogRead,
} from './platform-catalog.service';

/**
 * APW-11 T9 — the three App Launcher routes through a real HTTP stack.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md`; plan §4.1
 * (the read), §4.2 (the save), §4.3 (the public list), §4.5 (the error map) and
 * §10.2 (this spec's rows) are what it asserts.
 *
 * ## Why HTTP and not three hand-built controller instances
 *
 * Everything this task is responsible for is a property of the **route**, not of
 * a method body: the installation switch answering `404` from a guard (which
 * never runs if the controller is called directly), the exact paths, the
 * `422`/`400` status codes as the client sees them, the one-hour
 * `Cache-Control` header and the `Access-Control-Allow-Origin: *` the public
 * route sends. A direct call would assert none of that. So the spec builds a
 * Nest application with the two controllers, the platform's own
 * `ValidationPipe` configuration (`apps/api/src/main.ts:199-205`) and a session
 * stand-in, and drives it with supertest.
 *
 * ## What is faked, and what that leaves to other specs
 *
 * `AppLauncherService` (T6) and `PlatformCatalogService` (T8) are replaced by
 * in-memory stand-ins: the service's own spec owns eligibility, ordering,
 * addresses, chips and the merged pinned view, and the catalog's spec owns
 * fetching, validation and the last-good cache. `FakeLauncherService` here does
 * exactly two things — remember one arrangement per scope and apply a save as a
 * merge patch — which is all that ACC-11-50's controller half needs: with the
 * switch off, **no** call reaches it and its stored rows are byte-identical;
 * with the switch on again, the same list comes back.
 *
 * Both fakes record what the controller asked them, which is how the
 * scope/session forwarding (FR-53) and the `includeHidden`/`limit` forwarding
 * (FR-63) are asserted.
 */

// ---------------------------------------------------------------------------
// Test identities and scopes
// ---------------------------------------------------------------------------

/** The signed-in person every authenticated call runs as (FR-53). */
const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** An organization the person is a member of — and a second, unrelated one. */
const ORG_A = 'org-a';
const ORG_B = 'org-b';

const PERSONAL: AppLauncherScope = { tenantId: 'tenant-a', organizationId: null };

/** A Work id that passes the DTO's `work:<uuid>` shape. */
const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';

function scopeKeyOf(scope: AppLauncherScope | null | undefined): string {
    return scope?.organizationId ?? 'personal';
}

/**
 * The scope a request runs under.
 *
 * Production resolves `X-Scope-Slug` in `ScopeResolverMiddleware` and seeds the
 * holder in `SessionScopeGuard`; this reproduces those two facts in one place
 * (see `TestSessionGuard` below) so "a request from another workspace" is driven
 * by the same header the real stack reads (T25's web route forwards it —
 * `tasks.md:415-416`).
 */
class FakeScopeContext {
    current: AppLauncherScope = { ...PERSONAL };

    getScope(): AppLauncherScope {
        return this.current;
    }

    setScope(scope: AppLauncherScope): void {
        this.current = scope;
    }
}

/**
 * The session stand-in: `@CurrentUser()` reads `request.user`, which
 * `AuthSessionGuard` populates in production. A request without an
 * `authorization` header is left anonymous — which is how the public platform
 * route is called here, signed out (FR-37).
 */
@Injectable()
class TestSessionGuard implements CanActivate {
    constructor(private readonly scope: FakeScopeContext) {}

    canActivate(context: ExecutionContext): boolean {
        const http = context.switchToHttp().getRequest();
        if (typeof http.headers?.authorization === 'string') {
            http.user = { userId: TEST_USER_ID };
            const slug = http.headers['x-scope-slug'];
            this.scope.setScope({
                tenantId: 'tenant-a',
                organizationId: typeof slug === 'string' && slug.length > 0 ? slug : null,
            });
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// The two stand-ins
// ---------------------------------------------------------------------------

/** One stored preference row, as far as this spec cares. */
interface StoredRow {
    key: string;
    visible: boolean;
    pinned: boolean;
    pinOrder: number | null;
    order: number;
}

/** One recorded read, so the forwarding assertions have something to read. */
interface RecordedRead {
    userId: string;
    scopeKey: string;
    platforms: AppLauncherPlatformInput[];
    options: AppLauncherListOptions;
}

/**
 * T6's registry, reduced to "one arrangement per scope".
 *
 * It is NOT a second implementation of the registry: there is no eligibility
 * rule, no address resolution, no section ordering and no chips. It stores rows
 * and echoes them, plus the pin-limit refusal — which is the one product rule
 * this spec needs, because the controller's `422` mapping is triggered by it.
 */
class FakeLauncherService {
    readonly stores = new Map<string, StoredRow[]>();
    readonly reads: RecordedRead[] = [];
    readonly saves: Array<{
        userId: string;
        scopeKey: string;
        changes: AppLauncherPreferenceChange[];
    }> = [];

    constructor(seed: Record<string, StoredRow[]> = {}) {
        this.reset(seed);
    }

    /** Forget everything and start from `seed` (called before each test). */
    reset(seed: Record<string, StoredRow[]> = {}): void {
        this.stores.clear();
        this.reads.length = 0;
        this.saves.length = 0;
        for (const [scopeKey, rows] of Object.entries(seed)) {
            this.stores.set(
                scopeKey,
                rows.map((row) => ({ ...row })),
            );
        }
    }

    /** Every row visible in one scope: its own plus the shared `global` ones (FR-62). */
    rowsOf(scopeKey: string): StoredRow[] {
        return [...(this.stores.get('global') ?? []), ...(this.stores.get(scopeKey) ?? [])];
    }

    async listForUser(
        user: { id?: string } | null | undefined,
        scope: AppLauncherScope | null | undefined,
        platforms: ReadonlyArray<AppLauncherPlatformInput> | null | undefined,
        options: AppLauncherListOptions = {},
    ): Promise<AppLauncherListResponse> {
        const scopeKey = scopeKeyOf(scope);
        const handedIn = [...(platforms ?? [])];
        this.reads.push({ userId: user?.id ?? '', scopeKey, platforms: handedIn, options });

        const items: AppLauncherItem[] = handedIn.map((platform, index) => ({
            key: platform.key,
            kind: 'platform',
            section: 'platforms',
            name: platform.name,
            description: platform.description,
            iconDataUri: platform.iconDataUri,
            url: platform.url ?? null,
            host: platform.host ?? null,
            current: platform.current,
            status: platform.status,
            visible: true,
            pinned: false,
            pinOrder: null,
            order: index,
            manageState: 'listed',
        }));

        for (const row of this.rowsOf(scopeKey)) {
            if (!row.visible && options.includeHidden !== true) {
                continue;
            }
            items.push({
                key: row.key,
                kind: 'work',
                section: row.pinned ? 'pinned' : 'works',
                name: row.key,
                url: null,
                host: null,
                visible: row.visible,
                pinned: row.pinned,
                pinOrder: row.pinned ? row.pinOrder : null,
                order: row.order,
                manageState: 'notLive',
            });
        }

        const limit = options.limit ?? 200;
        return {
            items: items.slice(0, limit),
            meta: {
                environment: options.environment ?? 'production',
                catalogVersion: options.catalogVersion ?? null,
                catalogAvailable: options.catalogAvailable ?? handedIn.length > 0,
                scopeKey,
                worksTotal: this.rowsOf(scopeKey).length,
                // This stand-in does not implement the FR-63 filter — it records
                // the option and echoes the unfiltered list — so its `total` is the
                // whole eligible set, which is what the real registry reports
                // whatever the filter is.
                total: items.length,
                truncated: items.length > limit,
                pinLimit: APP_LAUNCHER_PIN_LIMIT,
                appWorksAvailable: false,
            },
        };
    }

    async savePreferences(
        userId: string,
        scope: AppLauncherScope | null | undefined,
        changes: ReadonlyArray<AppLauncherPreferenceChange> | null | undefined,
        platforms?: ReadonlyArray<AppLauncherPlatformInput> | null,
    ): Promise<AppLauncherSavePreferencesResponse> {
        const scopeKey = scopeKeyOf(scope);
        const requested = [...(changes ?? [])];
        this.saves.push({ userId, scopeKey, changes: requested });

        const projected = new Map(this.rowsOf(scopeKey).map((row) => [row.key, { ...row }]));
        let nextOrder = projected.size;
        for (const change of requested) {
            const row: StoredRow = projected.get(change.key) ?? {
                key: change.key,
                visible: true,
                pinned: false,
                pinOrder: null,
                order: (nextOrder += 1),
            };
            if (typeof change.visible === 'boolean') {
                row.visible = change.visible;
            }
            if (typeof change.pinned === 'boolean') {
                row.pinned = change.pinned;
                row.pinOrder = change.pinned ? nextOrder : null;
            }
            if (typeof change.order === 'number') {
                row.order = change.order;
            }
            projected.set(change.key, row);
        }

        // FR-25/FR-62: the whole save is refused, so nothing above is stored.
        if ([...projected.values()].filter((row) => row.pinned).length > APP_LAUNCHER_PIN_LIMIT) {
            throw new AppLauncherPinLimitError();
        }

        this.stores.set(scopeKey, [...projected.values()]);
        const listed = await this.listForUser({ id: userId }, scope, platforms, {
            includeHidden: true,
        });
        return { saved: requested.length, rejected: [], items: listed.items };
    }
}

/** One catalog tile, in T8's own item shape. */
function catalogPlatform(
    id: string,
    name: string,
    options: { current?: boolean; order?: number; url?: string | null } = {},
): PlatformCatalogItem {
    const url = options.url === undefined ? `https://${id}.ever.works/` : options.url;
    return {
        key: `platform:${id}`,
        kind: 'platform',
        section: 'platforms',
        name,
        url,
        host: url ? new URL(url).host : null,
        current: options.current === true,
        status: 'available',
        visible: true,
        pinned: false,
        pinOrder: null,
        order: options.order ?? 0,
        catalogOrder: options.order ?? 0,
        manageState: 'listed',
    };
}

/** T8's reader, with a per-test result. */
class FakeCatalogService {
    readonly reads: Array<string | undefined> = [];
    result: PlatformCatalogRead = catalogRead();

    reset(result: PlatformCatalogRead = catalogRead()): void {
        this.reads.length = 0;
        this.result = result;
    }

    async read(environment?: string): Promise<PlatformCatalogRead> {
        this.reads.push(environment);
        return this.result;
    }

    async list(environment?: string): Promise<PlatformCatalogItem[]> {
        return (await this.read(environment)).platforms;
    }
}

/** A served catalog for one environment (S9's "available" branch). */
function catalogRead(environment: 'production' | 'stage' | 'develop' = 'production') {
    return {
        environment,
        catalogVersion: 'v1',
        catalogAvailable: true,
        stale: false,
        platforms: [
            catalogPlatform('ever-works', 'Ever Works', { current: true, order: 0 }),
            catalogPlatform('cal-diy', 'Cal.diy', { order: 1 }),
        ],
    };
}

/** The outage path: nothing served and no last-good copy (plan §4.1 step 1). */
function unavailableCatalog(environment: 'production' | 'stage' | 'develop' = 'production') {
    return {
        environment,
        catalogVersion: null,
        catalogAvailable: false,
        stale: false,
        platforms: [] as PlatformCatalogItem[],
    };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * A stable snapshot of every scope's stored rows.
 *
 * A `Map` JSON-stringifies to `{}`, so a spec that compared
 * `JSON.stringify(service.stores)` would compare two empty objects — the exact
 * kind of vacuous assertion this epic's "prove it is non-vacuous" rule exists
 * to catch. Entries are sorted by scope key so two snapshots of the same state
 * are always byte-identical.
 */
function snapshotRows(service: FakeLauncherService): string {
    return JSON.stringify(
        [...service.stores.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
}

/** A stable snapshot of ONE scope's rows — `null` when the scope holds none. */
function rowsIn(service: FakeLauncherService, scopeKey: string): string {
    return JSON.stringify(service.stores.get(scopeKey) ?? null);
}

describe('APW-11 T9 — App Launcher controllers', () => {
    const envBackup = { ...process.env };
    const APP_NAME = 'Ever Works Under Test';

    let app: INestApplication;
    let launcher: FakeLauncherService;
    let catalog: FakeCatalogService;
    let scope: FakeScopeContext;

    /** Both controllers' guards, as Nest recorded them on each class. */
    const guardsOf = (controller: object): unknown[] =>
        (Reflect.getMetadata('__guards__', controller) ?? []) as unknown[];

    beforeAll(async () => {
        launcher = new FakeLauncherService();
        catalog = new FakeCatalogService();
        scope = new FakeScopeContext();

        const moduleRef = await Test.createTestingModule({
            controllers: [AppLauncherController, AppLauncherPlatformsController],
            providers: [
                { provide: FakeScopeContext, useValue: scope },
                { provide: AppLauncherService, useValue: launcher },
                { provide: PlatformCatalogService, useValue: catalog },
                { provide: ScopeContextService, useValue: scope },
                TestSessionGuard,
                { provide: APP_GUARD, useExisting: TestSessionGuard },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        // The platform's own pipe (apps/api/src/main.ts:199-205): `whitelist` +
        // `transform` + `forbidNonWhitelisted`, which is what turns the DTOs
        // above into plan §4.5's `400` row.
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
        );
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(() => {
        process.env = { ...envBackup };
        process.env.APP_NAME = APP_NAME;
        delete process.env.EVER_WORKS_APP_LAUNCHER_ENABLED;
        launcher.reset();
        catalog.reset();
        scope.current = { ...PERSONAL };
    });

    afterAll(() => {
        process.env = { ...envBackup };
    });

    /** FR-54's switch, as an operator flips it in a manifest. */
    const switchOn = () => {
        process.env.EVER_WORKS_APP_LAUNCHER_ENABLED = 'true';
    };

    interface CallOptions {
        /** Send a session (default true). `false` = signed out. */
        session?: boolean;
        /** `X-Scope-Slug`: which workspace the request runs in. */
        scopeSlug?: string;
    }

    const suite = () => request(app.getHttpServer());

    function getApps(query = '', options: CallOptions = {}) {
        const call = suite().get(`/api/me/apps${query}`);
        if (options.session !== false) {
            call.set('authorization', 'Bearer test-session');
        }
        if (options.scopeSlug) {
            call.set('x-scope-slug', options.scopeSlug);
        }
        return call;
    }

    function putPreferences(body: unknown, options: CallOptions = {}) {
        const call = suite()
            .put('/api/me/apps/preferences')
            .send(body as object);
        if (options.session !== false) {
            call.set('authorization', 'Bearer test-session');
        }
        if (options.scopeSlug) {
            call.set('x-scope-slug', options.scopeSlug);
        }
        return call;
    }

    function getPlatforms(query = '', options: CallOptions = {}) {
        const call = suite().get(`/api/app-launcher/platforms${query}`);
        if (options.session !== false) {
            call.set('authorization', 'Bearer test-session');
        }
        if (options.scopeSlug) {
            call.set('x-scope-slug', options.scopeSlug);
        }
        return call;
    }

    /** One request per route, all three paths in one place. */
    const ALL_ROUTES: Array<{
        label: string;
        call: (options?: CallOptions) => request.Test;
    }> = [
        { label: 'GET /api/me/apps', call: (options) => getApps('', options) },
        {
            label: 'PUT /api/me/apps/preferences',
            call: (options) =>
                putPreferences({ changes: [{ key: `work:${WORK_A}`, pinned: true }] }, options),
        },
        { label: 'GET /api/app-launcher/platforms', call: (options) => getPlatforms('', options) },
    ];

    const seededRows: Record<string, StoredRow[]> = {
        personal: [
            { key: `work:${WORK_A}`, visible: true, pinned: true, pinOrder: 0, order: 0 },
            { key: `work:${WORK_B}`, visible: false, pinned: false, pinOrder: null, order: 1 },
        ],
        [ORG_A]: [{ key: `work:${WORK_A}`, visible: true, pinned: true, pinOrder: 0, order: 0 }],
        [ORG_B]: [
            { key: `work:${WORK_B}`, visible: true, pinned: false, pinOrder: null, order: 0 },
        ],
    };

    // -----------------------------------------------------------------------
    // The installation switch (FR-54, FR-65, ACC-11-28, ACC-11-50)
    // -----------------------------------------------------------------------

    describe('the installation switch', () => {
        it.each(ALL_ROUTES)(
            'answers 404 on $label with EVER_WORKS_APP_LAUNCHER_ENABLED unset (ACC-11-28)',
            async (route) => {
                launcher.reset(seededRows);
                const before = snapshotRows(launcher);

                const response = await route.call();

                expect(response.status).toBe(404);
                // Not one read and not one write reached the registry: the guard
                // runs before the handler, so a switched-off installation does
                // no work at all (FR-65).
                expect(launcher.reads).toHaveLength(0);
                expect(launcher.saves).toHaveLength(0);
                expect(snapshotRows(launcher)).toBe(before);
            },
        );

        it.each(['false', '1', 'yes', 'TRUE', '', 'true '])(
            'treats %p as OFF — only the exact string "true" switches it on',
            async (value) => {
                process.env.EVER_WORKS_APP_LAUNCHER_ENABLED = value;

                const response = await getApps();

                expect(response.status).toBe(404);
                expect(launcher.reads).toHaveLength(0);
            },
        );

        it('answers 404 for a request from another workspace too — the switch is installation-wide', async () => {
            launcher.reset(seededRows);
            const before = snapshotRows(launcher);

            for (const route of ALL_ROUTES) {
                const response = await route.call({ scopeSlug: ORG_B });
                expect(response.status).toBe(404);
            }

            expect(launcher.reads).toHaveLength(0);
            expect(launcher.saves).toHaveLength(0);
            expect(snapshotRows(launcher)).toBe(before);
        });

        it('reads the switch on every request, so flipping it takes effect without a restart', async () => {
            expect((await getApps()).status).toBe(404);

            switchOn();
            expect((await getApps()).status).toBe(200);

            delete process.env.EVER_WORKS_APP_LAUNCHER_ENABLED;
            expect((await getApps()).status).toBe(404);
        });

        it('keeps the guard on both controllers and on the public list (ACC-11-28)', () => {
            expect(guardsOf(AppLauncherController)).toEqual([AppLauncherEnabledGuard]);
            expect(guardsOf(AppLauncherPlatformsController)).toEqual([AppLauncherEnabledGuard]);
        });
    });

    describe('ACC-11-50 — off leaves every stored row untouched, on restores the same list', () => {
        it('returns the identical list before and after a switch-off window', async () => {
            switchOn();
            launcher.reset(seededRows);

            const first = await getApps();
            expect(first.status).toBe(200);
            const storedWhileOn = snapshotRows(launcher);

            // Off: every surface is gone and nothing is read or written.
            delete process.env.EVER_WORKS_APP_LAUNCHER_ENABLED;
            for (const route of ALL_ROUTES) {
                expect((await route.call()).status).toBe(404);
            }
            expect(launcher.reads).toHaveLength(1);
            expect(launcher.saves).toHaveLength(0);
            expect(snapshotRows(launcher)).toBe(storedWhileOn);

            // On again: the same tiles, in the same order, with the same pins.
            process.env.EVER_WORKS_APP_LAUNCHER_ENABLED = 'true';
            const second = await getApps();
            expect(second.status).toBe(200);
            expect(second.body).toEqual(first.body);
            expect(snapshotRows(launcher)).toBe(storedWhileOn);
        });
    });

    // -----------------------------------------------------------------------
    // Throttling (FR-36, ACC-11-26)
    // -----------------------------------------------------------------------

    describe('rate limits (FR-36, ACC-11-26)', () => {
        it('caps reads at 60 and writes at 30 per minute', () => {
            expect(
                Reflect.getMetadata(`${THROTTLER_LIMIT}long`, AppLauncherController.prototype.list),
            ).toBe(APP_LAUNCHER_READS_PER_MINUTE);
            expect(
                Reflect.getMetadata(`${THROTTLER_TTL}long`, AppLauncherController.prototype.list),
            ).toBe(60_000);
            expect(
                Reflect.getMetadata(
                    `${THROTTLER_LIMIT}long`,
                    AppLauncherController.prototype.savePreferences,
                ),
            ).toBe(APP_LAUNCHER_WRITES_PER_MINUTE);
            expect(
                Reflect.getMetadata(
                    `${THROTTLER_TTL}long`,
                    AppLauncherController.prototype.savePreferences,
                ),
            ).toBe(60_000);
        });

        it('caps the public platform list at 120 per minute', () => {
            expect(
                Reflect.getMetadata(
                    `${THROTTLER_LIMIT}long`,
                    AppLauncherPlatformsController.prototype.list,
                ),
            ).toBe(APP_LAUNCHER_PLATFORM_READS_PER_MINUTE);
            expect(
                Reflect.getMetadata(
                    `${THROTTLER_TTL}long`,
                    AppLauncherPlatformsController.prototype.list,
                ),
            ).toBe(60_000);
        });
    });

    // -----------------------------------------------------------------------
    // GET /api/me/apps (plan §4.1, FR-33, FR-53, FR-63)
    // -----------------------------------------------------------------------

    describe('GET /api/me/apps', () => {
        it('answers the service’s list for the SESSION person and the ACTIVE scope (FR-53)', async () => {
            switchOn();
            launcher.reset(seededRows);
            catalog.reset(catalogRead('stage'));

            const response = await getApps();
            expect(response.status).toBe(200);

            expect(launcher.reads).toHaveLength(1);
            expect(launcher.reads[0].userId).toBe(TEST_USER_ID);
            expect(launcher.reads[0].scopeKey).toBe('personal');
            // The catalog's environment, version and availability travel with the
            // tiles, so the panel never re-derives them (S9/S10).
            expect(launcher.reads[0].options).toMatchObject({
                environment: 'stage',
                catalogVersion: 'v1',
                catalogAvailable: true,
                includeHidden: false,
            });
            expect(response.body.meta.environment).toBe('stage');
        });

        it('hands the catalog’s tiles to the registry unchanged', async () => {
            switchOn();
            launcher.reset(seededRows);

            const response = await getApps();

            expect(launcher.reads[0].platforms.map((platform) => platform.key)).toEqual([
                'platform:ever-works',
                'platform:cal-diy',
            ]);
            expect(response.body.items.map((item: AppLauncherItem) => item.key)).toContain(
                'platform:cal-diy',
            );
        });

        it('synthesises the current platform when the catalog served nothing (plan §4.1 step 1)', async () => {
            switchOn();
            catalog.reset(unavailableCatalog('develop'));

            const response = await getApps();
            expect(response.status).toBe(200);

            expect(launcher.reads[0].platforms).toEqual([
                {
                    key: 'platform:ever-works',
                    name: APP_NAME,
                    url: null,
                    host: null,
                    current: true,
                },
            ]);
            // The outage is still reported as an outage — the meta flag is the
            // read's own answer, not "did we hand in a tile".
            expect(launcher.reads[0].options).toMatchObject({
                catalogAvailable: false,
                catalogVersion: null,
                environment: 'develop',
            });
        });

        it('forwards includeHidden and limit, and hides hidden rows by default (FR-27, FR-63)', async () => {
            switchOn();
            launcher.reset(seededRows);

            const panel = await getApps();
            expect(panel.status).toBe(200);
            expect(panel.body.items.map((item: AppLauncherItem) => item.key)).not.toContain(
                `work:${WORK_B}`,
            );

            const manage = await getApps('?includeHidden=true&limit=25');
            expect(manage.status).toBe(200);
            expect(launcher.reads[1].options).toMatchObject({ includeHidden: true, limit: 25 });
            expect(manage.body.items.map((item: AppLauncherItem) => item.key)).toContain(
                `work:${WORK_B}`,
            );
        });

        it.each(['?includeHidden=maybe', '?includeHidden=1', '?limit=0', '?limit=201', '?limit=x'])(
            'answers 400 for %s (plan §4.5)',
            async (query) => {
                switchOn();

                const response = await getApps(query);

                expect(response.status).toBe(400);
                expect(launcher.reads).toHaveLength(0);
            },
        );

        it('forwards the Manage apps filter, trimmed, as `q` (FR-63)', async () => {
            switchOn();
            launcher.reset(seededRows);

            const spaced = await getApps('?includeHidden=true&q=%20cal%20');
            expect(spaced.status).toBe(200);
            expect(launcher.reads[0].options).toMatchObject({ includeHidden: true, filter: 'cal' });

            const atTheCap = await getApps(`?q=${'x'.repeat(APP_LAUNCHER_FILTER_MAX_LENGTH)}`);
            // A filter exactly at the cap is accepted…
            expect(atTheCap.status).toBe(200);
            expect(launcher.reads[1].options.filter).toHaveLength(APP_LAUNCHER_FILTER_MAX_LENGTH);
        });

        it('treats a blank filter as no filter at all rather than a 400 (FR-63)', async () => {
            switchOn();
            launcher.reset(seededRows);

            const response = await getApps('?q=%20%20');

            expect(response.status).toBe(200);
            expect(launcher.reads[0].options.filter ?? '').toBe('');
        });

        it.each<[string, string]>([
            [
                'a filter one character past the cap',
                `?q=${'x'.repeat(APP_LAUNCHER_FILTER_MAX_LENGTH + 1)}`,
            ],
            // A repeated or bracketed parameter arrives as an array, which is not
            // the string the route declares.
            ['an array-shaped filter', '?q[]=cal'],
            // The DTO is the route's whitelist: a parameter it does not declare is
            // still a 400, so `q` cannot quietly become "anything goes".
            ['a parameter the DTO does not declare', '?filter=cal'],
            ['an unknown parameter', '?unknown=1'],
        ])('answers 400 for %s (plan §4.5)', async (_label, query) => {
            switchOn();

            const response = await getApps(query);

            expect(response.status).toBe(400);
            expect(launcher.reads).toHaveLength(0);
        });

        it('serves another workspace its own arrangement, never its neighbour’s (FR-53, FR-62)', async () => {
            switchOn();
            launcher.reset(seededRows);
            const before = snapshotRows(launcher);

            const other = await getApps('', { scopeSlug: ORG_B });
            expect(other.status).toBe(200);
            expect(launcher.reads[0].scopeKey).toBe(ORG_B);

            const keys = other.body.items.map((item: AppLauncherItem) => item.key);
            expect(keys).toContain(`work:${WORK_B}`);
            // Organization A's row for the SAME Work is not reachable from B, and
            // B's read changed nothing at all.
            expect(launcher.reads[0].scopeKey).not.toBe(ORG_A);
            expect(snapshotRows(launcher)).toBe(before);
        });
    });

    // -----------------------------------------------------------------------
    // PUT /api/me/apps/preferences (plan §4.2, FR-35, FR-62, §4.5)
    // -----------------------------------------------------------------------

    describe('PUT /api/me/apps/preferences', () => {
        it('saves the session person’s changes and answers the refreshed list (FR-35)', async () => {
            switchOn();
            launcher.reset(seededRows);

            const response = await putPreferences({
                changes: [
                    { key: `work:${WORK_B}`, visible: true, pinned: true },
                    { key: `work:${WORK_A}`, order: 1200 },
                ],
            });

            expect(response.status).toBe(200);
            expect(launcher.saves).toHaveLength(1);
            expect(launcher.saves[0].userId).toBe(TEST_USER_ID);
            expect(launcher.saves[0].scopeKey).toBe('personal');
            expect(launcher.saves[0].changes).toEqual([
                { key: `work:${WORK_B}`, visible: true, pinned: true },
                { key: `work:${WORK_A}`, order: 1200 },
            ]);
            expect(response.body.saved).toBe(2);
            // Manage apps re-renders from this response, so it is the
            // includeHidden list (plan §4.2:437-438).
            expect(response.body.items.map((item: AppLauncherItem) => item.key)).toContain(
                `work:${WORK_B}`,
            );
        });

        it('writes in the active workspace only (FR-24, FR-62)', async () => {
            switchOn();
            launcher.reset(seededRows);
            const beforeA = rowsIn(launcher, ORG_A);
            const beforePersonal = rowsIn(launcher, 'personal');
            const beforeB = rowsIn(launcher, ORG_B);

            const response = await putPreferences(
                { changes: [{ key: `work:${WORK_B}`, pinned: true }] },
                { scopeSlug: ORG_B },
            );

            expect(response.status).toBe(200);
            expect(launcher.saves[0].scopeKey).toBe(ORG_B);
            // Organization B's own row moved; A's and the personal arrangement
            // are byte-identical (FR-62: a save in one workspace never renumbers
            // another).
            expect(rowsIn(launcher, ORG_B)).not.toBe(beforeB);
            expect(rowsIn(launcher, ORG_A)).toBe(beforeA);
            expect(rowsIn(launcher, 'personal')).toBe(beforePersonal);
        });

        it('refuses the whole save with 422 { code, limit } when it would pin a seventh item (FR-25, §4.5)', async () => {
            switchOn();
            launcher.reset({
                personal: Array.from({ length: APP_LAUNCHER_PIN_LIMIT - 1 }, (_, index) => ({
                    key: `work:${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
                    visible: true,
                    pinned: true,
                    pinOrder: index,
                    order: index,
                })),
            });
            const before = snapshotRows(launcher);

            const response = await putPreferences({
                changes: [
                    { key: `work:${WORK_A}`, pinned: true },
                    { key: `work:${WORK_B}`, pinned: true },
                ],
            });

            expect(response.status).toBe(422);
            expect(response.body).toEqual({ code: 'pinLimit', limit: APP_LAUNCHER_PIN_LIMIT });
            // Nothing was written: the refusal is a property of the resulting
            // arrangement, so the person keeps exactly what they had.
            expect(snapshotRows(launcher)).toBe(before);
        });

        it.each<[string, () => Record<string, unknown>]>([
            [
                'a body with 201 changes',
                () => ({ changes: manyChanges(APP_LAUNCHER_MAX_CHANGES_PER_SAVE + 1) }),
            ],
            ['a body with no changes', () => ({ changes: [] })],
            [
                'a key that is not a platform or Work key',
                () => ({ changes: [{ key: 'work:not-a-uuid' }] }),
            ],
            [
                'a platform key with an illegal character',
                () => ({ changes: [{ key: 'platform:Cal.Diy' }] }),
            ],
            ['an order past 9999', () => ({ changes: [{ key: `work:${WORK_A}`, order: 10_000 }] })],
            [
                'an unknown field inside a change',
                () => ({ changes: [{ key: `work:${WORK_A}`, pinOrder: 0 }] }),
            ],
        ])('answers 400 for %s (plan §4.5)', async (_label, body) => {
            switchOn();
            launcher.reset(seededRows);

            const response = await putPreferences(body());

            expect(response.status).toBe(400);
            // A malformed save never reaches the registry — so it can never be
            // mistaken for a save that ran and rejected items (FR-28).
            expect(launcher.saves).toHaveLength(0);
        });

        it('accepts the whole 200-change budget and the key shapes the plan allows', async () => {
            switchOn();
            launcher.reset(seededRows);

            const response = await putPreferences({
                changes: [
                    ...manyChanges(APP_LAUNCHER_MAX_CHANGES_PER_SAVE - 1),
                    { key: 'platform:cal-diy', visible: false },
                ],
            });

            expect(response.status).toBe(200);
            expect(launcher.saves[0].changes).toHaveLength(APP_LAUNCHER_MAX_CHANGES_PER_SAVE);
        });

        it('answers 400 for a body that is not `{ changes }` at all', async () => {
            switchOn();

            expect((await putPreferences({})).status).toBe(400);
            expect((await putPreferences({ changes: 'nope' })).status).toBe(400);
            expect(launcher.saves).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // GET /api/app-launcher/platforms (plan §4.3, FR-37, ACC-11-27)
    // -----------------------------------------------------------------------

    describe('GET /api/app-launcher/platforms', () => {
        it('is public and readable signed out (FR-37)', async () => {
            switchOn();
            catalog.reset(catalogRead('production'));

            const response = await getPlatforms('', { session: false });

            expect(response.status).toBe(200);
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppLauncherPlatformsController)).toBe(true);
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppLauncherController)).toBeFalsy();
        });

        it('carries the one-hour cache header and a wildcard origin with no credentials (ACC-11-27)', async () => {
            switchOn();

            const response = await getPlatforms('', { session: false });

            expect(response.headers['cache-control']).toBe(APP_LAUNCHER_PLATFORMS_CACHE_CONTROL);
            expect(response.headers['access-control-allow-origin']).toBe('*');
            expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        });

        it('answers exactly { catalogVersion, environment, platforms } (plan §4.3)', async () => {
            switchOn();
            catalog.reset(catalogRead('stage'));

            const response = await getPlatforms('?environment=stage', { session: false });

            expect(response.status).toBe(200);
            expect(Object.keys(response.body).sort()).toEqual([
                'catalogVersion',
                'environment',
                'platforms',
            ]);
            expect(response.body.catalogVersion).toBe('v1');
            expect(response.body.environment).toBe('stage');
            expect(response.body.platforms.map((item: AppLauncherItem) => item.key)).toEqual([
                'platform:ever-works',
                'platform:cal-diy',
            ]);
            expect(catalog.reads).toEqual(['stage']);
        });

        it('ignores an unrecognised environment rather than answering a different one (FR-10)', async () => {
            switchOn();

            const response = await getPlatforms('?environment=staging', { session: false });

            expect(response.status).toBe(200);
            expect(catalog.reads).toEqual([undefined]);
        });
    });

    // -----------------------------------------------------------------------
    // Wiring (plan §4:353-354)
    // -----------------------------------------------------------------------

    describe('module wiring', () => {
        it('declares both controllers and both API-side providers', () => {
            expect(Reflect.getMetadata('controllers', AppLauncherModule)).toEqual([
                AppLauncherController,
                AppLauncherPlatformsController,
            ]);
            expect(Reflect.getMetadata('providers', AppLauncherModule)).toEqual([
                AppLauncherEnabledGuard,
                PlatformCatalogService,
            ]);
        });

        it('binds the installation guard to every declared controller', () => {
            const controllers = (Reflect.getMetadata('controllers', AppLauncherModule) ??
                []) as object[];

            expect(controllers).toHaveLength(2);
            for (const controller of controllers) {
                expect(guardsOf(controller)).toContain(AppLauncherEnabledGuard);
            }
        });

        it('is registered in the API root module additively', () => {
            // The one thing a unit test cannot exercise without booting the whole
            // application: the module is nearly useless if it exists and is never
            // imported. Read rather than reflected, so the check fails loudly if
            // the registration is dropped.
            const source = readFileSync(join(__dirname, '..', 'api.module.ts'), 'utf8');

            expect(source).toContain(
                "import { AppLauncherModule } from './app-launcher/app-launcher.module';",
            );
            expect(source).toMatch(/^\s*AppLauncherModule,$/m);
            // Additive: the neighbour this was inserted next to is still there.
            expect(source).toMatch(/^\s*WorkAgentModule,$/m);
        });
    });

    // -----------------------------------------------------------------------
    // The DTOs, at their boundaries (plan §4.1's table, §4.2's body)
    // -----------------------------------------------------------------------

    describe('request shapes', () => {
        it('names the key pattern and the 9999 order ceiling the plan states', () => {
            expect(APP_LAUNCHER_ITEM_KEY_PATTERN.test('platform:cal-diy')).toBe(true);
            expect(APP_LAUNCHER_ITEM_KEY_PATTERN.test(`work:${WORK_A}`)).toBe(true);
            expect(APP_LAUNCHER_ITEM_KEY_PATTERN.test('work:WORK-A')).toBe(false);
            expect(APP_LAUNCHER_ITEM_KEY_PATTERN.test('platform:a')).toBe(false);
        });

        it('validates the two routes with the DTOs declared for them', () => {
            // The 3-argument form is the one Nest itself reads
            // (`PipesContextCreator.getParamTypes`): `emitDecoratorMetadata`
            // records a method's parameter types on the PROTOTYPE under the
            // method's name, not on the function object.
            const listParams = Reflect.getMetadata(
                'design:paramtypes',
                AppLauncherController.prototype,
                'list',
            ) as unknown[];
            const saveParams = Reflect.getMetadata(
                'design:paramtypes',
                AppLauncherController.prototype,
                'savePreferences',
            ) as unknown[];

            expect(listParams).toContain(ListAppLauncherQueryDto);
            expect(saveParams).toContain(SaveAppLauncherPreferencesDto);
        });

        it('declares the FR-63 filter as `q` and trims it in the DTO itself', async () => {
            // The pipe the two HTTP suites above run through, so the trim cannot be
            // a client-side convention the API does not hold.
            const pipe = new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
            });
            const context = { type: 'query' as const, metatype: ListAppLauncherQueryDto };

            await expect(pipe.transform({ q: '  cal  ' }, context)).resolves.toEqual({ q: 'cal' });
            await expect(pipe.transform({}, context)).resolves.toEqual({});
        });
    });
});

/** `count` distinct, valid `work:<uuid>` keys — a full-size save. */
function manyChanges(count: number): AppLauncherPreferenceChange[] {
    return Array.from({ length: count }, (_, index) => ({
        key: `work:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        order: index % 10_000,
    }));
}
