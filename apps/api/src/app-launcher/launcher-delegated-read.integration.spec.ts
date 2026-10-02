import type { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ExternalIdentity, type User } from '@ever-works/agent/entities';
import { AppLauncherService } from '@ever-works/agent/app-launcher';
import type { AppLauncherListResponse } from '@ever-works/contracts';
import {
    createEverIdHarness,
    type EverIdHarness,
} from '../auth/__tests__/ever-id-harness.helper-spec';
import {
    DELEGATED_READ_ORIGINS,
    DELEGATED_READ_SCOPE,
} from '../auth/decorators/delegated-read.decorator';
import { EVER_ID_TRUSTED_CLIENT_IDS_ENV } from '../auth/ever-id-trusted-clients';
import { ScopeContextService } from '../scope/scope-context.service';
import { AppLauncherController } from './app-launcher.controller';
import {
    AppLauncherEnabledGuard,
    APP_LAUNCHER_ENABLED_ENV,
} from './guards/app-launcher-enabled.guard';
import {
    APP_LAUNCHER_ORIGINS_ENV,
    forgetLauncherDelegatedOrigins,
    launcherDelegatedOrigins,
    LauncherDelegatedCorsMiddleware,
    resolveLauncherOrigins,
} from './launcher-delegated-cors.middleware';
import { PlatformCatalogService } from './platform-catalog.service';

/**
 * The App Launcher read as another Ever app makes it: `GET /api/me/apps` from a browser page
 * on an allowed origin, with a delegated Ever ID access token (APW-11 FR-49, FR-50,
 * ACC-11-37, ACC-11-38; APW-12 FR-44..FR-47).
 *
 * Everything on the request path is real: the launcher controller, the global
 * `AuthSessionGuard` with its delegated branch, the delegation service and its token checks
 * against the `oidc-identity` package's fake provider, the launcher's CORS middleware, the
 * session path and an in-memory database (`ever-id-harness.helper-spec.ts`). Only the
 * launcher's registry and catalog are stand-ins: what the list contains is their own specs'
 * business; whether a caller may read it at all is this one's.
 *
 * The origins are the ones the stage deployment allows: the platform portal on stage and on
 * dev (dev shares the stage identity tenant).
 */

const APP_STAGE = 'https://app-stage.ever.co';
const APP_DEV = 'https://app-dev.ever.co';
const UNLISTED = 'https://unlisted.example';
const TRUSTED_CLIENT = 'app-ever-co-test-client';

const LIST: AppLauncherListResponse = {
    items: [
        {
            key: 'platform:ever-works',
            kind: 'platform',
            section: 'platforms',
            name: 'Ever Works',
            url: 'https://works.example.com',
            host: 'works.example.com',
            current: true,
            status: 'available',
            visible: true,
            pinned: false,
            pinOrder: null,
            order: 0,
            manageState: 'listed',
        },
    ],
    meta: {
        environment: 'stage',
        catalogVersion: '0.2.0',
        catalogAvailable: true,
        scopeKey: 'personal',
        worksTotal: 0,
        total: 1,
        truncated: false,
        pinLimit: 6,
        appWorksAvailable: false,
    },
};

/** Saves and restores the variables a case sets, so no other suite sees them. */
const ENV_KEYS = [
    APP_LAUNCHER_ENABLED_ENV,
    APP_LAUNCHER_ORIGINS_ENV,
    EVER_ID_TRUSTED_CLIENT_IDS_ENV,
];

interface LauncherHarness {
    harness: EverIdHarness;
    listForUser: jest.Mock;
    server: () => ReturnType<INestApplication['getHttpServer']>;
}

