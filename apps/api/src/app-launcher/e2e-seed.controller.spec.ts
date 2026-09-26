import 'reflect-metadata';
import {
    type CanActivate,
    type ExecutionContext,
    Injectable,
    type INestApplication,
    UnauthorizedException,
    ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { type AppLauncherItem, type AppLauncherListResponse } from '@ever-works/contracts';
import { AppLauncherService } from '@ever-works/agent/app-launcher';
import {
    AppLauncherPreferenceRepository,
    ENTITIES,
    WorkCustomDomainRepository,
    WorkDeploymentRepository,
    WorkMemberRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import {
    AppLauncherPreference,
    DeploymentEnvironment,
    Work,
    WorkCustomDomain,
    WorkDeployment,
    WorkMember,
} from '@ever-works/agent/entities';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ScopeContextService } from '../scope/scope-context.service';
import { AppLauncherController } from './app-launcher.controller';
import { AppLauncherModule } from './app-launcher.module';
import {
    E2eSeedController,
    E2eSeedEnabledGuard,
    isE2eAppLauncherSeedEnabled,
    type E2eSeedResponse,
} from './e2e-seed.controller';
import type { E2eSeedWorkDto } from './dto/e2e-seed.dto';
import { PlatformCatalogService, type PlatformCatalogRead } from './platform-catalog.service';

/**
 * APW-11 T33 — the non-production seed route, through a real HTTP stack over a
 * real in-memory database.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` (ACC-11-52);
 * plan §9.3 (`plan.md:1010-1024`, the route, the two-variable gate and the DTO)
 * and CONTRACTS R-40 (`CONTRACTS.md:83`) are what this spec asserts.
 *
 * ## Why HTTP, and why a real database
 *
 * Three of the four cases the task names are properties of the **route**, not of
 * a method body — `404` from the gate before the handler, `401` for a request
 * with no session, and the exact status of a successful seed. A direct call to
 * `seed()` would assert none of them: a guard never runs, and a refused request
 * would still reach the method.
 *
 * The fourth case (ACC-11-52) is the one that must not be faked. The seeded Work
 * has to arrive in `GET /api/me/apps` as a **live tile with the address FR-16
 * resolves**, and the only honest way to assert that is to let the real
 * `GET /api/me/apps` route call the real `AppLauncherService` over the rows this
 * route just wrote. So the harness is T6's
 * (`packages/agent/src/app-launcher/__tests__/app-launcher.service.spec.ts`):
 * a real in-memory better-sqlite3 `DataSource` built from the platform's own
 * `ENTITIES`, real repositories over it, the real `AppLauncherController`, and a
 * fake only for the two collaborators this task does not own — the runtime
 * platform catalog (`PlatformCatalogService`, T8, which would otherwise fetch
 * over the network) and the session itself.
 *
 * Nothing is stubbed between the seed and the read: `WorkRepository`,
 * `WorkDeploymentRepository`, `WorkCustomDomainRepository`,
 * `WorkMemberRepository` and `AppLauncherPreferenceRepository` are all the
 * production classes, and every address asserted below is resolved by
 * `launcher-address.ts` from the rows the route wrote.
 *
 * ## Scope
 *
 * The real `ScopeContextService` is used, seeded per request by a middleware
 * that wraps `next()` in `runWith` — the same idiom as
 * `apps/api/src/scope/scope-resolver.middleware.ts:85-94` — so "the signed-in
 * person's own scope" is asserted against the mechanism the platform actually
 * uses rather than against a hand-set field.
 */

// ---------------------------------------------------------------------------
// Identities, hosts and environment
// ---------------------------------------------------------------------------

/** The signed-in person every authenticated call runs as (FR-53). */
const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A second person, present only so "not the signed-in one" is provable. */
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The tenant every request runs under. */
const TENANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** An Organization scope, for the "own workspace, not the neighbour's" case. */
const ORG_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** `EVER_WORKS_APPS_DOMAIN` — the apex an App Work's label is allocated on. */
const APPS_APEX = 'apps.e2e.ever.works.test';

/** `EVER_WORKS_DOMAIN` — the platform's own managed root. */
const PLATFORM_ROOT = 'e2e.ever.works.test';

/** Every variable this spec drives. Restored after each test. */
const ENV_KEYS = [
    'NODE_ENV',
    'E2E_APP_LAUNCHER_SEED',
    'EVER_WORKS_APP_LAUNCHER_ENABLED',
    'EVER_WORKS_DOMAIN',
    'EVER_WORKS_APPS_DOMAIN',
] as const;

/** The gate, as an operator in the PR lane sets it (`.github/workflows/e2e.yml`). */
function openSeedGate(): void {
    process.env.NODE_ENV = 'test';
    process.env.E2E_APP_LAUNCHER_SEED = 'true';
}

// ---------------------------------------------------------------------------
// The session stand-in (models `AuthSessionGuard`, apps/api/src/auth/guards)
// ---------------------------------------------------------------------------

/**
 * `@CurrentUser()` reads `request.user`, which the platform's global
 * `AuthSessionGuard` populates. This reproduces its two observable facts: a
 * request with an `authorization` header is a session, and a request without one
 * is a `401` (`auth-session.guard.ts:155-163`) — never a handler that runs with
 * no person.
 */
@Injectable()
class TestSessionGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const http = context.switchToHttp().getRequest();
        if (typeof http.headers?.authorization === 'string') {
            http.user = { userId: TEST_USER_ID };
            return true;
        }
        throw new UnauthorizedException();
    }
}

