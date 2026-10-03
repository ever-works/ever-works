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
import * as request from 'supertest';
import type { DataSource } from 'typeorm';
import { UserRepository } from '@ever-works/agent/database';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import { InstanceStatsController } from '../instance-stats.controller';
import { InstanceStatsService } from '../instance-stats.service';
import { createHarness, type StatsHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * The operator routes over HTTP, with the real service on a seeded database:
 * any signed-in person reads `{enabled}` and nothing else, every other route
 * is the platform admin's (403 for anyone else), *Send now* is refused while
 * switched off (409) and allowed once per 10 minutes (429), the switch and
 * the reset each write one Activity row with the actor and the action only,
 * and no response may be cached. The three controls (the switch, *Send now*,
 * *Reset instance identity*) need the admin's interactive session: an API key
 * or a fleet-run credential acting as the admin is refused (403) and changes
 * nothing.
 */
const USERS: Record<string, { isPlatformAdmin: boolean }> = {
    admin: { isPlatformAdmin: true },
    member: { isPlatformAdmin: false },
};

/**
 * Stands in for the global session guard: `x-test-user` names the signed-in
 * person and `x-test-auth` the credential path it stamps (`authMethod`) —
 * `session` unless the request says otherwise, `none` for no stamp at all.
 */
@Injectable()
class TestSessionGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<{
            headers: Record<string, string | undefined>;
            user?: { userId: string; authMethod?: string };
        }>();
        const id = req.headers['x-test-user'];
        if (!id) return false;
        const method = req.headers['x-test-auth'] ?? 'session';
        req.user = method === 'none' ? { userId: id } : { userId: id, authMethod: method };
        return true;
    }
}

