import { ProblemError } from '@ever-co/connect-sdk';
import type { DataSource } from 'typeorm';
import { EverConnectOutbox, EverInstance } from '@ever-works/agent/entities';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { readEverConnectConfig } from '../ever-connect.config';
import { EverConnectFeedService } from '../ever-connect-feed.service';
import type { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectKeyService } from '../ever-connect-key.service';
import type { EverConnectLeaseService } from '../ever-connect-lease.service';
import { EverConnectOutboxService, EverConnectOutboxWorker } from '../ever-connect-outbox.service';
import { EverConnectRunner } from '../ever-connect.runner';
import type { EverConnectService } from '../ever-connect.service';
import type { EverIdLoginHandler } from '../identity/ever-id-login.handler';
import type { PersonLinkReport } from '../identity/ever-connect-identity.ports';
import type { PersonLinkReporter, PersonLinkSendOutcome } from '../identity/person-link.reporter';
import type { PersonRequestsHandler } from '../identity/person-requests.handler';
import { createIdentityDataSource } from '../identity/__tests__/db.helper-spec';

/**
 * The core of the Ever Connect module, piece by piece (the whole flow runs
 * against the mock platform in `ever-connect.mock.spec.ts`).
 *
 * - Feed: each event goes to its handler; a failing handler stops the pass at
 *   that event, so it is read again; a position past retention reads the state
 *   again and continues where Ever Platform says; a revoked credential or a
 *   disconnect ends the connection here.
 * - Outbox: oldest first; while a report about an account waits for a retry,
 *   later reports about that account wait too; delivered and dropped reports
 *   are removed, refused ones kept as `failed`.
 * - The connect code from the environment is used once.
 * - The connect key is made once, wrapped, and discarded on request.
 */