/** T8's reader, replaced so the spec performs no network call. */
const CATALOG: PlatformCatalogRead = {
    environment: 'production',
    catalogVersion: 'e2e-fixture',
    catalogAvailable: true,
    stale: false,
    platforms: [
        {
            key: 'platform:ever-works',
            kind: 'platform',
            section: 'platforms',
            name: 'Ever Works',
            url: `https://${PLATFORM_ROOT}/`,
            host: PLATFORM_ROOT,
            current: true,
            status: 'available',
            visible: true,
            pinned: false,
            pinOrder: null,
            order: 0,
            catalogOrder: 0,
            manageState: 'listed',
        },
    ],
};

/** A catalog stand-in that answers what T8's reader would, with no fetch. */
class FakeCatalogService {
    readonly reads: Array<string | undefined> = [];

    async read(environment?: string): Promise<PlatformCatalogRead> {
        this.reads.push(environment);
        return CATALOG;
    }

    async list(environment?: string): Promise<PlatformCatalogRead['platforms']> {
        return (await this.read(environment)).platforms;
    }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

describe('APW-11 T33 — POST /api/e2e/app-launcher/seed', () => {
    const envBackup = { ...process.env };

    let dataSource: DataSource;
    let app: INestApplication;
    let scopeContext: ScopeContextService;
    let catalog: FakeCatalogService;

    const guardsOf = (controller: object): unknown[] =>
        (Reflect.getMetadata('__guards__', controller) ?? []) as unknown[];

    /** The controllers `AppLauncherModule` actually declares. */
    const controllerNames = (module: object): string[] =>
        ((Reflect.getMetadata('controllers', module) ?? []) as Array<{ name: string }>).map(
            (controller) => controller.name,
        );

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The fixture writes rows for a person who exists in the real product but
        // not in this database; FK enforcement would refuse the Work, and it is
        // not what this spec is about (T6's harness does the same).
        await dataSource.query('PRAGMA foreign_keys = OFF');

        scopeContext = new ScopeContextService();
        catalog = new FakeCatalogService();

        const moduleRef = await Test.createTestingModule({
            controllers: [E2eSeedController, AppLauncherController],
            providers: [
                { provide: getRepositoryToken(Work), useValue: dataSource.getRepository(Work) },
                {
                    provide: getRepositoryToken(WorkDeployment),
                    useValue: dataSource.getRepository(WorkDeployment),
                },
                {
                    provide: getRepositoryToken(WorkCustomDomain),
                    useValue: dataSource.getRepository(WorkCustomDomain),
                },
                { provide: ScopeContextService, useValue: scopeContext },
                { provide: PlatformCatalogService, useValue: catalog },
                { provide: AppLauncherService, useValue: buildService() },
                TestSessionGuard,
                { provide: APP_GUARD, useExisting: TestSessionGuard },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        // The platform's own pipe (`apps/api/src/main.ts:199-205`), which is what
        // turns a body outside the closed fixture shape into a `400`.
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
        );
        // The scope-resolution idiom of `scope-resolver.middleware.ts:85-94`:
        // wrap `next()` in `runWith` so the whole request runs inside the scope.
        app.use((req: { headers?: Record<string, unknown> }, _res: unknown, next: () => void) => {
            const slug = req.headers?.['x-scope-slug'];
            const organizationId = typeof slug === 'string' && slug.length > 0 ? slug : null;
            scopeContext.runWith({ tenantId: TENANT_ID, organizationId }, () => next());
        });
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
        await dataSource?.destroy();
        process.env = { ...envBackup };
    });

    beforeEach(async () => {
        process.env = { ...envBackup };
        openSeedGate();
        process.env.EVER_WORKS_APP_LAUNCHER_ENABLED = 'true';
        process.env.EVER_WORKS_DOMAIN = PLATFORM_ROOT;
        process.env.EVER_WORKS_APPS_DOMAIN = APPS_APEX;

        await dataSource.query('DELETE FROM "app_launcher_preferences"');
        await dataSource.query('DELETE FROM "work_members"');
        await dataSource.query('DELETE FROM "work_deployments"');
        await dataSource.query('DELETE FROM "work_custom_domains"');
        await dataSource.query('DELETE FROM "works"');
    });

    /** T6's registry, wired to the real repositories over this database. */
    function buildService(): AppLauncherService {
        return new AppLauncherService(
            new WorkRepository(dataSource.getRepository(Work)),
            new WorkMemberRepository(dataSource.getRepository(WorkMember)),
            new WorkDeploymentRepository(dataSource.getRepository(WorkDeployment)),
            new WorkCustomDomainRepository(dataSource.getRepository(WorkCustomDomain)),
            new AppLauncherPreferenceRepository(dataSource.getRepository(AppLauncherPreference)),
            dataSource,
        );
    }

    /** The fixture ACC-11-52 names: a live App Work with a managed subdomain. */
    function liveAppFixture(): Record<string, unknown> {
        return {
            kind: 'app',
            name: 'Seeded App Work',
            managedSubdomain: 'seeded-app',
            deployments: [
                {
                    state: 'READY',
                    environment: 'production',
                    website: 'https://fallback.example.test/',
                },
            ],
        };
    }

    interface CallOptions {
        /** Send a session (default true). `false` = signed out. */
        session?: boolean;
        /** `X-Scope-Slug`: which workspace the request runs in. */
        scopeSlug?: string;
    }

    const suite = () => request(app.getHttpServer());

    function seed(body: unknown = liveAppFixture(), options: CallOptions = {}) {
        const call = suite()
            .post('/api/e2e/app-launcher/seed')
            .send(body as object);
        if (options.session !== false) {
            call.set('authorization', 'Bearer test-session');
        }
        if (options.scopeSlug) {
            call.set('x-scope-slug', options.scopeSlug);
        }
        return call;
    }

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

    async function countWorks(): Promise<number> {
        return dataSource.getRepository(Work).count();
    }

    function tileIn(body: AppLauncherListResponse, workId: string): AppLauncherItem | undefined {
        return body.items.find((item) => item.key === `work:${workId}`);
    }

    // -----------------------------------------------------------------------
    // The gate (plan §9.3, R-40) — 404, never 403, before the handler
    // -----------------------------------------------------------------------

    describe('the two-variable gate', () => {
        it('answers 404 with NODE_ENV=production even when E2E_APP_LAUNCHER_SEED is set', async () => {
            process.env.NODE_ENV = 'production';
            process.env.E2E_APP_LAUNCHER_SEED = 'true';

            const response = await seed();

            expect(response.status).toBe(404);
            // 404, not 403: a production process must not confirm that a seed
            // route exists on this host.
            expect(response.body.message).toBe('Cannot find route');
            // The gate ran before the handler: nothing was parsed, nothing written.
            expect(await countWorks()).toBe(0);
        });

        it.each(['test', 'development', 'staging', ''])(
            'answers 404 with E2E_APP_LAUNCHER_SEED unset in NODE_ENV=%p',
            async (nodeEnv) => {
                process.env.NODE_ENV = nodeEnv;
                delete process.env.E2E_APP_LAUNCHER_SEED;

                const response = await seed();

                expect(response.status).toBe(404);
                expect(await countWorks()).toBe(0);
            },
        );

        it.each(['false', '1', 'yes', 'TRUE', '', 'true '])(
            'treats %p as OFF — only the exact string "true" opens the route',
            async (value) => {
                process.env.NODE_ENV = 'test';
                process.env.E2E_APP_LAUNCHER_SEED = value;

                const response = await seed();

                expect(response.status).toBe(404);
                expect(await countWorks()).toBe(0);
            },
        );

        it('reads production FIRST, before either variable is consulted', async () => {
            process.env.NODE_ENV = 'production';
            process.env.E2E_APP_LAUNCHER_SEED = 'true';
            expect(isE2eAppLauncherSeedEnabled()).toBe(false);

            process.env.NODE_ENV = 'test';
            expect(isE2eAppLauncherSeedEnabled()).toBe(true);

            delete process.env.E2E_APP_LAUNCHER_SEED;
            expect(isE2eAppLauncherSeedEnabled()).toBe(false);
        });

        it('keeps the gate on the controller and keeps the route private', () => {
            expect(guardsOf(E2eSeedController)).toEqual([E2eSeedEnabledGuard]);
            // Session-authenticated, never public: it writes for somebody.
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, E2eSeedController)).toBeFalsy();
        });
    });