async function bootLauncher(trustedClientIds: string | undefined): Promise<LauncherHarness> {
    process.env[APP_LAUNCHER_ENABLED_ENV] = 'true';
    process.env[APP_LAUNCHER_ORIGINS_ENV] = `${APP_STAGE},${APP_DEV}`;
    if (trustedClientIds === undefined) {
        delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
    } else {
        process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = trustedClientIds;
    }
    forgetLauncherDelegatedOrigins();

    const listForUser = jest.fn(async () => LIST);
    const harness = await createEverIdHarness({
        enabled: true,
        controllers: [AppLauncherController],
        providers: [
            { provide: AppLauncherService, useValue: { listForUser, savePreferences: jest.fn() } },
            {
                provide: PlatformCatalogService,
                useValue: {
                    read: async () => ({
                        platforms: [],
                        environment: 'stage',
                        catalogVersion: '0.2.0',
                        catalogAvailable: true,
                    }),
                },
            },
            { provide: ScopeContextService, useValue: { getScope: () => ({}) } },
            AppLauncherEnabledGuard,
        ],
        // The middleware exactly as AppLauncherModule applies it to the read route.
        configureApp: (app) => {
            const cors = new LauncherDelegatedCorsMiddleware(resolveLauncherOrigins());
            app.use('/api/me/apps', (req: any, res: any, next: (error?: unknown) => void) => {
                if (req.method === 'GET' || req.method === 'OPTIONS') {
                    cors.use(req, res, next);
                    return;
                }
                next();
            });
        },
    });
    return { harness, listForUser, server: () => harness.app.getHttpServer() };
}

/** A person with a connected Ever ID identity, the only kind a delegated token can read for. */
async function connectedPerson(
    harness: EverIdHarness,
    email: string,
    subject: string,
): Promise<User> {
    const user = await harness.createUser({ email });
    const repository = harness.dataSource.getRepository(ExternalIdentity);
    await repository.save(
        repository.create({
            userId: user.id,
            issuer: harness.fake!.issuer,
            subject,
            emailAtLink: email,
            emailVerifiedAtLink: true,
            linkedVia: 'settings',
            linkedAt: new Date(),
        }),
    );
    return user;
}

function delegatedReads(harness: EverIdHarness) {
    return harness.activityRows.filter((row) => row.action === 'auth.ever_id.delegated_read');
}

/** No response to a delegated call may set a cookie or admit credentials (APW-11 S22, FR-47). */
function expectNoCredentialsSurface(response: request.Response) {
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
}

jest.setTimeout(60_000);

