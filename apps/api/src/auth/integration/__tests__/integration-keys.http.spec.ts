import 'reflect-metadata';
import {
    Controller,
    Get,
    INestApplication,
    MiddlewareConsumer,
    Module,
    NestModule,
    Post,
    Req,
    RequestMethod,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import * as request from 'supertest';
import {
    ApiKeyRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { FleetRunCredentialService } from '@ever-works/agent/fleet';
import { EVER_GAUZY_PRESET_SCOPES } from '@ever-works/contracts';
import { AuthSessionGuard } from '../../guards/auth-session.guard';
import { AUTH_PROVIDER } from '../../providers/auth-provider.constants';
import { ApiKeyService } from '../../services/api-key.service';
import {
    INTEGRATION_KEY_REVOKED_EVENT,
    IntegrationKeyService,
} from '../../services/integration-key.service';
import { ApiKeysController } from '../../controllers/api-keys.controller';
import { ScopeContextService } from '../../../scope/scope-context.service';
import { ScopeResolverMiddleware } from '../../../scope/scope-resolver.middleware';
import { SessionScopeGuard } from '../../../scope/session-scope.guard';
import { ScopeOwnershipGuard } from '../../../scope/scope-ownership.guard';
import { UserAwareThrottlerGuard } from '../../../config/user-aware-throttler.guard';
import { IntegrationWhoamiController } from '../../../integrations-api/v1/whoami.controller';
import { IntegrationPrincipalGuard } from '../integration-principal.guard';
import { IntegrationAuditInterceptor } from '../integration-audit.interceptor';
import { IntegrationForbiddenGuard } from '../integration-forbidden.guard';
import { RequireScopes } from '../integration.decorators';
import { writeAttribution } from '../integration-attribution';
import type { AuthenticatedUser } from '../../types/auth.types';
import {
    FakeApiKeyRepository,
    FakeOrganizationRepository,
    FakeTenantRepository,
    FakeUserRepository,
    fakeUser,
} from './integration-fakes.helper-spec';

/**
 * EW-P1-2 — integration keys through a real HTTP stack: the global
 * `AuthSessionGuard`, the scope middleware, `SessionScopeGuard`,
 * `IntegrationPrincipalGuard`, `ScopeOwnershipGuard`, the throttler, the
 * audit interceptor, the global validation pipe, and the real key
 * controllers and services. Only the repositories are in-memory.
 *
 * What only an HTTP-level run proves: the guard ORDER (a slug resolved by
 * middleware is visible to the pin check; act-as replaces the user before
 * the handler runs), the error envelope on guard refusals, and the 429.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const INACTIVE = '00000000-0000-4000-8000-000000000003';
const OUTSIDER = '00000000-0000-4000-8000-000000000004';

/** A stand-in for routes an integration may (or may not) reach. */
@Controller('api/probe')
class ProbeController {
    @Post('tasks')
    @RequireScopes('tasks:write')
    write(@Req() req: { user: AuthenticatedUser }) {
        const by = writeAttribution(req.user);
        return {
            id: 'probe-1',
            userId: req.user.userId,
            createdByType: by.type,
            createdById: by.id,
        };
    }

    @Get('tasks')
    @RequireScopes('tasks:read')
    read(@Req() req: { user: AuthenticatedUser }) {
        return { userId: req.user.userId, actAs: req.user.integration?.actAsUserId ?? null };
    }

    @Post('kb')
    @RequireScopes('kb:write')
    kb() {
        return { ok: true };
    }

    @Get('unscoped')
    unscoped() {
        return { ok: true };
    }
}

@Controller('api/probe-account')
@UseGuards(IntegrationForbiddenGuard)
@RequireScopes()
class ProbeAccountController {
    @Get()
    account() {
        return { ok: true };
    }
}

describe('Integration keys over HTTP (EW-P1-2)', () => {
    const envBackup = { ...process.env };
    let app: INestApplication;
    const keys = new FakeApiKeyRepository();
    let activityRows: Array<Record<string, any>>;
    let revokedEvents: unknown[];

    const users = new FakeUserRepository([
        fakeUser({ id: OWNER, slug: 'owner', tenantId: TENANT }),
        fakeUser({ id: MEMBER, slug: 'member', tenantId: TENANT }),
        fakeUser({ id: INACTIVE, slug: 'inactive', tenantId: TENANT, isActive: false }),
        fakeUser({ id: OUTSIDER, slug: 'outsider', tenantId: OTHER_TENANT }),
    ]);
    const organizations = new FakeOrganizationRepository([
        { id: ORG_A, tenantId: TENANT, slug: 'acme', displayName: 'Acme' },
        { id: ORG_B, tenantId: TENANT, slug: 'beta', displayName: 'Beta' },
        { id: ORG_FOREIGN, tenantId: OTHER_TENANT, slug: 'foreign', displayName: 'Foreign' },
    ]);
    const tenants = new FakeTenantRepository([
        { id: TENANT, ownerUserId: OWNER, slug: 'owner-ws' },
        { id: OTHER_TENANT, ownerUserId: OUTSIDER, slug: 'outsider-ws' },
    ]);

    /** Session bearer → user, the only thing the provider is asked for here. */
    const authProvider = {
        authenticate: jest.fn(async (headers: Headers) => {
            const auth = headers.get('authorization') ?? '';
            const match = /^Bearer session-(.+)$/.exec(auth);
            const user = match ? await users.findById(match[1]) : null;
            if (!user) return null;
            return {
                userId: user.id,
                email: user.email,
                username: user.username,
                provider: 'local',
                emailVerified: true,
                isActive: true,
                avatar: null,
                iat: 0,
                iss: 'ever-works',
                aud: 'ever-works',
            };
        }),
    };

    const activityLog = {
        log: jest.fn(async (row: Record<string, any>) => {
            activityRows.push(row);
            return row;
        }),
    };

    /** The app under test: real guards, interceptor, middleware and controllers; fake repositories. */
    @Module({
        // The platform's three named tiers, with limits no SESSION in this suite
        // can reach: CI runs the ~80 owner-session calls fast enough to trip the
        // real 50/s burst tier. Integration keys are throttled by their own tier
        // (`INTEGRATION_THROTTLE_*`, per key), which the 429 case below drives.
        imports: [
            ThrottlerModule.forRoot({
                throttlers: ['short', 'medium', 'long'].map((name) => ({
                    name,
                    ttl: 60_000,
                    limit: 1_000_000,
                })),
            }),
            EventEmitterModule.forRoot(),
        ],
        controllers: [
            ApiKeysController,
            IntegrationWhoamiController,
            ProbeController,
            ProbeAccountController,
        ],
        providers: [
            ScopeContextService,
            ScopeResolverMiddleware,
            ApiKeyService,
            IntegrationKeyService,
            IntegrationForbiddenGuard,
            { provide: ApiKeyRepository, useValue: keys },
            { provide: UserRepository, useValue: users },
            { provide: OrganizationRepository, useValue: organizations },
            { provide: TenantRepository, useValue: tenants },
            { provide: FleetRunCredentialService, useValue: { authenticate: jest.fn() } },
            { provide: ActivityLogService, useValue: activityLog },
            { provide: AUTH_PROVIDER, useValue: authProvider },
            { provide: APP_GUARD, useClass: AuthSessionGuard },
            { provide: APP_GUARD, useClass: SessionScopeGuard },
            { provide: APP_GUARD, useClass: IntegrationPrincipalGuard },
            { provide: APP_GUARD, useClass: ScopeOwnershipGuard },
            { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
            { provide: APP_INTERCEPTOR, useClass: IntegrationAuditInterceptor },
        ],
    })
    class IntegrationKeysTestAppModule implements NestModule {
        configure(consumer: MiddlewareConsumer) {
            consumer
                .apply(ScopeResolverMiddleware)
                .exclude({ path: 'api/auth/{*splat}', method: RequestMethod.ALL })
                .forRoutes({ path: 'api/{*splat}', method: RequestMethod.ALL });
        }
    }

    const session = (userId: string) => ({ Authorization: `Bearer session-${userId}` });

    async function createIntegrationKey(body: Record<string, unknown> = {}) {
        const res = await request(app.getHttpServer())
            .post('/api/auth/api-keys/integration')
            .set(session(OWNER))
            .send({
                name: 'Ever Gauzy — Acme',
                integrationKind: 'ever-gauzy',
                scopes: [...EVER_GAUZY_PRESET_SCOPES],
                organizationIds: [ORG_A],
                ...body,
            });
        expect(res.status).toBe(201);
        return res.body as { id: string; key: string; prefix: string };
    }

    beforeAll(async () => {
        process.env.INTEGRATION_THROTTLE_WRITES_PER_MIN = '1000';
        const moduleRef = await Test.createTestingModule({
            imports: [IntegrationKeysTestAppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        );
        await app.init();
        moduleRef.get(EventEmitter2).on(INTEGRATION_KEY_REVOKED_EVENT, (event: unknown) => {
            revokedEvents.push(event);
        });
    });

    beforeEach(() => {
        keys.rows = [];
        activityRows = [];
        revokedEvents = [];
    });

    afterAll(async () => {
        process.env = envBackup;
        await app?.close();
    });

    describe('creating integration keys', () => {
        it('the workspace owner creates an ew_int_ key, shown once, pinned and scoped', async () => {
            const created = await createIntegrationKey();
            expect(created.key).toMatch(/^ew_int_[0-9a-f]{64}$/);
            expect(created.prefix).toBe(created.key.slice(0, 12));
            const row = keys.rows[0];
            expect(row.kind).toBe('integration');
            expect(row.tenantId).toBe(TENANT);
            expect(row.organizationIds).toEqual([ORG_A]);
            expect(row.hashedKey).not.toContain(created.key);
            expect(activityRows.map((r) => r.actionType)).toContain('integration_key_created');

            const list = await request(app.getHttpServer())
                .get('/api/auth/api-keys/integration')
                .set(session(OWNER));
            expect(list.status).toBe(200);
            expect(list.body).toHaveLength(1);
            expect(list.body[0]).not.toHaveProperty('key');
            expect(list.body[0].organizations).toEqual([
                { id: ORG_A, slug: 'acme', displayName: 'Acme' },
            ]);

            // Integration keys never show among (or count against) personal keys.
            const personal = await request(app.getHttpServer())
                .get('/api/auth/api-keys')
                .set(session(OWNER));
            expect(personal.body).toEqual([]);
        });

        it('refuses a non-owner, a foreign org, an unknown scope and a non-grantable scope', async () => {
            const asMember = await request(app.getHttpServer())
                .post('/api/auth/api-keys/integration')
                .set(session(MEMBER))
                .send({ name: 'x', scopes: ['tasks:read'], organizationIds: [ORG_A] });
            expect(asMember.status).toBe(403);

            const foreign = await request(app.getHttpServer())
                .post('/api/auth/api-keys/integration')
                .set(session(OWNER))
                .send({ name: 'x', scopes: ['tasks:read'], organizationIds: [ORG_FOREIGN] });
            expect(foreign.status).toBe(400);

            for (const scope of ['tasks:delete', 'goals:activate', 'ideas:build']) {
                const res = await request(app.getHttpServer())
                    .post('/api/auth/api-keys/integration')
                    .set(session(OWNER))
                    .send({ name: 'x', scopes: [scope], organizationIds: [ORG_A] });
                expect(res.status).toBe(400);
            }

            const noPins = await request(app.getHttpServer())
                .post('/api/auth/api-keys/integration')
                .set(session(OWNER))
                .send({ name: 'x', scopes: ['tasks:read'], organizationIds: [] });
            expect(noPins.status).toBe(400);
            expect(keys.rows).toHaveLength(0);
        });

        it('caps a workspace at 20 active integration keys', async () => {
            for (let i = 0; i < 20; i++) await createIntegrationKey({ name: `k${i}` });
            const res = await request(app.getHttpServer())
                .post('/api/auth/api-keys/integration')
                .set(session(OWNER))
                .send({ name: 'one too many', scopes: ['tasks:read'], organizationIds: [ORG_A] });
            expect(res.status).toBe(400);
        });

        it('withdraws a key that an overlapping create pushed over the cap', async () => {
            for (let i = 0; i < 19; i++) await createIntegrationKey({ name: `k${i}` });
            // Simulate the race: the pre-insert count still reads 19 while a
            // concurrent create has already landed the 20th row.
            const realCount = keys.countActiveIntegrationKeysByTenant.bind(keys);
            let first = true;
            keys.countActiveIntegrationKeysByTenant = async (tenantId: string) => {
                if (first) {
                    first = false;
                    await keys.create({
                        userId: OWNER,
                        kind: 'integration',
                        tenantId: TENANT,
                        organizationIds: [ORG_A],
                        hashedKey: 'concurrent',
                    });
                    return 19;
                }
                return realCount(tenantId);
            };
            try {
                const res = await request(app.getHttpServer())
                    .post('/api/auth/api-keys/integration')
                    .set(session(OWNER))
                    .send({ name: 'raced', scopes: ['tasks:read'], organizationIds: [ORG_A] });
                expect(res.status).toBe(400);
                expect(res.body).not.toHaveProperty('key');
                expect(keys.rows.filter((r) => r.name === 'raced')).toHaveLength(0);
                expect(await realCount(TENANT)).toBe(20);
            } finally {
                keys.countActiveIntegrationKeysByTenant = realCount;
            }
        });

        it('closes the minting hole: no API key of any kind can create or rotate keys', async () => {
            const personal = await request(app.getHttpServer())
                .post('/api/auth/api-keys')
                .set(session(OWNER))
                .send({ name: 'personal' });
            expect(personal.status).toBe(201);
            const live = personal.body.key as string;

            const minted = await request(app.getHttpServer())
                .post('/api/auth/api-keys')
                .set('x-api-key', live)
                .send({ name: 'minted by a key' });
            expect(minted.status).toBe(403);

            const mintedIntegration = await request(app.getHttpServer())
                .post('/api/auth/api-keys/integration')
                .set('x-api-key', live)
                .send({ name: 'x', scopes: ['tasks:read'], organizationIds: [ORG_A] });
            expect(mintedIntegration.status).toBe(403);

            const rotated = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${personal.body.id}/rotate`)
                .set('x-api-key', live)
                .send({});
            expect(rotated.status).toBe(403);

            // Reading the owner's key list with a personal key still works.
            const list = await request(app.getHttpServer())
                .get('/api/auth/api-keys')
                .set('x-api-key', live);
            expect(list.status).toBe(200);
        });
    });

    describe('the integration principal', () => {
        it('whoami answers without an org header: tenant, pins, scopes, version, limits', async () => {
            const { key, id } = await createIntegrationKey({ organizationIds: [ORG_A, ORG_B] });
            const res = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('Authorization', `Bearer ${key}`);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                keyId: id,
                keyName: 'Ever Gauzy — Acme',
                integrationKind: 'ever-gauzy',
                tenant: { id: TENANT, slug: 'owner-ws' },
                apiVersion: '1',
                feedHead: '0',
                limits: { readsPerMin: 3000, writesPerMin: 1000 },
            });
            expect(res.body.organizations.map((o: { slug: string }) => o.slug)).toEqual([
                'acme',
                'beta',
            ]);
            expect(res.body.scopes).not.toContain('org:write');
            expect(res.body.scopes).toContain('tasks:write');
        });

        it('whoami needs no org header, but a supplied slug must still name a pin', async () => {
            const { key } = await createIntegrationKey();
            for (const slug of ['owner', 'beta']) {
                const res = await request(app.getHttpServer())
                    .get('/api/integrations/v1/whoami')
                    .set('x-api-key', key)
                    .set('X-Scope-Slug', slug);
                expect({ slug, status: res.status, code: res.body?.error?.code }).toEqual({
                    slug,
                    status: 403,
                    code: 'org_not_pinned',
                });
            }
            const pinned = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('x-api-key', key)
                .set('X-Scope-Slug', 'acme');
            expect(pinned.status).toBe(200);
        });

        it('whoami refuses a session (the integration API is for integration keys only)', async () => {
            const res = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set(session(OWNER));
            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('invalid_key');
        });

        it('an unknown or revoked key is 401 invalid_key in the integration envelope', async () => {
            const bogus = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('x-api-key', 'ew_int_' + '0'.repeat(64));
            expect(bogus.status).toBe(401);
            expect(bogus.body).toEqual({
                error: { code: 'invalid_key', message: expect.any(String) },
            });

            const { key, id } = await createIntegrationKey();
            const revoke = await request(app.getHttpServer())
                .delete(`/api/auth/api-keys/${id}`)
                .set(session(OWNER));
            expect(revoke.status).toBe(200);
            expect(keys.rows[0].isActive).toBe(false); // switched off, kept for audit
            expect(revokedEvents).toEqual([
                { keyId: id, tenantId: TENANT, revokedByUserId: OWNER },
            ]);

            // A retried revoke is idempotent: 200, and the row stays (audit trail),
            // with no second event or audit row.
            const again = await request(app.getHttpServer())
                .delete(`/api/auth/api-keys/${id}`)
                .set(session(OWNER));
            expect(again.status).toBe(200);
            expect(keys.rows).toHaveLength(1);
            expect(revokedEvents).toHaveLength(1);
            expect(
                activityRows.filter((r) => r.actionType === 'integration_key_revoked'),
            ).toHaveLength(1);
            const after = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('Authorization', `Bearer ${key}`);
            expect(after.status).toBe(401);
        });

        it('denies by default: a route without @RequireScopes answers 403 scope_missing', async () => {
            const { key } = await createIntegrationKey();
            const res = await request(app.getHttpServer())
                .get('/api/probe/unscoped')
                .set('x-api-key', key)
                .set('X-Scope-Slug', 'acme');
            expect(res.status).toBe(403);
            expect(res.body.error).toMatchObject({
                code: 'scope_missing',
                details: { reason: 'route_not_integration_enabled' },
            });
        });

        it('a scope the key does not hold is 403 scope_missing with the missing list', async () => {
            const { key } = await createIntegrationKey({ scopes: ['tasks:read'] });
            const res = await request(app.getHttpServer())
                .post('/api/probe/tasks')
                .set('x-api-key', key)
                .set('X-Scope-Slug', 'acme')
                .send({});
            expect(res.status).toBe(403);
            expect(res.body.error).toMatchObject({
                code: 'scope_missing',
                details: { missing: ['tasks:write'] },
            });
        });

        it('requires a pinned org: none, an unpinned one, a foreign one and conflicting headers are org_not_pinned', async () => {
            const { key } = await createIntegrationKey();
            const cases: Array<Record<string, string>> = [
                {},
                { 'X-Scope-Slug': 'beta' },
                { 'X-Scope-Slug': 'foreign' },
                { 'X-Organization-Id': ORG_B },
                { 'X-Organization-Id': 'not-a-uuid' },
                { 'X-Scope-Slug': 'acme', 'X-Organization-Id': ORG_B },
                { 'X-Scope-Slug': 'owner' }, // a personal (user) slug is no org
                // …nor next to a pinned X-Organization-Id (review: a supplied slug must be a pin).
                { 'X-Scope-Slug': 'owner', 'X-Organization-Id': ORG_A },
            ];
            for (const headers of cases) {
                const res = await request(app.getHttpServer())
                    .post('/api/probe/tasks')
                    .set('x-api-key', key)
                    .set(headers)
                    .send({});
                expect({ headers, status: res.status, code: res.body?.error?.code }).toEqual({
                    headers,
                    status: 403,
                    code: 'org_not_pinned',
                });
            }
        });

        it('accepts the pin by slug or by X-Organization-Id and writes as the owner, attributed to the integration', async () => {
            const { key, id } = await createIntegrationKey();
            for (const headers of [{ 'X-Scope-Slug': 'acme' }, { 'X-Organization-Id': ORG_A }]) {
                const res = await request(app.getHttpServer())
                    .post('/api/probe/tasks')
                    .set('Authorization', `Bearer ${key}`)
                    .set(headers)
                    .set('X-Sync-Origin', 'gauzy:conn-1')
                    .send({});
                expect(res.status).toBe(201);
                expect(res.body).toEqual({
                    id: 'probe-1',
                    userId: OWNER,
                    createdByType: 'integration',
                    createdById: id,
                });
            }
            // One audit row per write: actorKind external, labelled, scoped.
            const audits = activityRows.filter((r) => r.actionType === 'integration_write');
            expect(audits).toHaveLength(2);
            expect(audits[0]).toMatchObject({
                userId: OWNER,
                actorKind: 'external',
                actorLabel: 'Ever Gauzy (Ever Gauzy — Acme)',
                organizationId: ORG_A,
                tenantId: TENANT,
                details: {
                    integrationKeyId: id,
                    actAsUserId: null,
                    ownerUserId: OWNER,
                    method: 'POST',
                    route: '/api/probe/tasks',
                    originTag: 'gauzy:conn-1',
                    resourceId: 'probe-1',
                },
            });
        });

        it('X-Act-As-User makes a write the person’s own; the audit row names the act-as user', async () => {
            const { key } = await createIntegrationKey();
            const res = await request(app.getHttpServer())
                .post('/api/probe/tasks')
                .set('x-api-key', key)
                .set('X-Scope-Slug', 'acme')
                .set('X-Act-As-User', MEMBER)
                .send({});
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                userId: MEMBER,
                createdByType: 'user',
                createdById: MEMBER,
            });
            const audit = activityRows.find((r) => r.actionType === 'integration_write');
            expect(audit).toMatchObject({
                userId: MEMBER,
                details: { actAsUserId: MEMBER, ownerUserId: OWNER },
            });
        });

        it('refuses act-as for an inactive user, a user of another tenant, an unknown id and garbage', async () => {
            const { key } = await createIntegrationKey();
            for (const actAs of [
                INACTIVE,
                OUTSIDER,
                '00000000-0000-4000-8000-0000000000ff',
                'nobody',
            ]) {
                const res = await request(app.getHttpServer())
                    .post('/api/probe/tasks')
                    .set('x-api-key', key)
                    .set('X-Scope-Slug', 'acme')
                    .set('X-Act-As-User', actAs)
                    .send({});
                expect({ actAs, status: res.status, code: res.body?.error?.code }).toEqual({
                    actAs,
                    status: 403,
                    code: 'act_as_forbidden',
                });
            }
            expect(activityRows.filter((r) => r.actionType === 'integration_write')).toHaveLength(
                0,
            );
        });

        it('ignores X-Act-As-User on reads: act-as never widens what an integration reads', async () => {
            const { key } = await createIntegrationKey();
            const res = await request(app.getHttpServer())
                .get('/api/probe/tasks')
                .set('x-api-key', key)
                .set('X-Scope-Slug', 'acme')
                .set('X-Act-As-User', MEMBER);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ userId: OWNER, actAs: null });
            expect(activityRows.filter((r) => r.actionType === 'integration_write')).toHaveLength(
                0,
            ); // reads are not audited
        });

        it('IntegrationForbiddenGuard keeps integration keys off key-management and account routes', async () => {
            const { key, id } = await createIntegrationKey();
            // Built lazily: a supertest request starts listening when it is created.
            const attempts = [
                () => request(app.getHttpServer()).get('/api/auth/api-keys').set('x-api-key', key),
                () =>
                    request(app.getHttpServer())
                        .get('/api/auth/api-keys/integration')
                        .set('x-api-key', key),
                () =>
                    request(app.getHttpServer())
                        .post('/api/auth/api-keys/integration')
                        .set('x-api-key', key)
                        .send({ name: 'x', scopes: ['tasks:read'], organizationIds: [ORG_A] }),
                () =>
                    request(app.getHttpServer())
                        .post(`/api/auth/api-keys/${id}/rotate`)
                        .set('x-api-key', key)
                        .send({}),
                () =>
                    request(app.getHttpServer())
                        .delete(`/api/auth/api-keys/${id}`)
                        .set('x-api-key', key),
                // Even a controller that opted in with @RequireScopes() stays closed.
                () =>
                    request(app.getHttpServer())
                        .get('/api/probe-account')
                        .set('x-api-key', key)
                        .set('X-Scope-Slug', 'acme'),
            ];
            for (const attempt of attempts) {
                const res = await attempt();
                expect(res.status).toBe(403);
                expect(res.body.error.code).toBe('scope_missing');
            }
            expect(keys.rows.filter((r) => r.kind === 'integration')).toHaveLength(1);
            expect(keys.rows[0].isActive).toBe(true);
        });
    });

    describe('rotation', () => {
        it('rotates in place: same id, new secret, the old secret works until the grace period ends', async () => {
            const { key: oldKey, id } = await createIntegrationKey();
            const res = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${id}/rotate`)
                .set(session(OWNER))
                .send({ graceHours: 24 });
            expect(res.status).toBe(200);
            expect(res.body.id).toBe(id);
            expect(res.body.key).toMatch(/^ew_int_/);
            expect(res.body.key).not.toBe(oldKey);
            expect(activityRows.map((r) => r.actionType)).toContain('integration_key_rotated');

            for (const key of [oldKey, res.body.key]) {
                const who = await request(app.getHttpServer())
                    .get('/api/integrations/v1/whoami')
                    .set('x-api-key', key);
                expect(who.status).toBe(200);
                expect(who.body.keyId).toBe(id);
            }

            // Past the grace period only the new secret works.
            keys.rows[0].previousKeyGraceUntil = new Date(Date.now() - 1000);
            const stale = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('x-api-key', oldKey);
            expect(stale.status).toBe(401);
        });

        it('a failing rotation audit never hides the new secret', async () => {
            const { id } = await createIntegrationKey();
            const original = keys.findByIdAndUserId.bind(keys);
            let calls = 0;
            const spy = jest
                .spyOn(keys, 'findByIdAndUserId')
                .mockImplementation(async (...args) => {
                    calls += 1;
                    // 1st call: the rotation itself; 2nd: the audit lookup, which fails.
                    if (calls === 2) throw new Error('db hiccup');
                    return original(...args);
                });
            try {
                const res = await request(app.getHttpServer())
                    .post(`/api/auth/api-keys/${id}/rotate`)
                    .set(session(OWNER))
                    .send({ graceHours: 0 });
                expect(res.status).toBe(200);
                expect(res.body.key).toMatch(/^ew_int_/);
                const who = await request(app.getHttpServer())
                    .get('/api/integrations/v1/whoami')
                    .set('x-api-key', res.body.key);
                expect(who.status).toBe(200);
            } finally {
                spy.mockRestore();
            }
        });

        it('graceHours 0 retires the old secret immediately; out-of-range grace is a 400', async () => {
            const { key: oldKey, id } = await createIntegrationKey();
            const bad = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${id}/rotate`)
                .set(session(OWNER))
                .send({ graceHours: 1000 });
            expect(bad.status).toBe(400);
            const res = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${id}/rotate`)
                .set(session(OWNER))
                .send({ graceHours: 0 });
            expect(res.status).toBe(200);
            const old = await request(app.getHttpServer())
                .get('/api/integrations/v1/whoami')
                .set('x-api-key', oldKey);
            expect(old.status).toBe(401);
        });

        it('rotates a personal key too, and refuses another user’s key', async () => {
            const personal = await request(app.getHttpServer())
                .post('/api/auth/api-keys')
                .set(session(OWNER))
                .send({ name: 'personal' });
            const notMine = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${personal.body.id}/rotate`)
                .set(session(MEMBER))
                .send({});
            expect(notMine.status).toBe(404);
            const mine = await request(app.getHttpServer())
                .post(`/api/auth/api-keys/${personal.body.id}/rotate`)
                .set(session(OWNER))
                .send({});
            expect(mine.status).toBe(200);
            expect(mine.body.key).toMatch(/^ew_live_/);
        });
    });

    describe('throttle tier', () => {
        it('a key over its write budget gets 429 rate_limited in the envelope, other callers are unaffected', async () => {
            process.env.INTEGRATION_THROTTLE_WRITES_PER_MIN = '2';
            try {
                const { key } = await createIntegrationKey();
                const statuses: number[] = [];
                let last: request.Response | undefined;
                for (let i = 0; i < 3; i++) {
                    last = await request(app.getHttpServer())
                        .post('/api/probe/tasks')
                        .set('x-api-key', key)
                        .set('X-Scope-Slug', 'acme')
                        .send({});
                    statuses.push(last.status);
                }
                expect(statuses).toEqual([201, 201, 429]);
                expect(last!.body.error.code).toBe('rate_limited');
                expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);

                // Reads have their own budget.
                const read = await request(app.getHttpServer())
                    .get('/api/probe/tasks')
                    .set('x-api-key', key)
                    .set('X-Scope-Slug', 'acme');
                expect(read.status).toBe(200);
            } finally {
                process.env.INTEGRATION_THROTTLE_WRITES_PER_MIN = '1000';
            }
        });
    });
});
