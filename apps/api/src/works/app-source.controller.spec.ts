// Importing the REAL `WorksController` — the route-shadowing assertion below reads
// its declared route table — must not pull the agent's NestJS DI graph into this
// suite. The shield is `works.controller.crud.spec.ts`'s, verbatim, so the two
// specs load the controller the same way.
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/template-catalog', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({
    getDefaultWebsiteTemplateId: jest.fn(() => 'default-template'),
}));
jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WORK_UPDATED: 'WORK_UPDATED',
        WEBSITE_SETTINGS_UPDATED: 'WEBSITE_SETTINGS_UPDATED',
        WORK_DELETED: 'WORK_DELETED',
        SETTINGS_UPDATED: 'SETTINGS_UPDATED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
    WorkScheduleStatus: { ACTIVE: 'ACTIVE' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
// The auth barrel is stubbed — it pulls `better-auth`, an ESM package jest cannot
// parse, which is why every controller spec in this app does the same. Unlike the
// other specs, `CurrentUser` is **rebuilt** here instead of stubbed to
// `() => undefined`: this suite drives the route through a real router, so the
// parameter decorator has to read `request.user` the way `AuthSessionGuard` seeds
// it in production. The two class tokens are stubs on purpose — the suite provides
// `AuthService` itself and overrides `AuthSessionGuard` with a session stand-in.
jest.mock('../auth', () => {
    const { createParamDecorator } = jest.requireActual('@nestjs/common');
    class AuthService {}
    class AuthSessionGuard {}
    return {
        AuthService,
        AuthSessionGuard,
        CurrentUser: createParamDecorator(
            (
                _data: unknown,
                ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } },
            ) => ctx.switchToHttp().getRequest().user,
        ),
    };
});

