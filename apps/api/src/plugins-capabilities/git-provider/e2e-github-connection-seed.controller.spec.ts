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
import { GitFacadeService } from '@ever-works/agent/facades';
import { AuthAccountRepository, ENTITIES } from '@ever-works/agent/database';
import { AuthAccount } from '@ever-works/agent/entities';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { GitProviderService } from './git-provider.service';
import { GitProviderModule } from './git-provider.module';
import {
    E2eConnectionSeedEnabledGuard,
    E2eGitHubConnectionSeedController,
    E2E_CONNECTION_SEED_FAKE_URL_ENV,
    E2E_CONNECTION_SEED_FAKES_ENV,
    isE2eGitHubConnectionSeedEnabled,
    type E2eGitHubConnectionSeedResponse,
} from './e2e-github-connection-seed.controller';
import {
    E2E_CONNECTION_SEED_DEFAULT_SCOPE,
    type E2eGitHubConnectionSeedDto,
} from './dto/e2e-github-connection-seed.dto';

/**
 * `GitProviderModule` imports `AuthModule` for the read controller's guard, and
 * that module's graph reaches `p-map` (ESM-only, which jest does not transform)
 * through `@ever-works/agent/services`. The registration case below is the only
 * one that re-requires the module, and it asserts **which controllers are
 * declared** — a fact `AuthModule` cannot influence. So the module is replaced
 * by an empty class here, and every other case in this file runs against the
 * real one through the real HTTP stack.
 */
jest.mock('../../auth/auth.module', () => ({ AuthModule: class AuthModule {} }));

/**
 * APW-13 T63 — the non-production GitHub connection-seeding route, through a
 * real HTTP stack over a real in-memory database.
 *
 * Spec: `docs/specs/features/app-works/APW-13-golden-paths/spec.md` (FR-56);
 * plan §8.8 surface (b) (`plan.md:661`) is the surface this spec pins, and
 * CONTRACTS R-40 (`CONTRACTS.md:87`) is the standing pattern for a
 * non-production lane hook.
 *
 * ## Why HTTP, and why a real database
 *
 * Half the cases the task names are properties of the **route** rather than of a
 * method body — `404` from the gate *before* the handler, `401` for a request
 * with no session, `400` for a body outside the closed shape, and the exact
 * status of a successful seed. A direct call to `seed()` would assert none of
 * them: a guard never runs, the pipe never validates, and a refused request
 * would still reach the method.
 *
 * The other half must not be faked either: the row this route writes is read
 * back through the platform's **own** read path — the real
 * `GitProviderService.checkConnection` over the real `AuthAccountRepository`,
 * with only the network-facing facade stubbed — so "the surface exists" is
 * asserted against the mechanism `GET /api/git-providers/github/connection`
 * uses, not against the row this spec just wrote.
 *
 * The harness is APW-11 T33's (`app-launcher/e2e-seed.controller.spec.ts`): a
 * real in-memory better-sqlite3 `DataSource` built from the platform's own
 * `ENTITIES`, the real repositories over it, the real controller, and a fake
 * only for the two collaborators this task does not own — the git facade (which
 * would otherwise call GitHub) and the session itself.
 */

// ---------------------------------------------------------------------------
// Identities, variables and the LANE's own values
// ---------------------------------------------------------------------------

/** The signed-in person every authenticated call runs as. */
const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A second run account, present so "its own row, not the neighbour's" is provable. */
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The fake GitHub's seeded identity (`.github/workflows/e2e.yml` arms it). */
const LANE_TOKEN = 'apw-e2e-user-token';

/** The login the fake answers `GET /user` with for that token. */
const LANE_LOGIN = 'apw-e2e-user';

/** The origin the lane points the plugin at. */
const FAKE_ORIGIN = 'http://127.0.0.1:3900';