    // -----------------------------------------------------------------------
    // The session
    // -----------------------------------------------------------------------

    describe('the session', () => {
        it('refuses a request without a session and writes nothing', async () => {
            const response = await seed(liveAppFixture(), { session: false });

            expect(response.status).toBe(401);
            expect(await countWorks()).toBe(0);
        });

        it('refuses in the handler too, so a harness without the global guard cannot write an ownerless row', async () => {
            const controller = new E2eSeedController(
                dataSource.getRepository(Work),
                dataSource.getRepository(WorkDeployment),
                dataSource.getRepository(WorkCustomDomain),
                scopeContext,
            );

            await expect(
                controller.seed(
                    undefined as unknown as Parameters<typeof controller.seed>[0],
                    liveAppFixture() as unknown as E2eSeedWorkDto,
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(await countWorks()).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // What a successful seed writes
    // -----------------------------------------------------------------------

    describe('the fixture it writes', () => {
        it('writes the Work for the SESSION person, in the ACTIVE scope, and answers 201', async () => {
            const response = await seed();

            expect(response.status).toBe(201);
            const body = response.body as E2eSeedResponse;
            expect(body.workId).toMatch(/^[0-9a-f-]{36}$/);

            const work = await dataSource.getRepository(Work).findOneByOrFail({ id: body.workId });
            expect(work.userId).toBe(TEST_USER_ID);
            expect(work.tenantId).toBe(TENANT_ID);
            expect(work.organizationId).toBeNull();
            // APW-01 is not landed: `kind: 'app'` is the RAW VARCHAR the column
            // already is, and this is the row that proves it round-trips.
            expect(work.kind).toBe('app');
            expect(work.status).toBe('active');
            expect(work.managedSubdomain).toBe('seeded-app');
            expect(work.slug).toBe('seeded-app-work');
        });

        it('writes one Work per request into the workspace the request names', async () => {
            const personal = await seed(liveAppFixture());
            const inOrg = await seed(
                { ...liveAppFixture(), name: 'Org Work', managedSubdomain: 'org-work' },
                { scopeSlug: ORG_A },
            );

            expect(personal.status).toBe(201);
            expect(inOrg.status).toBe(201);

            const rows = await dataSource.getRepository(Work).find({ order: { name: 'ASC' } });
            expect(rows.map((row) => [row.name, row.organizationId])).toEqual([
                ['Org Work', ORG_A],
                ['Seeded App Work', null],
            ]);
            // Both belong to the signed-in person; the workspace is what differs.
            expect(rows.every((row) => row.userId === TEST_USER_ID)).toBe(true);
        });

        it('seeds the states T20 needs, including an earlier READY followed by an ERROR', async () => {
            const live = await seed(liveAppFixture(), {}).then(
                (response) => response.body as E2eSeedResponse,
            );

            const failedAfterSuccess = await seed({
                kind: 'app',
                name: 'Failed After Success',
                managedSubdomain: 'failed-after-success',
                deployments: [
                    {
                        state: 'READY',
                        environment: 'production',
                        website: 'https://first.example.test/',
                        createdAt: '2026-01-01T00:00:00.000Z',
                    },
                    {
                        state: 'ERROR',
                        environment: 'production',
                        createdAt: '2026-02-01T00:00:00.000Z',
                    },
                ],
            }).then((response) => response.body as E2eSeedResponse);

            const customDomain = await seed({
                kind: 'app',
                name: 'Custom Domain Work',
                deployments: [{ state: 'READY', environment: 'production' }],
                customDomain: {
                    domain: 'custom.example.test',
                    verified: true,
                    environment: 'production',
                    createdAt: '2026-01-15T00:00:00.000Z',
                },
            }).then((response) => response.body as E2eSeedResponse);

            const neverDeployed = await seed({
                kind: 'website',
                name: 'Never Deployed',
                deployments: [],
            }).then((response) => response.body as E2eSeedResponse);

            expect(neverDeployed.deployments).toEqual([]);
            expect(customDomain.customDomain).toMatchObject({
                domain: 'custom.example.test',
                verified: true,
                environment: 'production',
                createdAt: '2026-01-15T00:00:00.000Z',
            });

            // The fixture stated the order, and the order is what was stored:
            // the ERROR row is the newest, so FR-58's chip comes from it while the
            // earlier READY row keeps the Work live (ACC-11-12).
            const repositories = new WorkDeploymentRepository(
                dataSource.getRepository(WorkDeployment),
            );
            const latest = await repositories.findLatestForWorks(
                [live.workId, failedAfterSuccess.workId, customDomain.workId],
                DeploymentEnvironment.PRODUCTION,
            );
            expect(latest.get(failedAfterSuccess.workId)?.state).toBe('ERROR');
            const latestReady = await repositories.findLatestReadyForWorks(
                [failedAfterSuccess.workId],
                DeploymentEnvironment.PRODUCTION,
            );
            expect(latestReady.get(failedAfterSuccess.workId)?.website).toBe(
                'https://first.example.test/',
            );
        });

        it('refuses a body outside the closed fixture shape with 400 and writes nothing', async () => {
            const bodies: Array<[string, Record<string, unknown>]> = [
                ['a kind the plan does not have', { ...liveAppFixture(), kind: 'marketplace' }],
                ['an unknown top-level field', { ...liveAppFixture(), cluster: 'prod-eu' }],
                [
                    'a deployment state outside READY/ERROR',
                    {
                        ...liveAppFixture(),
                        deployments: [{ state: 'BUILDING', environment: 'production' }],
                    },
                ],
                [
                    'a preview custom domain (the two enums are different)',
                    {
                        ...liveAppFixture(),
                        customDomain: {
                            domain: 'custom.example.test',
                            verified: true,
                            environment: 'preview',
                        },
                    },
                ],
                [
                    'a custom domain carrying a scheme',
                    {
                        ...liveAppFixture(),
                        customDomain: {
                            domain: 'https://custom.example.test',
                            verified: true,
                            environment: 'production',
                        },
                    },
                ],
                ['no deployments key at all', { kind: 'app', name: 'No Deployments Key' }],
                ['a non-array deployments value', { ...liveAppFixture(), deployments: 'none' }],
            ];

            for (const [label, body] of bodies) {
                const response = await seed(body);
                // The label travels with the status so a failure names the case.
                expect({ label, status: response.status }).toEqual({ label, status: 400 });
            }
            expect(await countWorks()).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // ACC-11-52 — the seeded rows reach the real GET /api/me/apps
    // -----------------------------------------------------------------------

    describe('ACC-11-52 — a seeded Work appears in GET /api/me/apps', () => {
        it('seeds a READY production deployment plus a managed subdomain, and the tile carries the expected url', async () => {
            const seeded = await seed();
            expect(seeded.status).toBe(201);
            const { workId } = seeded.body as E2eSeedResponse;

            // The rows themselves, read out of the database the route wrote.
            const deployments = await dataSource
                .getRepository(WorkDeployment)
                .find({ where: { workId } });
            expect(deployments).toHaveLength(1);
            expect(deployments[0]).toMatchObject({
                state: 'READY',
                environment: 'production',
                website: 'https://fallback.example.test/',
            });

            // ...and the same Work through the real route, the real service and
            // the real repositories — no fake stands between the two.
            const list = await getApps();

            expect(list.status).toBe(200);
            const tile = tileIn(list.body as AppLauncherListResponse, workId);
            expect(tile).toBeDefined();
            expect(tile?.name).toBe('Seeded App Work');
            expect(tile?.workKind).toBe('app');
            expect(tile?.manageState).toBe('listed');
            expect(tile?.section).toBe('works');
            // FR-16: the managed subdomain is preferred to the address the
            // deployment reported, and the label sits on the APPS apex.
            expect(tile?.url).toBe(`https://seeded-app.${APPS_APEX}/`);
            expect(tile?.host).toBe(`seeded-app.${APPS_APEX}`);
            expect(tile?.url).not.toBe('https://fallback.example.test/');
        });

        it('gives every seeded state the tile its acceptance criterion expects', async () => {
            const failed = await seed({
                kind: 'app',
                name: 'Failed After Success',
                managedSubdomain: 'failed-after-success',
                deployments: [
                    {
                        state: 'READY',
                        environment: 'production',
                        createdAt: '2026-01-01T00:00:00.000Z',
                    },
                    {
                        state: 'ERROR',
                        environment: 'production',
                        createdAt: '2026-02-01T00:00:00.000Z',
                    },
                ],
            }).then((response) => response.body as E2eSeedResponse);

            const custom = await seed({
                kind: 'app',
                name: 'Custom Domain Work',
                managedSubdomain: 'custom-domain-work',
                deployments: [{ state: 'READY', environment: 'production' }],
                customDomain: {
                    domain: 'custom.example.test',
                    verified: true,
                    environment: 'production',
                },
            }).then((response) => response.body as E2eSeedResponse);

            const neverDeployed = await seed({
                kind: 'app',
                name: 'Never Deployed',
                deployments: [],
            }).then((response) => response.body as E2eSeedResponse);

            // A Work seeded into another workspace is not in this one's panel.
            const otherScope = await seed(
                {
                    kind: 'app',
                    name: 'Other Workspace Work',
                    managedSubdomain: 'other-workspace',
                    deployments: [{ state: 'READY', environment: 'production' }],
                },
                { scopeSlug: ORG_A },
            ).then((response) => response.body as E2eSeedResponse);

            const list = await getApps('?includeHidden=true');
            expect(list.status).toBe(200);
            const body = list.body as AppLauncherListResponse;

            // FR-58 + ACC-11-12: the ERROR row chips the tile, the earlier READY
            // row keeps it live and addressed.
            const failedTile = tileIn(body, failed.workId);
            expect(failedTile?.chip).toBe('lastDeployFailed');
            expect(failedTile?.manageState).toBe('listed');
            expect(failedTile?.url).toBe(`https://failed-after-success.${APPS_APEX}/`);

            // FR-16's first preference: the verified production custom domain
            // wins over the managed label.
            expect(tileIn(body, custom.workId)?.url).toBe('https://custom.example.test/');

            // FR-15: no successful deployment is not live, so it is a Manage-apps
            // row with no address.
            const neverLive = tileIn(body, neverDeployed.workId);
            expect(neverLive?.manageState).toBe('notLive');
            expect(neverLive?.url).toBeNull();

            expect(tileIn(body, otherScope.workId)).toBeUndefined();

            const seen = await getApps('', { scopeSlug: ORG_A });
            expect(tileIn(seen.body as AppLauncherListResponse, otherScope.workId)).toBeDefined();
            expect(
                tileIn(seen.body as AppLauncherListResponse, neverDeployed.workId),
            ).toBeUndefined();
        });

        it('is never reachable for a person who is not the caller (FR-53)', async () => {
            const seeded = await seed().then((response) => response.body as E2eSeedResponse);

            const work = await dataSource
                .getRepository(Work)
                .findOneByOrFail({ id: seeded.workId });
            expect(work.userId).toBe(TEST_USER_ID);
            expect(work.userId).not.toBe(OTHER_USER_ID);

            // A read as somebody else would not find it — asserted through the
            // service's own candidate rule rather than by trusting the column.
            const otherUsersWorks = new WorkRepository(dataSource.getRepository(Work));
            const candidates = await otherUsersWorks.findLauncherCandidates({
                userId: OTHER_USER_ID,
                memberWorkIds: [],
                organizationId: null,
            });
            expect(candidates.map((candidate) => candidate.id)).not.toContain(seeded.workId);
        });
    });

    // -----------------------------------------------------------------------
    // Module registration (plan §9.3: "register it only when the gate is open")
    // -----------------------------------------------------------------------

    describe('module registration', () => {
        it('declares the two launcher controllers when the gate was closed at import', () => {
            expect(controllerNames(AppLauncherModule)).toEqual([
                'AppLauncherController',
                'AppLauncherPlatformsController',
            ]);
        });

        it('adds the seed controller only when the gate is open at boot — and never in production', () => {
            const load = (): string[] => {
                let names: string[] = [];
                jest.isolateModules(() => {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const loaded = require('./app-launcher.module') as {
                        AppLauncherModule: object;
                    };
                    names = controllerNames(loaded.AppLauncherModule);
                });
                return names;
            };

            process.env.NODE_ENV = 'test';
            delete process.env.E2E_APP_LAUNCHER_SEED;
            expect(load()).toEqual(['AppLauncherController', 'AppLauncherPlatformsController']);

            process.env.E2E_APP_LAUNCHER_SEED = 'true';
            expect(load()).toEqual([
                'AppLauncherController',
                'AppLauncherPlatformsController',
                'E2eSeedController',
            ]);

            // The variable is still set — production is what closes the door.
            process.env.NODE_ENV = 'production';
            expect(load()).toEqual(['AppLauncherController', 'AppLauncherPlatformsController']);
        });
    });
});