describe('InstanceStatsController', () => {
    let dataSource: DataSource;
    let harness: StatsHarness;
    let app: INestApplication;

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        harness = createHarness(dataSource, { now: new Date('2026-10-15T08:00:00Z') });
        await harness.identity.ensure();
        await harness.lease.ensureSchedule(new Date('2026-10-16T08:00:00Z'));

        const moduleRef = await Test.createTestingModule({
            controllers: [InstanceStatsController],
            providers: [
                { provide: APP_GUARD, useClass: TestSessionGuard },
                IsPlatformAdminGuard,
                { provide: InstanceStatsService, useValue: harness.service },
                {
                    provide: UserRepository,
                    useValue: { findById: async (id: string) => USERS[id] ?? null },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const as = (user: string, auth = 'session') => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set('x-test-user', user)
                .set('x-test-auth', auth),
        post: (path: string) =>
            request(app.getHttpServer())
                .post(path)
                .set('x-test-user', user)
                .set('x-test-auth', auth),
        put: (path: string, body: object) =>
            request(app.getHttpServer())
                .put(path)
                .set('x-test-user', user)
                .set('x-test-auth', auth)
                .send(body),
    });

    it('answers {enabled, managedBy} and nothing else to a member', async () => {
        const res = await as('member').get('/api/instance-stats/status').expect(200);
        expect(res.body).toEqual({ enabled: true, managedBy: 'operator' });
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers the full status to the platform admin', async () => {
        const res = await as('admin').get('/api/instance-stats/status').expect(200);
        expect(res.body).toMatchObject({
            operator: true,
            enabled: true,
            reason: 'on',
            uiEnabled: true,
            installSource: 'self-hosted',
            country: 'ZZ',
            statsApiUrl: 'https://api.ever.co',
            sinkAvailable: true,
            keyStoredEncrypted: false,
            managedBy: 'operator',
            nextSendAt: '2026-10-16T08:00:00.000Z',
            lastReport: null,
        });
        expect(res.body.instanceId).toMatch(/^[0-9a-f-]{36}$/);
        // Never the key, never the payload in the status: the one key-related
        // field is whether the key is stored encrypted.
        const identity = (await harness.identity.get())!;
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(identity.statsPublicKey);
        expect(body).not.toContain(identity.statsPrivateKeyEncrypted);
        expect(body).not.toContain(identity.statsKeyId);
        expect(body).not.toMatch(/payload/i);
        expect(Object.keys(res.body).filter((name) => /key/i.test(name))).toEqual([
            'keyStoredEncrypted',
        ]);
    });

    it.each([
        ['post', '/api/instance-stats/preview'],
        ['get', '/api/instance-stats/last'],
        ['post', '/api/instance-stats/send-now'],
        ['post', '/api/instance-stats/reset-identity'],
    ] as const)('refuses %s %s to a member (403)', async (method, path) => {
        await as('member')[method](path).expect(403);
    });

    it('refuses the switch to a member (403)', async () => {
        await as('member').put('/api/instance-stats/toggle', { enabled: false }).expect(403);
        expect((await harness.identity.get())?.statsEnabledUi).toBe(true);
    });

    // `api-key`: an `ew_live_` personal key or an `ew_run_` fleet-run credential
    // acting as the admin; `ever-id-delegated`: a delegated Ever ID token; `none`:
    // a credential path that stamped nothing (fails closed).
    describe.each(['api-key', 'ever-id-delegated', 'none'])(
        'the platform admin through a %s credential',
        (auth) => {
            it('cannot switch statistics on or off (403) — the switch is unchanged', async () => {
                const before = (await harness.identity.get())!.statsEnabledUi;
                const res = await as('admin', auth)
                    .put('/api/instance-stats/toggle', { enabled: !before })
                    .expect(403);
                expect(res.body.code).toBe('session_required');
                expect((await harness.identity.get())!.statsEnabledUi).toBe(before);
            });

            it('cannot Send now (403) — nothing is sent', async () => {
                const sent = harness.sink.calls.length;
                await as('admin', auth).post('/api/instance-stats/send-now').expect(403);
                expect(harness.sink.calls).toHaveLength(sent);
            });

            it('cannot reset the identity (403) — the identity is unchanged', async () => {
                const before = (await harness.identity.get())!;
                await as('admin', auth).post('/api/instance-stats/reset-identity').expect(403);
                const after = (await harness.identity.get())!;
                expect(after.instanceId).toBe(before.instanceId);
                expect(after.resetCount).toBe(before.resetCount);
            });

            it('can still read the status, the preview and the last payload', async () => {
                const status = await as('admin', auth)
                    .get('/api/instance-stats/status')
                    .expect(200);
                expect(status.body.operator).toBe(true);
                await as('admin', auth).post('/api/instance-stats/preview').expect(200);
                await as('admin', auth).get('/api/instance-stats/last').expect(200);
            });
        },
    );

    it('previews the report the admin would send, without sending or storing it', async () => {
        const res = await as('admin').post('/api/instance-stats/preview').expect(200);
        expect(res.body).toMatchObject({ schema: 'ever.stats.v1', product: 'works', final: false });
        expect(harness.sink.calls).toHaveLength(0);
        expect(await harness.lease.lastReport()).toBeNull();
    });

    it('sends now once, then refuses within 10 minutes (429), and shows the exact last payload', async () => {
        const first = await as('admin').post('/api/instance-stats/send-now').expect(200);
        expect(first.body.results).toEqual([{ status: 'sent', httpStatus: 202, errorCode: null }]);

        const second = await as('admin').post('/api/instance-stats/send-now').expect(429);
        expect(second.body.code).toBe('rate_limited');
        expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);

        const last = await as('admin').get('/api/instance-stats/last').expect(200);
        expect(last.body.report.payload).toBe(
            Buffer.from(harness.sink.calls[0].report.body).toString('utf8'),
        );
        expect(harness.activity).toContainEqual(
            expect.objectContaining({
                userId: 'admin',
                action: 'instance_stats.send_now',
                metadata: {},
            }),
        );
    });

    it('switches off: status says ui, send-now is refused (409), one Activity row with no payload', async () => {
        harness.clock.now = new Date('2026-10-15T09:00:00Z');
        const res = await as('admin')
            .put('/api/instance-stats/toggle', { enabled: false })
            .expect(200);
        expect(res.body).toEqual({ enabled: false });

        const status = await as('admin').get('/api/instance-stats/status').expect(200);
        expect(status.body).toMatchObject({ enabled: false, reason: 'ui', nextSendAt: null });
        expect((await as('member').get('/api/instance-stats/status')).body).toEqual({
            enabled: false,
            managedBy: 'operator',
        });

        const refused = await as('admin').post('/api/instance-stats/send-now').expect(409);
        expect(refused.body).toMatchObject({ code: 'stats_disabled', reason: 'ui' });

        const row = harness.activity.find((entry) => entry.action === 'instance_stats.disabled');
        expect(row).toMatchObject({ userId: 'admin', metadata: {} });
        expect(row).not.toHaveProperty('ipAddress');
        expect(row).not.toHaveProperty('userAgent');

        await as('admin').put('/api/instance-stats/toggle', { enabled: true }).expect(200);
    });

    it('validates the switch body', async () => {
        await as('admin').put('/api/instance-stats/toggle', { enabled: 'yes' }).expect(400);
        await as('admin')
            .put('/api/instance-stats/toggle', { enabled: true, extra: 1 })
            .expect(400);
    });

    it('refuses the reset while a send holds the lease (409), and changes nothing', async () => {
        const before = (await harness.identity.get())!;
        // Another replica is sending: it holds the lease.
        const other = createHarness(dataSource, { now: harness.clock.now });
        expect(await other.lease.tryAcquire(harness.clock.now)).toBe(true);
        try {
            const res = await as('admin').post('/api/instance-stats/reset-identity').expect(409);
            expect(res.body.code).toBe('send_in_progress');
            expect((await harness.identity.get())!.instanceId).toBe(before.instanceId);
        } finally {
            await other.lease.release();
        }
    });

    it('resets the identity for the admin', async () => {
        const before = (await harness.identity.get())!;
        const res = await as('admin').post('/api/instance-stats/reset-identity').expect(200);
        expect(res.body.instanceId).not.toBe(before.instanceId);
        expect(res.body.resetCount).toBe(before.resetCount + 1);
        expect((await harness.identity.get())!.statsPublicKey).not.toBe(before.statsPublicKey);
    });

    it('names Ever Cloud as the manager of a cloud installation', async () => {
        const cloud = createHarness(dataSource, {
            env: { EVER_INSTALL_SOURCE: 'cloud' },
            now: harness.clock.now,
        });
        expect(await cloud.service.publicStatus()).toEqual({ enabled: true, managedBy: 'cloud' });
        expect(await cloud.service.operatorStatus()).toMatchObject({
            managedBy: 'cloud',
            reason: 'cloud-managed',
        });
    });
});