describe('GET /api/me/apps — the delegated read from another Ever app', () => {
    const saved: Record<string, string | undefined> = {};

    beforeAll(() => {
        for (const key of ENV_KEYS) saved[key] = process.env[key];
    });

    afterAll(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        forgetLauncherDelegatedOrigins();
    });

    it('marks only the read for the delegated scope, with the launcher origins as its origin rule', () => {
        const read = AppLauncherController.prototype.list;
        const save = AppLauncherController.prototype.savePreferences;

        expect(Reflect.getMetadata(DELEGATED_READ_SCOPE, read)).toBe('apps:read');
        expect(Reflect.getMetadata(DELEGATED_READ_ORIGINS, read)).toBe(launcherDelegatedOrigins);
        expect(Reflect.getMetadata(DELEGATED_READ_SCOPE, save)).toBeUndefined();
        expect(Reflect.getMetadata(DELEGATED_READ_ORIGINS, save)).toBeUndefined();
    });

    describe('with the installation trusting one client', () => {
        let launcher: LauncherHarness;
        let person: User;

        beforeAll(async () => {
            launcher = await bootLauncher(TRUSTED_CLIENT);
            person = await connectedPerson(launcher.harness, 'ada@example.com', 'subject-ada');
        });
        afterAll(async () => launcher.harness.close());

        async function token(overrides: { scopes?: string[]; authorizedParty?: string } = {}) {
            return launcher.harness.fake!.mintAccessToken({
                subject: 'subject-ada',
                scopes: overrides.scopes ?? ['apps:read'],
                authorizedParty: overrides.authorizedParty ?? TRUSTED_CLIENT,
            });
        }

        it('delegated_from_app_stage_200: reads the list from the stage portal, cookie-free', async () => {
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', APP_STAGE)
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.body).toEqual(LIST);
            expect(response.headers['access-control-allow-origin']).toBe(APP_STAGE);
            expectNoCredentialsSurface(response);
            // The person is the token's subject, never a parameter.
            expect(launcher.listForUser).toHaveBeenLastCalledWith(
                { id: person.id },
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ includeHidden: false }),
            );
        });

        it('reads from the dev portal too, which shares the stage identity tenant', async () => {
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', APP_DEV)
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe(APP_DEV);
        });

        it('delegated_unlisted_origin_403: refuses another origin before the token is read', async () => {
            const bearer = await token();
            const providerCalls = launcher.harness.fake!.calls.length;
            const reads = delegatedReads(launcher.harness).length;
            const listCalls = launcher.listForUser.mock.calls.length;

            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', UNLISTED)
                .set('Authorization', `Bearer ${bearer}`);

            expect(response.status).toBe(403);
            expect(response.body).toEqual({
                status: 'error',
                code: 'origin_not_allowed',
                message: expect.any(String),
            });
            // The browser gets no CORS headers either, so it would not hand the page the body.
            expect(response.headers['access-control-allow-origin']).toBeUndefined();
            expectNoCredentialsSurface(response);
            // Refused before verification: no key fetch at the provider, no record of a read.
            expect(launcher.harness.fake!.calls.length).toBe(providerCalls);
            expect(delegatedReads(launcher.harness)).toHaveLength(reads);
            expect(launcher.listForUser.mock.calls.length).toBe(listCalls);
        });

        it('refuses a near-miss of an allowed origin the same way', async () => {
            for (const origin of [
                `${APP_STAGE}.attacker.example`,
                'http://app-stage.ever.co',
                'null',
            ]) {
                const response = await request(launcher.server())
                    .get('/api/me/apps')
                    .set('Origin', origin)
                    .set('Authorization', `Bearer ${await token()}`);
                expect({ origin, status: response.status, code: response.body.code }).toEqual({
                    origin,
                    status: 403,
                    code: 'origin_not_allowed',
                });
            }
        });

        it('delegated_missing_origin_403: refuses a delegated call that carries no Origin', async () => {
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Authorization', `Bearer ${await token()}`);

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('origin_not_allowed');
            expectNoCredentialsSurface(response);
        });

        it('unlisted_azp_401: refuses a token minted for a client the installation does not trust', async () => {
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', APP_STAGE)
                .set(
                    'Authorization',
                    `Bearer ${await token({ authorizedParty: 'some-other-client' })}`,
                );

            expect(response.status).toBe(401);
            // The plain 401 of an invalid credential (FR-46): nothing says why.
            expect(response.body.code).toBeUndefined();
            expectNoCredentialsSurface(response);
        });

        it('answers 403 insufficient_scope for a token without apps:read from an allowed origin', async () => {
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', APP_STAGE)
                .set('Authorization', `Bearer ${await token({ scopes: ['ever-works:session'] })}`);

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('insufficient_scope');
        });

        it('no_set_cookie_on_delegated: never writes, and the write route refuses the token (FR-49)', async () => {
            const response = await request(launcher.server())
                .put('/api/me/apps/preferences')
                .set('Origin', APP_STAGE)
                .set('Authorization', `Bearer ${await token()}`)
                .send({ changes: [{ key: 'platform:ever-works', pinned: true }] });

            expect(response.status).toBe(401);
            expectNoCredentialsSurface(response);
        });

        it('leaves the session read exactly as it was: no Origin needed, any Origin ignored', async () => {
            const session = await launcher.harness.sessionFor(person.id);
            for (const origin of [undefined, UNLISTED]) {
                const call = request(launcher.server())
                    .get('/api/me/apps')
                    .set('Authorization', `Bearer ${session}`);
                const response = await (origin ? call.set('Origin', origin) : call);
                expect({ origin, status: response.status }).toEqual({ origin, status: 200 });
            }
        });
    });

    describe('with no trusted clients configured (the default)', () => {
        let launcher: LauncherHarness;

        beforeAll(async () => {
            launcher = await bootLauncher(undefined);
            await connectedPerson(launcher.harness, 'grace@example.com', 'subject-grace');
        });
        afterAll(async () => launcher.harness.close());

        it('keeps today’s rule: a token for any client reads from an allowed origin', async () => {
            const bearer = await launcher.harness.fake!.mintAccessToken({
                subject: 'subject-grace',
                scopes: ['apps:read'],
                authorizedParty: 'some-other-client',
            });
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', APP_STAGE)
                .set('Authorization', `Bearer ${bearer}`);

            expect(response.status).toBe(200);
        });

        it('still refuses an unlisted origin', async () => {
            const bearer = await launcher.harness.fake!.mintAccessToken({
                subject: 'subject-grace',
                scopes: ['apps:read'],
            });
            const response = await request(launcher.server())
                .get('/api/me/apps')
                .set('Origin', UNLISTED)
                .set('Authorization', `Bearer ${bearer}`);

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('origin_not_allowed');
        });
    });
});