import 'reflect-metadata';
import {
    GUARDS_METADATA,
    HTTP_CODE_METADATA,
    METHOD_METADATA,
    PATH_METADATA,
} from '@nestjs/common/constants';
import { type INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import * as request from 'supertest';
import { APP_INSPECT_MAX_PROVIDER_CALLS } from '@ever-works/contracts';
import { AppSourceInspectorService } from '@ever-works/agent/app-works';
import { AuthService, AuthSessionGuard } from '../auth';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { AppSourceController } from './app-source.controller';
import { AppSourceInspectResponseDto } from './dto/app-source-inspect.dto';
import { WorksController } from './works.controller';

/**
 * APW-01 T17 — `POST /api/works/app-source/inspect` (plan §4.1, `plan.md:465-490`).
 *
 * ACC-01-06 (inspect writes nothing), ACC-01-07 (each refusal code), ACC-01-13 (the
 * instance setting refuses every client), ACC-01-26 (the call budget and an unscanned
 * owner) — the server half of ACC-01-13 is asserted HERE, with the route carrying a
 * different `User-Agent` / client header per case, because that half is only
 * observable at the API (APW-01 tasks.md T28 records why the Playwright lane cannot
 * flip the setting).
 *
 * ## Why a real HTTP stack, and what is real behind it
 *
 * Everything this task owns is a property of the **route**: the path and its depth
 * (so no `works/:id/...` handler can shadow it), the `200` for a provider-side
 * refusal, the `400` for our own validation, the throttle metadata, and the fact
 * that the setting check happens before the URL is parsed *whatever client* is
 * asking. A hand-built controller instance asserts none of the status codes and none
 * of the routing, so the suite builds a Nest application and drives it with
 * supertest.
 *
 * Behind the route is the **real** `AppSourceInspectorService` (T12), constructed by
 * hand with a fake git facade — the same shape that service's own spec uses. That is
 * deliberate: this suite must fail if the route stops delegating to the inspector
 * (the decision chain is T12's to prove), and it must not re-implement any of the
 * inspector's rules. `APP_INSPECT_MAX_PROVIDER_CALLS` is imported rather than
 * restated for the same reason, and is used here only to assert that the budget the
 * route spends stays inside the ceiling.
 *
 * The session is a stand-in for `AuthSessionGuard` (which reads `request.user`, the
 * value `@CurrentUser()` returns); `AuthService.getUser` is a double, because the
 * row it would load is not what this route is about.
 */

const SESSION_USER_ID = 'auth-session-1';
const DB_USER_ID = 'user-row-1';
const URL = 'https://github.com/upstream/widgets';

// ---------------------------------------------------------------------------
// The fake git facade — a READ-only double, so "inspect writes nothing" is
// provable by the write half never being called (ACC-01-06)
// ---------------------------------------------------------------------------

/** A `GitRepositoryWithPermissions` with only the fields under test overridden. */
function repository(overrides: Record<string, unknown> = {}) {
    return {
        owner: 'upstream',
        name: 'widgets',
        fullName: 'upstream/widgets',
        defaultBranch: 'main',
        isPrivate: false,
        url: URL,
        cloneUrl: `${URL}.git`,
        visibility: 'public',
        stars: 12,
        sizeKb: 1_024,
        allowForking: true,
        archived: false,
        empty: false,
        isFork: false,
        licenseSpdx: 'MIT',
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
        ...overrides,
    };
}

interface Harness {
    inspector: AppSourceInspectorService;
    gitFacade: {
        getRepository: jest.Mock;
        getLatestCommit: jest.Mock;
        getUser: jest.Mock;
        getOrganizations: jest.Mock;
        getFileContent: jest.Mock;
        findExistingFork: jest.Mock;
    };
    /** The write half of the facade: present on the double and never called. */
    writes: Record<string, jest.Mock>;
    calls: () => number;
    authService: { getUser: jest.Mock };
    sessionGuard: { canActivate: jest.Mock };
}

function harness(input: {
    repository?: unknown;
    repositoryError?: unknown;
    organizations?: Array<{ id: string; login: string }>;
    existingForks?: Record<string, unknown | null>;
    userRow?: unknown;
}): Harness {
    const gitFacade = {
        getRepository: jest.fn(),
        getLatestCommit: jest.fn(),
        getUser: jest.fn(),
        getOrganizations: jest.fn(),
        getFileContent: jest.fn(),
        findExistingFork: jest.fn(),
    };

    const writes: Record<string, jest.Mock> = {
        forkRepository: jest.fn(),
        createRepository: jest.fn(),
        createRepositoryCopy: jest.fn(),
        createRepositoryFromTemplate: jest.fn(),
        updateRepository: jest.fn(),
        deleteRepository: jest.fn(),
        transferRepository: jest.fn(),
        commit: jest.fn(),
        push: jest.fn(),
        createPullRequest: jest.fn(),
        mergePullRequest: jest.fn(),
        setActionsPermissions: jest.fn(),
        createWebhook: jest.fn(),
        deleteWebhook: jest.fn(),
        createBranch: jest.fn(),
        updateBranchRef: jest.fn(),
        removeLocalDir: jest.fn(),
    };

    if (input.repositoryError) {
        gitFacade.getRepository.mockRejectedValue(input.repositoryError);
    } else {
        gitFacade.getRepository.mockResolvedValue(
            input.repository === undefined ? repository() : input.repository,
        );
    }
    gitFacade.getLatestCommit.mockResolvedValue({ sha: 'a'.repeat(40) });
    gitFacade.getUser.mockResolvedValue({ id: '1', login: 'member' });
    gitFacade.getOrganizations.mockResolvedValue(
        input.organizations ?? [
            { id: '2', login: 'acme' },
            { id: '3', login: 'beta' },
        ],
    );
    gitFacade.getFileContent.mockResolvedValue(null);
    gitFacade.findExistingFork.mockImplementation(
        async (_owner: string, _repo: string, targetOwner: string) =>
            input.existingForks?.[targetOwner] ?? null,
    );

    const workRepository = {
        findWorksUsingRepository: jest.fn().mockResolvedValue([]),
        findAppWorksByDataRepository: jest.fn().mockResolvedValue([]),
    };

    const inspector = new AppSourceInspectorService(
        { ...gitFacade, ...writes } as never,
        workRepository as never,
        // `APP_SOURCE_CATALOG_PORT`, `APPS_TIER_POLICY`, the registry and the
        // deploy facade are left out of this hand-built inspector: the Blueprint
        // answers `unavailable` and the managed target is closed, the documented
        // state of an installation that has none of them. (Since APW-03 T26,
        // `AppWorksModule` DOES bind the catalog port; with no platform GitHub
        // credential it answers the same `unavailable` / licence `unknown`, which is
        // why this spec's expectations do not depend on the difference.)
    );

    const authService = {
        getUser: jest.fn().mockResolvedValue(input.userRow ?? { id: DB_USER_ID }),
    };
    const sessionGuard = {
        canActivate: jest.fn((context: { switchToHttp: () => { getRequest: () => any } }) => {
            context.switchToHttp().getRequest().user = { userId: SESSION_USER_ID };
            return true;
        }),
    };

    return {
        inspector,
        gitFacade,
        writes,
        calls: () =>
            gitFacade.getRepository.mock.calls.length +
            gitFacade.getLatestCommit.mock.calls.length +
            gitFacade.getUser.mock.calls.length +
            gitFacade.getOrganizations.mock.calls.length +
            gitFacade.getFileContent.mock.calls.length +
            gitFacade.findExistingFork.mock.calls.length,
        authService,
        sessionGuard,
    };
}

// ---------------------------------------------------------------------------
// The route table — the declared patterns, as the decorators carry them
// ---------------------------------------------------------------------------

interface DeclaredRoute {
    handler: string;
    method: RequestMethod;
    path: string;
}

/**
 * Every route a controller class declares, read off the decorators the way Nest
 * itself reads them (`PATH_METADATA` / `METHOD_METADATA`), with the class-level
 * prefix applied. The class is never instantiated — this is the route TABLE, which
 * is exactly what "not routed to any `works/:id` handler" is about.
 */
function declaredRoutes(controller: { prototype: object }): DeclaredRoute[] {
    const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const prototype = controller.prototype as Record<string, unknown>;

    return Object.getOwnPropertyNames(prototype)
        .map((handler): DeclaredRoute | null => {
            const target = prototype[handler] as object;
            const method = Reflect.getMetadata(METHOD_METADATA, target) as
                | RequestMethod
                | undefined;
            const path = Reflect.getMetadata(PATH_METADATA, target) as string | undefined;
            if (method === undefined || path === undefined) {
                return null;
            }
            return { handler, method, path: `${prefix}/${path}`.replace(/\/+/g, '/') };
        })
        .filter((route): route is DeclaredRoute => route !== null);
}

/** Whether one declared pattern matches a concrete request path (Express' rules, narrowed). */
function patternMatches(pattern: string, requestPath: string): boolean {
    const patternSegments = pattern.split('/').filter(Boolean);
    const pathSegments = requestPath.split('/').filter(Boolean);
    if (patternSegments.length !== pathSegments.length) {
        return false;
    }
    return patternSegments.every(
        (segment, index) =>
            segment.startsWith(':') || segment === '*' || segment === pathSegments[index],
    );
}

describe('AppSourceController — POST /api/works/app-source/inspect (APW-01 T17)', () => {
    const originalFlag = process.env.EVER_WORKS_APP_WORKS_ENABLED;
    let app: INestApplication;
    let h: Harness;

    beforeEach(async () => {
        // The setting is ON by default here; the refusal cases switch it off
        // explicitly. `worksEnabled()` reads the environment at call time (R-6's
        // "togglable without a redeploy"), so this is the real switch.
        process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        h = harness({});

        const moduleRef = await Test.createTestingModule({
            controllers: [AppSourceController],
            providers: [
                { provide: AppSourceInspectorService, useValue: h.inspector },
                { provide: AuthService, useValue: h.authService },
            ],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue(h.sessionGuard)
            .compile();

        app = moduleRef.createNestApplication();
        // The platform's own pipe (`apps/api/src/main.ts:199-205`): `whitelist` +
        // `transform` + `forbidNonWhitelisted`.
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
        );
        await app.init();
    });

    afterEach(async () => {
        await app?.close();
        if (originalFlag === undefined) {
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        } else {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = originalFlag;
        }
    });

    const post = (body: unknown, headers: Record<string, string> = {}) => {
        let call = request(app.getHttpServer()).post('/api/works/app-source/inspect');
        for (const [name, value] of Object.entries(headers)) {
            call = call.set(name, value);
        }
        return call.send(body as object);
    };

    // -----------------------------------------------------------------------
    // The route itself (plan §4.1's first paragraph)
    // -----------------------------------------------------------------------

    describe('the route', () => {
        it('is a POST to api/works/app-source/inspect answering 200', () => {
            expect(Reflect.getMetadata(PATH_METADATA, AppSourceController)).toBe('api');
            expect(Reflect.getMetadata(PATH_METADATA, AppSourceController.prototype.inspect)).toBe(
                'works/app-source/inspect',
            );
            expect(
                Reflect.getMetadata(METHOD_METADATA, AppSourceController.prototype.inspect),
            ).toBe(RequestMethod.POST);
            // `@HttpCode(200)`: nothing is created, so a POST must not answer 201.
            expect(
                Reflect.getMetadata(HTTP_CODE_METADATA, AppSourceController.prototype.inspect),
            ).toBe(200);
        });

        it('is JWT-guarded and is not @Public()', () => {
            expect(Reflect.getMetadata(GUARDS_METADATA, AppSourceController)).toContain(
                AuthSessionGuard,
            );
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppSourceController)).toBeUndefined();
            expect(
                Reflect.getMetadata(IS_PUBLIC_KEY, AppSourceController.prototype.inspect),
            ).toBeUndefined();
        });

        it('throttles the route at 30 per minute', () => {
            const handler = AppSourceController.prototype.inspect as unknown as object;
            expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, handler)).toBe(30);
            expect(Reflect.getMetadata(`${THROTTLER_TTL}long`, handler)).toBe(60_000);
        });

        it('documents the route and its typed 200 in OpenAPI', () => {
            const handler = AppSourceController.prototype.inspect as unknown as object;
            const operation = Reflect.getMetadata('swagger/apiOperation', handler) as
                | { summary?: string; description?: string }
                | undefined;
            const responses = Reflect.getMetadata('swagger/apiResponse', handler) as Record<
                string,
                { type?: unknown; description?: string }
            >;

            expect(operation?.summary).toBeTruthy();
            expect(operation?.description).toContain('writes nothing');
            expect(responses['200']?.type).toBe(AppSourceInspectResponseDto);
            expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '429', '503']);
        });

        it('is not shadowed by any works/:id handler', () => {
            const requestPath = 'api/works/app-source/inspect';

            // Positive control first: the matcher really does match the route this
            // task declares, so "nothing collides" below cannot be vacuous.
            const ours = declaredRoutes(AppSourceController).filter((route) =>
                patternMatches(route.path, requestPath),
            );
            expect(ours).toEqual([
                {
                    handler: 'inspect',
                    method: RequestMethod.POST,
                    path: 'api/works/app-source/inspect',
                },
            ]);

            // Then the real WorksController's own route table — the one that could
            // swallow a static segment behind `works/:id/...`.
            const collisions = declaredRoutes(WorksController).filter((route) =>
                patternMatches(route.path, requestPath),
            );
            expect(collisions).toEqual([]);
            // And the table is not empty, so the assertion above is not vacuous either.
            expect(declaredRoutes(WorksController).length).toBeGreaterThan(30);
        });

        it('answers 200 with the whole inspection for a reachable public repository', async () => {
            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.repository).toMatchObject({
                owner: 'upstream',
                repo: 'widgets',
                fullName: 'upstream/widgets',
                url: URL,
                defaultBranch: 'main',
                visibility: 'public',
                isFork: false,
            });
            // The caller cannot push: Link is refused with its reason and Fork is
            // the pre-selected mode (FR-17, FR-18).
            expect(response.body.access).toEqual({ canPush: false, canAdmin: false });
            expect(response.body.modes).toEqual({
                link: { available: false, reason: 'no_push_access' },
                fork: { available: true },
                'private-copy': { available: true },
            });
            expect(response.body.defaultMode).toBe('fork');
            // The unbound catalog port answers `unavailable`, never "no match"
            // (T11's documented path) — and the route must not invent a placeholder.
            expect(response.body.blueprint).toEqual({ status: 'unavailable' });
            // `unknown` is the CONTRACT's answer here, not a gap: the SPDX id is
            // detected, but classifying it is the catalog's job (R-3), and an
            // installation without the port must not guess a licence class.
            expect(response.body.license).toEqual({
                spdx: 'MIT',
                class: 'unknown',
                source: 'detected',
            });
            // The unbound tier policy leaves the managed target closed (R-5).
            expect(response.body.deployTargets).toEqual({
                none: { available: true },
                'your-cluster': { available: false, reason: 'cluster_target_unavailable' },
                'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
            });
            expect(response.body.targetOwners).toEqual([
                { login: 'member', type: 'user', available: true, existingForkChecked: true },
                { login: 'acme', type: 'organization', available: true, existingForkChecked: true },
                { login: 'beta', type: 'organization', available: true, existingForkChecked: true },
            ]);
            expect(response.body.scanIncomplete).toBe(false);
            expect(response.body.existingAppWork).toBeUndefined();
        });

        it('resolves the session to the user row and scopes every provider read to it', async () => {
            await post({ repositoryUrl: URL });

            expect(h.authService.getUser).toHaveBeenCalledWith(SESSION_USER_ID);
            expect(h.gitFacade.getRepository).toHaveBeenCalledWith('upstream', 'widgets', {
                userId: DB_USER_ID,
                providerId: 'github',
            });
        });

        it('writes nothing (ACC-01-06)', async () => {
            await post({ repositoryUrl: URL });

            for (const [name, spy] of Object.entries(h.writes)) {
                expect([name, spy.mock.calls.length]).toEqual([name, 0]);
            }
        });

        it('stays inside the provider-call budget', async () => {
            await post({ repositoryUrl: URL });

            expect(h.calls()).toBeLessThanOrEqual(APP_INSPECT_MAX_PROVIDER_CALLS);
        });
    });

    // -----------------------------------------------------------------------
    // The instance setting — R-6, ACC-01-13's server half
    // -----------------------------------------------------------------------

    describe('the instance setting (R-6, ACC-01-13)', () => {
        beforeEach(() => {
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        });

        /**
         * Every client the route has: the browser, the web app's own server action,
         * the MCP server, the command-line client — and a request with no client
         * headers at all. The refusal must be the same object for all of them, and
         * must not depend on what the caller claims to be.
         */
        const CLIENTS: Array<[string, Record<string, string>]> = [
            ['a browser', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }],
            ['the web server action', { 'User-Agent': 'node', 'x-ever-works-client': 'web' }],
            ['the MCP server', { 'User-Agent': 'ever-works-mcp/1.0', 'x-client': 'mcp' }],
            ['the command line', { 'User-Agent': 'curl/8.4.0', 'x-client': 'cli' }],
            ['no client headers at all', {}],
        ];

        it.each(CLIENTS)('refuses 400 app_works_disabled for %s', async (_client, headers) => {
            const response = await post({ repositoryUrl: URL }, headers);

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                status: 'error',
                code: 'app_works_disabled',
                message: 'Creating App Works is turned off on this installation.',
            });
            // Refused before the first provider call, whatever the client.
            expect(h.calls()).toBe(0);
            expect(h.authService.getUser).toHaveBeenCalledTimes(1);
        });

        it('refuses the setting before the URL is parsed, so a bad URL is not misreported', async () => {
            const response = await post({ repositoryUrl: 'not a repository url' });

            expect(response.status).toBe(400);
            expect(response.body.code).toBe('app_works_disabled');
        });
    });

    // -----------------------------------------------------------------------
    // Our own validation — the 4xx half of plan §4.1's table
    // -----------------------------------------------------------------------

    describe('our own validation answers 400 with the plan’s code', () => {
        it('answers invalid_url for a URL the parser refuses', async () => {
            for (const bad of [
                'not a url',
                'https://gitlab.com/owner/repo',
                'https://github.com/only-owner',
            ]) {
                const response = await post({ repositoryUrl: bad });

                expect(response.status).toBe(400);
                expect(response.body).toMatchObject({ status: 'error', code: 'invalid_url' });
            }
            expect(h.calls()).toBe(0);
        });

        it('answers invalid_url when gitProvider disagrees with the URL’s host', async () => {
            const response = await post({ repositoryUrl: URL, gitProvider: 'gitlab' });

            expect(response.status).toBe(400);
            expect(response.body).toMatchObject({ status: 'error', code: 'invalid_url' });
            expect(response.body.message).toContain('github');
            expect(h.calls()).toBe(0);
        });

        it('accepts a gitProvider that agrees with the URL', async () => {
            const response = await post({ repositoryUrl: URL, gitProvider: 'github' });

            expect(response.status).toBe(200);
        });

        it.each([
            { name: 'no repositoryUrl at all', body: {}, field: 'repositoryUrl' },
            {
                name: 'a repositoryUrl over the parser’s 400-character limit',
                body: { repositoryUrl: `https://github.com/a/${'b'.repeat(400)}` },
                field: 'repositoryUrl',
            },
            {
                name: 'a blueprintId outside the catalog id shape',
                body: { repositoryUrl: URL, blueprintId: 'Not A Catalog Id' },
                field: 'blueprintId',
            },
            { name: 'an unknown field', body: { repositoryUrl: URL, mode: 'fork' }, field: 'mode' },
        ])('refuses $name with a 400 naming the field', async ({ body, field }) => {
            const response = await post(body);

            expect(response.status).toBe(400);
            expect(JSON.stringify(response.body.message)).toContain(field);
            expect(h.calls()).toBe(0);
        });

        it('trims repositoryUrl before the parser sees it', async () => {
            const response = await post({ repositoryUrl: `  ${URL}  ` });

            expect(response.status).toBe(200);
            expect(h.gitFacade.getRepository).toHaveBeenCalledWith('upstream', 'widgets', {
                userId: DB_USER_ID,
                providerId: 'github',
            });
        });
    });

    // -----------------------------------------------------------------------
    // Provider-side refusals answer 200 with the reasons — plan §4.1's point
    // -----------------------------------------------------------------------

    describe('provider-side refusals answer 200 with reasons', () => {
        it('answers 200 not_found when the repository cannot be read', async () => {
            h.gitFacade.getRepository.mockResolvedValue(null);

            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.modes).toEqual({
                link: { available: false, reason: 'not_found' },
                fork: { available: false, reason: 'not_found' },
                'private-copy': { available: false, reason: 'not_found' },
            });
            expect(response.body.defaultMode).toBeNull();
            expect(response.body.scanIncomplete).toBe(true);
        });

        it.each([
            ['permission_missing', 403, 'insufficient_scope'],
            ['sso_authorization_required', 403, 'sso_authorization_required'],
            ['oauth_app_restricted', 403, 'oauth_app_restricted'],
            ['unauthorized', 401, 'provider_not_connected'],
        ])('answers 200 %s → %s', async (reason, status, expected) => {
            h.gitFacade.getRepository.mockRejectedValue({ reason, status, details: {} });

            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.modes.link).toEqual({ available: false, reason: expected });
            expect(response.body.modes.fork).toEqual({ available: false, reason: expected });
            expect(response.body.modes['private-copy']).toEqual({
                available: false,
                reason: expected,
            });
        });

        it('answers 200 rate_limited with retryAfter', async () => {
            h.gitFacade.getRepository.mockRejectedValue({
                reason: 'rate_limited',
                status: 403,
                details: { retryAt: '2026-09-18T12:00:00.000Z' },
            });

            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.modes.link).toEqual({ available: false, reason: 'rate_limited' });
            expect(response.body.retryAfter).toBe('2026-09-18T12:00:00.000Z');
        });

        it('answers 200 archived for a link into an archived repository', async () => {
            h.gitFacade.getRepository.mockResolvedValue(
                repository({
                    archived: true,
                    permissions: {
                        admin: true,
                        maintain: true,
                        push: true,
                        triage: true,
                        pull: true,
                    },
                }),
            );

            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.modes.link).toEqual({ available: false, reason: 'archived' });
        });

        it('answers 200 with an existing fork for the caller’s own account', async () => {
            h.gitFacade.findExistingFork.mockResolvedValue({
                owner: 'member',
                name: 'widgets',
                fullName: 'member/widgets',
                url: 'https://github.com/member/widgets',
            });

            const response = await post({ repositoryUrl: URL });

            expect(response.status).toBe(200);
            expect(response.body.targetOwners[0]).toMatchObject({
                login: 'member',
                existingForkChecked: true,
                existingFork: {
                    owner: 'member',
                    repo: 'widgets',
                    fullName: 'member/widgets',
                    url: 'https://github.com/member/widgets',
                    inUseByAnotherAccount: false,
                },
            });
        });

        it('answers 200 with the caller’s own existing App Work', async () => {
            const workRepository = {
                findWorksUsingRepository: jest.fn().mockResolvedValue([]),
                findAppWorksByDataRepository: jest
                    .fn()
                    .mockResolvedValue([{ id: 'w-1', name: 'Widgets', slug: 'widgets' }]),
            };
            const scoped = new AppSourceInspectorService(
                { ...h.gitFacade } as never,
                workRepository as never,
            );
            const moduleRef = await Test.createTestingModule({
                controllers: [AppSourceController],
                providers: [
                    { provide: AppSourceInspectorService, useValue: scoped },
                    { provide: AuthService, useValue: h.authService },
                ],
            })
                .overrideGuard(AuthSessionGuard)
                .useValue(h.sessionGuard)
                .compile();
            const scopedApp = moduleRef.createNestApplication();
            await scopedApp.init();

            try {
                const response = await request(scopedApp.getHttpServer())
                    .post('/api/works/app-source/inspect')
                    .send({ repositoryUrl: URL });

                expect(response.status).toBe(200);
                expect(response.body.existingAppWork).toEqual({
                    id: 'w-1',
                    name: 'Widgets',
                    slug: 'widgets',
                });
            } finally {
                await scopedApp.close();
            }
        });
    });
});