describe('Ever Connect core', () => {
    describe('the feed', () => {
        const page = (ids: Array<[string, string]>, more = false) => ({
            events: ids.map(([id, type]) => ({ id, type, data: { job_id: id } })),
            has_more: more,
            last_id: ids.length ? ids[ids.length - 1][0] : 'evt-0',
        });

        function setup(events: jest.Mock) {
            const instances = { events, ackEvents: jest.fn().mockResolvedValue({}) };
            const connection = {
                client: jest.fn().mockResolvedValue({ instances }),
                connection: jest.fn().mockResolvedValue({ lastFeedCursor: 'evt-0' }),
                saveFeedCursor: jest.fn().mockResolvedValue(undefined),
                ended: jest.fn().mockResolvedValue(undefined),
                approved: jest.fn().mockResolvedValue(undefined),
            };
            const integrations = { refresh: jest.fn().mockResolvedValue([]) };
            const requests = {
                handles: (type: string) => type.startsWith('ever.registry.person.'),
                handle: jest.fn().mockResolvedValue({ recorded: true }),
            };
            const feed = new EverConnectFeedService(
                connection as unknown as EverConnectService,
                integrations as unknown as EverConnectIntegrationService,
                requests as unknown as PersonRequestsHandler,
            );
            return { feed, instances, connection, integrations, requests };
        }

        it('hands each event to its handler and acknowledges the page', async () => {
            const { feed, instances, connection, integrations, requests } = setup(
                jest.fn().mockResolvedValue(
                    page([
                        ['evt-1', 'ever.consent.integration.enabled'],
                        ['evt-2', 'ever.registry.person.deletion_requested'],
                        ['evt-3', 'ever.registry.tenant_link.created'],
                    ]),
                ),
            );
            expect(await feed.pollOnce(0)).toEqual({ handled: 3, more: false });
            expect(instances.events).toHaveBeenCalledWith('evt-0', { waitS: 0 });
            expect(integrations.refresh).toHaveBeenCalledTimes(1);
            expect(requests.handle).toHaveBeenCalledTimes(1);
            expect(instances.ackEvents).toHaveBeenCalledWith('evt-3');
            expect(connection.saveFeedCursor).toHaveBeenCalledWith('evt-3');
        });

        it('stops at an event whose handler failed, so it is read again', async () => {
            const { feed, instances, connection, requests } = setup(
                jest.fn().mockResolvedValue(
                    page(
                        [
                            ['evt-1', 'ever.consent.integration.enabled'],
                            ['evt-2', 'ever.registry.person.deletion_requested'],
                            ['evt-3', 'ever.consent.consent.revoked'],
                        ],
                        true,
                    ),
                ),
            );
            requests.handle.mockRejectedValue(new Error('ack not delivered'));
            expect(await feed.pollOnce(0)).toEqual({ handled: 1, more: false });
            expect(instances.ackEvents).toHaveBeenCalledWith('evt-1');
            expect(connection.saveFeedCursor).toHaveBeenCalledWith('evt-1');
        });

        it('a position past retention: the state is read again, the feed continues where Ever Platform says', async () => {
            const gone = new ProblemError(
                410,
                'resync_required',
                undefined,
                null,
                undefined,
                undefined,
                'evt-90',
            );
            const { feed, instances, connection, integrations } = setup(
                jest.fn().mockRejectedValue(gone),
            );
            expect(await feed.pollOnce(0)).toEqual({ handled: 0, more: true });
            expect(integrations.refresh).toHaveBeenCalled();
            expect(instances.ackEvents).toHaveBeenCalledWith('evt-90');
            expect(connection.saveFeedCursor).toHaveBeenCalledWith('evt-90');
        });

        it('a revoked credential, or a disconnect on the feed, ends the connection here', async () => {
            const revoked = setup(
                jest.fn().mockRejectedValue(new ProblemError(401, 'credential_revoked')),
            );
            expect(await revoked.feed.pollOnce(0)).toEqual({ handled: 0, more: false });
            expect(revoked.connection.ended).toHaveBeenCalledWith('revoked');

            const disconnected = setup(
                jest.fn().mockResolvedValue(
                    page([
                        ['evt-1', 'ever.registry.instance.disconnected'],
                        ['evt-2', 'ever.consent.integration.enabled'],
                    ]),
                ),
            );
            expect(await disconnected.feed.pollOnce(0)).toEqual({ handled: 1, more: false });
            expect(disconnected.connection.ended).toHaveBeenCalledWith('disconnected');
            expect(disconnected.integrations.refresh).not.toHaveBeenCalled();
        });

        it('a resync without a position waits for the next round', async () => {
            const { feed, instances, connection } = setup(
                jest.fn().mockRejectedValue(new ProblemError(410, 'resync_required')),
            );
            expect(await feed.pollOnce(0)).toEqual({ handled: 0, more: false });
            expect(instances.ackEvents).not.toHaveBeenCalled();
            expect(connection.saveFeedCursor).not.toHaveBeenCalled();
        });

        it('reads nothing while not connected', async () => {
            const { feed, connection, instances } = setup(jest.fn());
            connection.client.mockResolvedValue(null);
            expect(await feed.pollOnce(0)).toEqual({ handled: 0, more: false });
            expect(instances.events).not.toHaveBeenCalled();
        });
    });

    describe('the outbox', () => {
        let dataSource: DataSource;

        beforeAll(async () => {
            dataSource = await createIdentityDataSource();
        });

        afterAll(async () => {
            await dataSource.destroy();
        });

        beforeEach(async () => {
            await dataSource.getRepository(EverConnectOutbox).clear();
        });

        const link = (id: string, userRef: string): PersonLinkReport => ({
            id,
            op: 'link',
            userRef,
            issuer: 'https://id.example.test',
            subject: `sub-${userRef}`,
            linkMethod: 'explicit',
        });

        it("delivers oldest first and keeps an account's reports in order", async () => {
            const queue = new EverConnectOutboxService(dataSource.getRepository(EverConnectOutbox));
            await queue.enqueue(link('r1', 'ada'));
            await queue.enqueue({ id: 'r2', op: 'unlink', userRef: 'ada' });
            await queue.enqueue(link('r3', 'bob'));
            await queue.enqueue(link('r4', 'cy'));
            // Enqueued twice: one row.
            await queue.enqueue(link('r4', 'cy'));

            const outcomes: Record<string, PersonLinkSendOutcome> = {
                r1: { outcome: 'retry', afterMs: 60_000, code: 'subject_unknown' },
                r3: { outcome: 'sent' },
                r4: { outcome: 'failed', code: 'link_not_found' },
            };
            const sent: string[] = [];
            const reporter = {
                send: jest.fn(async (report: PersonLinkReport) => {
                    sent.push(report.id);
                    return outcomes[report.id] ?? { outcome: 'sent' };
                }),
            };
            const worker = new EverConnectOutboxWorker(
                dataSource.getRepository(EverConnectOutbox),
                reporter as unknown as PersonLinkReporter,
            );

            const now = new Date();
            expect(await worker.drainOnce(now)).toBe(1);
            expect(sent).toEqual(['r1', 'r3', 'r4']);
            const rows = await dataSource.getRepository(EverConnectOutbox).find();
            expect(
                rows
                    .map((row) => [
                        (row.payload as { id: string }).id,
                        row.state,
                        row.attempts,
                        row.lastError,
                    ])
                    .sort(),
            ).toEqual([
                ['r1', 'pending', 1, 'subject_unknown'],
                ['r2', 'pending', 0, null],
                ['r4', 'failed', 1, 'link_not_found'],
            ]);
            expect(await queue.status()).toMatchObject({ pending: 2, failed: 1 });

            // Before the retry is due, nothing about ada moves.
            sent.length = 0;
            await worker.drainOnce(new Date(now.getTime() + 30_000));
            expect(sent).toEqual([]);

            // Once due: the link, then the unlink, in order.
            outcomes.r1 = { outcome: 'sent' };
            await worker.drainOnce(new Date(now.getTime() + 61_000));
            expect(sent).toEqual(['r1', 'r2']);
            expect(reporter.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 1);
        });

        it('reports waiting for a retry never hold up the others', async () => {
            const repository = dataSource.getRepository(EverConnectOutbox);
            const queue = new EverConnectOutboxService(repository);
            for (let i = 0; i < 120; i += 1) await queue.enqueue(link(`w${i}`, `waiting-${i}`));
            await repository.update(
                { state: 'pending' },
                { nextAttemptAt: new Date(Date.now() + 3_600_000) },
            );
            await queue.enqueue(link('due', 'zed'));

            const reporter = {
                send: jest.fn(async () => ({ outcome: 'sent' }) as PersonLinkSendOutcome),
            };
            const worker = new EverConnectOutboxWorker(
                repository,
                reporter as unknown as PersonLinkReporter,
            );
            expect(await worker.drainOnce()).toBe(1);
            expect(reporter.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'due' }), 0);
        });

        it('the connection ending drops what is still owed', async () => {
            const queue = new EverConnectOutboxService(dataSource.getRepository(EverConnectOutbox));
            await queue.enqueue(link('r1', 'ada'));
            await queue.onConnectionChanged({ status: 'disconnected' });
            expect(await dataSource.getRepository(EverConnectOutbox).count()).toBe(0);
        });
    });

    describe('the connect code from the environment', () => {
        it('is used once', async () => {
            let used = false;
            const connection = {
                status: jest.fn().mockResolvedValue({ status: 'disconnected' }),
                markEnvCodeUsed: jest.fn(async () => {
                    const first = !used;
                    used = true;
                    return first;
                }),
                connect: jest.fn().mockRejectedValue(new Error('network')),
                client: jest.fn().mockResolvedValue(null),
            };
            const runner = new EverConnectRunner(
                readEverConnectConfig({ EVER_CONNECT_CODE: 'EVC-TEST-0000-0004' }),
                connection as unknown as EverConnectService,
                {
                    refresh: jest.fn(),
                    isEnabled: jest.fn(),
                } as unknown as EverConnectIntegrationService,
                { start: jest.fn() } as unknown as EverIdLoginHandler,
                { hold: jest.fn(), release: jest.fn() } as unknown as EverConnectLeaseService,
                {} as EverConnectFeedService,
                {} as EverConnectOutboxWorker,
            );
            await runner.boot();
            await runner.boot();
            expect(connection.connect).toHaveBeenCalledTimes(1);
            expect(connection.connect).toHaveBeenCalledWith('EVC-TEST-0000-0004');
        });
    });

    describe('the connect key', () => {
        let dataSource: DataSource;

        beforeAll(async () => {
            dataSource = await createIdentityDataSource();
        });

        afterAll(async () => {
            await dataSource.destroy();
        });

        it('is made once, kept apart from the statistics key, and discarded on request', async () => {
            const instances = dataSource.getRepository(EverInstance);
            const keys = new EverConnectKeyService(instances, new EverInstanceService(instances));
            expect(await keys.signer()).toBeNull();

            const first = await keys.ensure();
            const again = await keys.ensure();
            expect(again).toEqual(first);
            const [row] = await instances.find();
            expect(row.connectPublicKey).toBe(first.x);
            expect(row.connectKeyId).toBe((await keys.signer())?.kid);
            expect(row.connectPublicKey).not.toBe(row.statsPublicKey);

            await keys.discard();
            expect(await keys.signer()).toBeNull();
            expect((await keys.ensure()).x).not.toBe(first.x);
        });
    });
});
