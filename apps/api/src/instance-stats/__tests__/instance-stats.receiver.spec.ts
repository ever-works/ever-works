import { generateKeyPairSync } from 'crypto';
import type { DataSource } from 'typeorm';
import { EverInstance } from '@ever-works/agent/entities';
import { keyIdOf, publicKeyBytes, toBase64Url } from '@ever-works/agent/ever-instance';
import { StatsSinkFacadeService } from '@ever-works/agent/facades';
import { PluginSecretEncService, type PluginRegistryService } from '@ever-works/agent/plugins';
import EverStatsSinkPlugin from '@ever-works/ever-stats-sink-plugin';
import { createHarness, type StatsHarness } from './fixtures/harness.helper-spec';
import { LocalStatsReceiver } from './fixtures/local-receiver.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * End to end, through the REAL sender: builder → signer → `stats-sink` facade
 * → `ever-stats-sink` plugin → HTTP → a local receiver written from the public
 * contract only (signature over the exact body, key id, size, media type,
 * schema, key pinned to the instance id on first use).
 *
 * - A one-person installation sends its FULL counts (no small-instance rule)
 *   and the receiver accepts it (202).
 * - The bytes received, the bytes signed and the stored *Last payload* are
 *   the same bytes.
 * - A refused report (422) is stored with the refused paths and parked; a
 *   second key for a pinned instance (409) is `rejected key_mismatch`, and
 *   *Reset instance identity* makes the next report a new instance (202).
 */
describe('instance statistics — delivery to a contract receiver', () => {
    let dataSource: DataSource;
    let receiver: LocalStatsReceiver;
    let h: StatsHarness;

    beforeAll(async () => {
        receiver = new LocalStatsReceiver();
        await receiver.start();
    });

    afterAll(async () => {
        await receiver.stop();
    });

    beforeEach(async () => {
        receiver.received.length = 0;
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        const plugin = new EverStatsSinkPlugin();
        const registry = {
            get: (id: string) =>
                id === 'ever-stats-sink'
                    ? { plugin, manifest: { id, capabilities: ['stats-sink'] }, state: 'loaded' }
                    : undefined,
        } as unknown as PluginRegistryService;
        h = createHarness(dataSource, {
            env: { EVER_STATS_API_URL: receiver.baseUrl },
            now: new Date('2026-10-15T08:00:00Z'),
            sink: new StatsSinkFacadeService(registry),
        });
        await h.identity.ensure();
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('delivers a one-person installation’s full counts, accepted, byte for byte', async () => {
        const outcome = await h.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'sent', httpStatus: 202, errorCode: null }],
        });

        expect(receiver.received).toHaveLength(1);
        const [request] = receiver.received;
        expect(request.status).toBe(202);
        const report = JSON.parse(request.body.toString('utf8'));
        expect(report.counts).toMatchObject({ users: 1, works: 3, tenants: 1, organizations: 1 });
        expect(Object.keys(report.counts).sort()).toEqual(
            [
                'agents',
                'fleet_nodes',
                'missions',
                'organizations',
                'plugins_enabled',
                'teams',
                'tenants',
                'users',
                'works',
                'works_by_kind',
            ].sort(),
        );
        expect(report.aggregates).toMatchObject({ deployments: 2, runs: 1, credits_consumed: 8 });

        const stored = await h.lease.lastReport();
        expect(Buffer.compare(Buffer.from(stored!.payload, 'utf8'), request.body)).toBe(0);
        expect(stored).toMatchObject({
            status: 'sent',
            httpStatus: 202,
            final: false,
            period: '2026-10',
        });
        expect(request.headers['user-agent']).toMatch(/^ever-stats\/1\.0\.0 \(works\//);
        expect(request.headers.cookie).toBeUndefined();
    });

    it('stores a refused report with the refused paths, and parks it', async () => {
        receiver.forced.push({
            status: 422,
            answer: {
                code: 'schema_violation',
                errors: [{ path: '/counts/works_by_kind/app', code: 'unknown_field' }],
            },
        });
        const outcome = await h.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [
                {
                    status: 'rejected',
                    httpStatus: 422,
                    errorCode: 'schema_violation',
                    errors: [{ path: '/counts/works_by_kind/app', code: 'unknown_field' }],
                },
            ],
        });
        expect((await h.lease.schedule())?.rejectedModuleVersion).toBe(h.sender.releaseMarker());
    });

    it('is refused as key_mismatch with another key for a pinned instance, and accepted again after a reset', async () => {
        await h.sender.runDue();
        expect(receiver.received.at(-1)?.status).toBe(202);

        // Another key for the SAME instance id: what a copied database with a
        // regenerated key would look like.
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const raw = publicKeyBytes(publicKey);
        await dataSource.getRepository(EverInstance).update(
            { id: 'self' },
            {
                statsPublicKey: toBase64Url(raw),
                statsKeyId: keyIdOf(raw),
                statsPrivateKeyEncrypted: new PluginSecretEncService().encryptValue(
                    (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString(
                        'base64',
                    ),
                ),
            },
        );
        h.clock.now = new Date('2026-10-16T09:00:00Z');
        await h.lease.updateSchedule({ nextSendAt: h.clock.now });
        const mismatch = await h.sender.runDue();
        expect(mismatch).toEqual({
            ran: true,
            results: [{ status: 'rejected', httpStatus: 409, errorCode: 'key_mismatch' }],
        });

        const before = (await h.identity.get())!;
        const reset = await h.service.resetIdentity('operator-user');
        expect(reset.instanceId).not.toBe(before.instanceId);
        expect(reset.resetCount).toBe(1);
        expect(h.activity).toContainEqual(
            expect.objectContaining({
                action: 'instance_stats.identity_reset',
                userId: 'operator-user',
                metadata: {},
            }),
        );

        h.clock.now = new Date('2026-10-16T09:20:00Z');
        const outcome = await h.service.sendNow('operator-user');
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'sent', httpStatus: 202, errorCode: null }],
        });
        const last = JSON.parse(receiver.received.at(-1)!.body.toString('utf8'));
        expect(last.instance_id).toBe(reset.instanceId);
    });

    it('records a failed send when the receiver is unavailable and retries an hour later', async () => {
        receiver.forced.push({ status: 503, answer: {} });
        const outcome = await h.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'failed', httpStatus: 503, errorCode: 'server_error' }],
        });
        expect((await h.lease.schedule())?.nextSendAt?.toISOString()).toBe(
            '2026-10-15T09:00:00.000Z',
        );
    });
});