/** Every variable this spec drives. Restored after each test. */
const ENV_KEYS = [
    'NODE_ENV',
    E2E_CONNECTION_SEED_FAKES_ENV,
    E2E_CONNECTION_SEED_FAKE_URL_ENV,
] as const;

/** The gate, as the PR lane arms it (`.github/workflows/e2e.yml`). */
function armSeedGate(): void {
    process.env.NODE_ENV = 'test';
    process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
    process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;
}

// ---------------------------------------------------------------------------
// The session stand-in (models `AuthSessionGuard`, apps/api/src/auth/guards)
// ---------------------------------------------------------------------------

/**
 * `@CurrentUser()` reads `request.user`, which the platform's global
 * `AuthSessionGuard` populates. This reproduces its two observable facts: a
 * request with an `authorization` header is a session, and a request without one
 * is a `401` — never a handler that runs with no person.
 *
 * The `x-test-user` header exists only so this spec can act as **two** run
 * accounts; the platform has no such header and the route never reads one.
 */
@Injectable()
class TestSessionGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const http = context.switchToHttp().getRequest();
        if (typeof http.headers?.authorization === 'string') {
            const requested = http.headers['x-test-user'];
            http.user = { userId: typeof requested === 'string' ? requested : TEST_USER_ID };
            return true;
        }
        throw new UnauthorizedException();
    }
}

/**
 * The git facade, reduced to the two calls `GitProviderService.checkConnection`
 * makes. `getAvailableProviders` is what makes the provider resolvable at all
 * and `getUser` is the call that would otherwise reach the fake GitHub — its
 * answer is the login the read route reports.
 */
class FakeGitFacade {
    async getUser(): Promise<{ login: string; email?: string; avatarUrl?: string }> {
        return { login: LANE_LOGIN, email: `${LANE_LOGIN}@test.local` };
    }

    getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }> {
        return [{ id: 'github', name: 'GitHub', enabled: true }];
    }

    isConfigured(): boolean {
        return true;
    }

    async hasValidCredentials(): Promise<boolean> {
        // No OAuth row, no PAT: the read must succeed **because of the row this
        // route wrote**, never because the facade claims credentials anyway.
        return false;
    }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

describe('APW-13 T63 — POST /api/e2e/github-connection/seed', () => {
    const envBackup = { ...process.env };

    let dataSource: DataSource;
    let app: INestApplication;
    let accounts: AuthAccountRepository;
    let gitProvider: GitProviderService;

    const guardsOf = (controller: object): unknown[] =>
        (Reflect.getMetadata('__guards__', controller) ?? []) as unknown[];

    /** The controllers `GitProviderModule` actually declares. */
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
        // The fixture writes a row for a person who exists in the real product
        // but not in this database; FK enforcement would refuse it, and it is not
        // what this spec is about (T6's harness does the same).
        await dataSource.query('PRAGMA foreign_keys = OFF');

        accounts = new AuthAccountRepository(dataSource.getRepository(AuthAccount));
        gitProvider = new GitProviderService(
            new FakeGitFacade() as unknown as GitFacadeService,
            accounts,
        );

        const moduleRef = await Test.createTestingModule({
            controllers: [E2eGitHubConnectionSeedController],
            providers: [
                { provide: AuthAccountRepository, useValue: accounts },
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
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
        await dataSource?.destroy();
        process.env = { ...envBackup };
    });

    beforeEach(async () => {
        process.env = { ...envBackup };
        armSeedGate();
        await dataSource.query('DELETE FROM "account"');
    });

    const suite = () => request(app.getHttpServer());

    /** The lane's own body: the fake's token, login and scope list. */
    function laneBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
        return { accessToken: LANE_TOKEN, username: LANE_LOGIN, ...extra };
    }

    interface CallOptions {
        /** Send a session (default true). `false` = signed out. */
        session?: boolean;
        /** Act as another run account (`x-test-user`). */
        asUser?: string;
    }

    function seed(body: unknown = laneBody(), options: CallOptions = {}) {
        const call = suite()
            .post('/api/e2e/github-connection/seed')
            .send(body as object);
        if (options.session !== false) {
            call.set('authorization', 'Bearer test-session');
        }
        if (options.asUser) {
            call.set('x-test-user', options.asUser);
        }
        return call;
    }

    async function accountRows(): Promise<AuthAccount[]> {
        return dataSource.getRepository(AuthAccount).find({ order: { userId: 'ASC' } });
    }

    // -----------------------------------------------------------------------
    // The gate (plan §8.8 surface (b), R-40) — 404, never 403, before the handler
    // -----------------------------------------------------------------------

    describe('the two-variable gate', () => {
        it('answers 404 with NODE_ENV=production even when both fake variables are set', async () => {
            process.env.NODE_ENV = 'production';
            process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
            process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;

            const response = await seed();

            expect(response.status).toBe(404);
            // 404, not 403: a production process must not confirm that a seeding
            // route exists on this host.
            expect(response.body.message).toBe('Cannot find route');
            // The gate ran before the handler: nothing was parsed, nothing written.
            expect(await accountRows()).toHaveLength(0);
        });

        it.each(['test', 'development', 'staging', ''])(
            'answers 404 with EVER_WORKS_E2E_FAKES unset in NODE_ENV=%p',
            async (nodeEnv) => {
                process.env.NODE_ENV = nodeEnv;
                delete process.env[E2E_CONNECTION_SEED_FAKES_ENV];
                process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;

                const response = await seed();

                expect(response.status).toBe(404);
                expect(await accountRows()).toHaveLength(0);
            },
        );

        it.each(['true', 'TRUE', 'yes', '0', 'false', '', '1 '])(
            'treats %p as OFF — only the exact string "1" arms the route',
            async (value) => {
                process.env.NODE_ENV = 'test';
                process.env[E2E_CONNECTION_SEED_FAKES_ENV] = value;
                process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;

                const response = await seed();

                expect(response.status).toBe(404);
                expect(await accountRows()).toHaveLength(0);
            },
        );

        it.each([undefined, '', '   ', '///'])(
            'answers 404 when the fake origin is %p, even with EVER_WORKS_E2E_FAKES=1',
            async (value) => {
                process.env.NODE_ENV = 'test';
                process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
                if (value === undefined) {
                    delete process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV];
                } else {
                    process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = value;
                }

                const response = await seed();

                // The plugin would still be pointed at the REAL api.github.com
                // with only the switch set, so a row seeded then would be a live
                // credential aimed at the real service. Refused.
                expect(response.status).toBe(404);
                expect(await accountRows()).toHaveLength(0);
            },
        );

        it('answers 404 — not 400 — for a malformed body while the gate is closed', async () => {
            process.env.NODE_ENV = 'production';
            process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
            process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;

            const response = await seed({ nonsense: true });

            expect(response.status).toBe(404);
            expect(await accountRows()).toHaveLength(0);
        });

        it('reads production FIRST, before either variable is consulted', () => {
            process.env.NODE_ENV = 'production';
            process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
            process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;
            expect(isE2eGitHubConnectionSeedEnabled()).toBe(false);

            process.env.NODE_ENV = 'test';
            expect(isE2eGitHubConnectionSeedEnabled()).toBe(true);

            delete process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV];
            expect(isE2eGitHubConnectionSeedEnabled()).toBe(false);

            process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = `${FAKE_ORIGIN}/`;
            expect(isE2eGitHubConnectionSeedEnabled()).toBe(true);

            delete process.env[E2E_CONNECTION_SEED_FAKES_ENV];
            expect(isE2eGitHubConnectionSeedEnabled()).toBe(false);
        });

        it('keeps the gate on the controller and keeps the route private', () => {
            expect(guardsOf(E2eGitHubConnectionSeedController)).toEqual([
                E2eConnectionSeedEnabledGuard,
            ]);
            // Session-authenticated, never public: it writes a credential row.
            expect(
                Reflect.getMetadata(IS_PUBLIC_KEY, E2eGitHubConnectionSeedController),
            ).toBeFalsy();
        });
    });

    // -----------------------------------------------------------------------
    // The session
    // -----------------------------------------------------------------------

    describe('the session', () => {
        it('refuses a request without a session and writes no row', async () => {
            const response = await seed(laneBody(), { session: false });

            expect(response.status).toBe(401);
            expect(await accountRows()).toHaveLength(0);
        });

        it('refuses in the handler too, so a harness without the global guard cannot write a connection for nobody', async () => {
            const controller = new E2eGitHubConnectionSeedController(accounts);

            await expect(
                controller.seed(
                    undefined as unknown as Parameters<typeof controller.seed>[0],
                    laneBody() as unknown as E2eGitHubConnectionSeedDto,
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(await accountRows()).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // What a successful seed writes
    // -----------------------------------------------------------------------

    describe('the row it writes', () => {
        it('writes the connection for the SESSION person and answers 201', async () => {
            const response = await seed();

            expect(response.status).toBe(201);
            const body = response.body as E2eGitHubConnectionSeedResponse;
            expect(body).toMatchObject({
                userId: TEST_USER_ID,
                providerId: 'plugin:github',
                accountId: `${TEST_USER_ID}:plugin:github`,
                username: LANE_LOGIN,
                scope: E2E_CONNECTION_SEED_DEFAULT_SCOPE,
                connected: true,
                authMethod: 'oauth',
            });

            const rows = await accountRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                userId: TEST_USER_ID,
                providerId: 'plugin:github',
                accountId: `${TEST_USER_ID}:plugin:github`,
                accessToken: LANE_TOKEN,
                tokenType: 'Bearer',
                scope: E2E_CONNECTION_SEED_DEFAULT_SCOPE,
                username: LANE_LOGIN,
            });
            // No expiry: a lane runs for minutes and an expiry would turn a
            // passing run into a `connected: false` read part-way through.
            expect(rows[0].accessTokenExpiresAt ?? null).toBeNull();
        });

        it('never echoes the token', async () => {
            const response = await seed();

            expect(response.status).toBe(201);
            expect(JSON.stringify(response.body)).not.toContain(LANE_TOKEN);
        });

        it('gives two run accounts a row each, so the unique index cannot refuse the second', async () => {
            const first = await seed();
            const second = await seed(laneBody(), { asUser: OTHER_USER_ID });

            expect(first.status).toBe(201);
            expect(second.status).toBe(201);

            const rows = await accountRows();
            expect(rows.map((row) => row.userId)).toEqual([TEST_USER_ID, OTHER_USER_ID].sort());
            // The same fake identity, two rows: `accountId` is per person by
            // construction, which is what the (providerId, accountId) unique
            // index requires of a lane whose fake GitHub has one user.
            expect(new Set(rows.map((row) => row.accountId)).size).toBe(2);
            for (const row of rows) {
                expect(row.accountId).toBe(`${row.userId}:plugin:github`);
            }
        });

        it('is idempotent for one account: a second seed updates the row instead of conflicting', async () => {
            const first = await seed();
            const second = await seed(laneBody({ accessToken: 'apw-e2e-user-token-rotated' }));

            expect(first.status).toBe(201);
            expect(second.status).toBe(201);

            const rows = await accountRows();
            expect(rows).toHaveLength(1);
            expect(rows[0].accessToken).toBe('apw-e2e-user-token-rotated');
        });

        it('honours the scope it was given, and defaults to the scope the git facade requires', async () => {
            const explicit = await seed(laneBody({ scope: 'repo read:org workflow' }));
            expect(explicit.status).toBe(201);
            expect((explicit.body as E2eGitHubConnectionSeedResponse).scope).toBe(
                'repo read:org workflow',
            );

            await dataSource.query('DELETE FROM "account"');
            const defaulted = await seed(laneBody());
            expect((defaulted.body as E2eGitHubConnectionSeedResponse).scope).toBe(
                E2E_CONNECTION_SEED_DEFAULT_SCOPE,
            );
        });

        it('refuses a body outside the closed fixture shape with 400 and writes nothing', async () => {
            const bodies: Array<[string, Record<string, unknown>]> = [
                ['no token at all', { username: LANE_LOGIN }],
                ['an empty token', laneBody({ accessToken: '' })],
                ['an unknown top-level field', laneBody({ accountId: 'somebody-else' })],
                ['a token past the cap', laneBody({ accessToken: 't'.repeat(513) })],
                ['a scope carrying a newline', laneBody({ scope: 'repo\nadmin:org' })],
                ['a scope carrying markup', laneBody({ scope: '<script>alert(1)</script>' })],
            ];

            for (const [label, body] of bodies) {
                const response = await seed(body);
                // The label travels with the status so a failure names the case.
                expect({ label, status: response.status }).toEqual({ label, status: 400 });
            }
            expect(await accountRows()).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // The state the surface claims — read back through the platform's own path
    // -----------------------------------------------------------------------

    describe('the state the route claims (FR-56)', () => {
        it('reports the seeded row as connected by oauth, on the platform’s own read path', async () => {
            expect((await seed()).status).toBe(201);

            const connection = await gitProvider.checkConnection(TEST_USER_ID, 'github');

            expect(connection).toMatchObject({
                id: 'github',
                connected: true,
                authMethod: 'oauth',
                username: LANE_LOGIN,
            });
        });

        it('leaves every other person unconnected', async () => {
            expect((await seed()).status).toBe(201);

            const other = await gitProvider.checkConnection(OTHER_USER_ID, 'github');

            expect(other.connected).toBe(false);
            expect(other.authMethod).toBeUndefined();
        });

        it('satisfies the git facade’s required-scope lookup, which is what a fork needs', async () => {
            expect((await seed()).status).toBe(201);

            const usable = await accounts.findConnectedProviderAccount(TEST_USER_ID, 'github', {
                usePluginProviderId: true,
                requiredScopes: ['repo'],
            });

            expect(usable?.accessToken).toBe(LANE_TOKEN);
        });

        it('reports the other run account once IT has seeded its own row', async () => {
            expect((await seed()).status).toBe(201);
            expect((await seed(laneBody(), { asUser: OTHER_USER_ID })).status).toBe(201);

            const mine = await gitProvider.checkConnection(TEST_USER_ID, 'github');
            const theirs = await gitProvider.checkConnection(OTHER_USER_ID, 'github');

            expect(mine.connected).toBe(true);
            expect(theirs.connected).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Module registration (plan §8.8: "the route cannot exist in production by
    // construction" — a production process has no such path in its router)
    // -----------------------------------------------------------------------

    describe('module registration', () => {
        it('adds the seed controller only when the gate is open at boot — and never in production', () => {
            const load = (): string[] => {
                let names: string[] = [];
                jest.isolateModules(() => {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const loaded = require('./git-provider.module') as {
                        GitProviderModule: object;
                    };
                    names = controllerNames(loaded.GitProviderModule);
                });
                return names;
            };

            process.env.NODE_ENV = 'test';
            delete process.env[E2E_CONNECTION_SEED_FAKES_ENV];
            delete process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV];
            expect(load()).toEqual(['GitProviderController']);

            process.env[E2E_CONNECTION_SEED_FAKES_ENV] = '1';
            // The switch alone is not enough: without the fake origin the plugin
            // would still be pointed at the real GitHub.
            expect(load()).toEqual(['GitProviderController']);

            process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV] = FAKE_ORIGIN;
            expect(load()).toEqual(['GitProviderController', 'E2eGitHubConnectionSeedController']);

            // The variables are still set — production is what closes the door.
            process.env.NODE_ENV = 'production';
            expect(load()).toEqual(['GitProviderController']);
        });
    });
});
