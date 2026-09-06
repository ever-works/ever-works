import { createHash } from 'crypto';
import { FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS } from '@ever-works/contracts';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FLEET_NODE_OFFLINE_AFTER_MS, FleetService } from '../fleet.service';

/**
 * Fleet health signals (EW-776, finding OPS-02) — the three Inbox
 * notices and their dedup.
 *
 * The defect these close: a machine that self-quarantined kept beating,
 * therefore kept reading `online`, and refused every job it was offered.
 * Nothing told its owner. Nothing told them when a PC went dark either —
 * and under the runbook's recommended `local-wait` there is no cloud
 * fallback, so there was no other signal at all.
 *
 * What is pinned here is the ONE thing a notification feature can get
 * wrong in both directions at once: firing more than once per event (an
 * inbox that cries wolf every 30 seconds is an inbox nobody reads), and
 * failing to re-arm afterwards (a second outage that says nothing is
 * worse than the first one that did). `InboxService.notice` has no dedup
 * of its own, so correctness rests entirely on the per-row CAS markers
 * exercised below.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const SECRET = 'sec_'.padEnd(43, 'f');
const NODE_ID = '11111111-1111-4111-8111-111111111111';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: 'user-1',
        organizationId: null,
        name: 'Office PC',
        kind: 'desktop-node',
        status: 'online',
        enrollmentTokenHash: sha256(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: [],
        platform: null,
        version: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

describe('fleet health signals — Inbox notices', () => {
    let repository: {
        create: jest.Mock;
        findById: jest.Mock;
        findByCredentialHash: jest.Mock;
        findByUser: jest.Mock;
        consumeEnrollment: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
        sweepOffline: jest.Mock;
        findStaleOnline: jest.Mock;
        markOfflineIfStale: jest.Mock;
        findOfflineUnnoticed: jest.Mock;
        markLongOfflineNoticed: jest.Mock;
    };
    let inbox: {
        notice: jest.Mock;
        escalationRaised: jest.Mock;
        proposalPending: jest.Mock;
        questionRaised: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            create: jest.fn(async (data) => node({ ...data })),
            findById: jest.fn(async () => null),
            findByCredentialHash: jest.fn(async () => null),
            findByUser: jest.fn(async () => []),
            consumeEnrollment: jest.fn(async () => true),
            update: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
            sweepOffline: jest.fn(async () => 0),
            findStaleOnline: jest.fn(async () => []),
            markOfflineIfStale: jest.fn(async () => true),
            findOfflineUnnoticed: jest.fn(async () => []),
            markLongOfflineNoticed: jest.fn(async () => true),
        };
        inbox = {
            notice: jest.fn(async () => undefined),
            escalationRaised: jest.fn(async () => undefined),
            proposalPending: jest.fn(async () => undefined),
            questionRaised: jest.fn(async () => undefined),
        };
    });

    const build = (withInbox = true) =>
        new FleetService(
            repository as never,
            undefined,
            undefined,
            withInbox ? (inbox as never) : undefined,
        );

    const beat = (service: FleetService, refresh: Record<string, unknown>) =>
        service.heartbeat(NODE_ID, SECRET, refresh);

    describe('online → quarantined', () => {
        it('files one notice on the first beat that reports the quarantine', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await beat(service, {
                workerState: 'quarantined',
                workerStateReason: 'process tree for job 42 could not be proven terminated',
            });

            expect(inbox.notice).toHaveBeenCalledTimes(1);
            const [userId, payload] = inbox.notice.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(payload.title).toBe('Fleet node quarantined: Office PC');
            // The three facts the operator needs: which machine, why, and
            // when it was last heard from.
            expect(payload.body).toContain('Office PC');
            expect(payload.body).toContain('could not be proven terminated');
            expect(payload.body).toContain('Last seen:');
            // The marker rides in the same patch as the state it describes.
            expect(repository.update.mock.calls[0][1].quarantineNoticedAt).toBeInstanceOf(Date);
        });

        it('says nothing on the SECOND beat that reports the same quarantine', async () => {
            // A quarantined node keeps beating twice a minute. Without the
            // marker that is 2,880 notices a day for one event.
            repository.findById.mockResolvedValue(
                node({ workerState: 'quarantined', quarantineNoticedAt: new Date() }),
            );
            const service = build();

            await beat(service, { workerState: 'quarantined', workerStateReason: 'same reason' });

            expect(inbox.notice).not.toHaveBeenCalled();
            expect(repository.update.mock.calls[0][1]).not.toHaveProperty('quarantineNoticedAt');
        });

        it('re-arms when the node reports a healthy state again', async () => {
            repository.findById.mockResolvedValue(
                node({ workerState: 'quarantined', quarantineNoticedAt: new Date() }),
            );
            const service = build();

            await beat(service, { workerState: 'idle' });

            expect(inbox.notice).not.toHaveBeenCalled();
            expect(repository.update.mock.calls[0][1].quarantineNoticedAt).toBeNull();
        });

        it('notifies again after a re-arm — a second quarantine is news', async () => {
            const service = build();
            repository.findById.mockResolvedValue(
                node({ workerState: 'idle', quarantineNoticedAt: null }),
            );

            await beat(service, { workerState: 'quarantined', workerStateReason: 'second time' });

            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].body).toContain('second time');
        });

        it('does not fire for a throttle or a pause', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await beat(service, { workerState: 'throttled', workerStateReason: 'cpu ceiling' });
            await beat(service, { workerState: 'paused' });

            expect(inbox.notice).not.toHaveBeenCalled();
        });

        it('does not fire for an unrecognised state a newer daemon reported', async () => {
            // Normalized to "unknown", which is honest — but it is not a
            // quarantine and must not be announced as one.
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await beat(service, { workerState: 'hibernating', workerStateReason: 'zzz' });

            expect(inbox.notice).not.toHaveBeenCalled();
            expect(repository.update.mock.calls[0][1].workerState).toBeNull();
        });

        it('survives an Inbox that throws — the beat still succeeds', async () => {
            // The inbox mirrors records; failing to mirror must never fail
            // the record. A rejected beat is a node that goes offline.
            inbox.notice.mockRejectedValue(new Error('inbox down'));
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build();

            await expect(beat(service, { workerState: 'quarantined' })).resolves.not.toBeNull();
        });
    });

    describe('online → offline', () => {
        it('files exactly one notice per flip and only for the row it won the CAS on', async () => {
            const stale = node({
                status: 'online',
                lastHeartbeatAt: new Date(Date.now() - 60 * 60_000),
            });
            repository.findStaleOnline.mockResolvedValue([stale]);
            const service = build();

            await service.listEnrolledForUser('user-1');

            expect(repository.markOfflineIfStale).toHaveBeenCalledTimes(1);
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].title).toBe('Fleet node offline: Office PC');
            expect(inbox.notice.mock.calls[0][1].body).toContain('Last seen:');
        });

        it('says nothing when the CAS is lost — the node beat back, or another replica won', async () => {
            repository.findStaleOnline.mockResolvedValue([node({ status: 'online' })]);
            repository.markOfflineIfStale.mockResolvedValue(false);
            const service = build();

            await service.listEnrolledForUser('user-1');

            expect(inbox.notice).not.toHaveBeenCalled();
        });

        it('still runs the bulk sweep, with the same cutoff it announced against', async () => {
            // The per-row pass is the notice; the bulk UPDATE remains the
            // catch-all for anything it missed between the two statements.
            const before = Date.now();
            const service = build();

            await service.listEnrolledForUser('user-1');

            const [, announced] = repository.findStaleOnline.mock.calls[0];
            const [userId, swept] = repository.sweepOffline.mock.calls[0];
            expect(userId).toBe('user-1');
            expect((swept as Date).getTime()).toBe((announced as Date).getTime());
            const offset = before - (swept as Date).getTime();
            expect(offset).toBeGreaterThanOrEqual(FLEET_NODE_OFFLINE_AFTER_MS - 1000);
            expect(offset).toBeLessThanOrEqual(FLEET_NODE_OFFLINE_AFTER_MS + 1000);
        });

        it('re-arms both offline markers on the next accepted beat', async () => {
            repository.findById.mockResolvedValue(
                node({
                    status: 'offline',
                    offlineNoticedAt: new Date(),
                    offlineLongNoticedAt: new Date(),
                }),
            );
            const service = build();

            await beat(service, { workerState: 'idle' });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.offlineNoticedAt).toBeNull();
            expect(patch.offlineLongNoticedAt).toBeNull();
        });

        it('re-arms them on a beat that says NOTHING about its worker', async () => {
            // The daemons that report no worker state are exactly the ones
            // this must not forget: a build older than the field, a
            // visibility-only node with its worker disabled, and a daemon
            // that latched into liveness-only reporting after an older API
            // 400'd the fields (see `HeartbeatLoop.beat`). Tying the re-arm
            // to a reported state left `offlineLongNoticedAt` set on all
            // three forever, so their SECOND outage said nothing at all.
            repository.findById.mockResolvedValue(
                node({
                    status: 'offline',
                    offlineNoticedAt: new Date(),
                    offlineLongNoticedAt: new Date(),
                }),
            );
            const service = build();

            await beat(service, { version: '1.4.0' });

            const patch = repository.update.mock.calls[0][1];
            expect(patch.offlineNoticedAt).toBeNull();
            expect(patch.offlineLongNoticedAt).toBeNull();
            // ...and the state itself is still left alone, which is the
            // other half of the old-daemon contract.
            expect(patch).not.toHaveProperty('workerState');
        });

        it('re-arms them on a beat whose worker state is unrecognised', async () => {
            // A newer daemon reporting a value this build cannot name is
            // still a reachable machine.
            repository.findById.mockResolvedValue(
                node({ status: 'offline', offlineLongNoticedAt: new Date() }),
            );
            const service = build();

            await beat(service, { workerState: 'hibernating' });

            expect(repository.update.mock.calls[0][1].offlineLongNoticedAt).toBeNull();
        });

        it('re-arms on a PAUSED node too — a drained machine still beats', async () => {
            repository.findById.mockResolvedValue(
                node({ status: 'paused', offlineNoticedAt: new Date() }),
            );
            const service = build();

            await beat(service, { workerState: 'paused' });

            // Sticky status preserved (audit A29) AND the marker re-armed.
            expect(repository.update.mock.calls[0][1].status).toBe('paused');
            expect(repository.update.mock.calls[0][1].offlineNoticedAt).toBeNull();
        });
    });

    describe('offline for longer than the window', () => {
        it('files one escalation, measured from the configured window', async () => {
            const gone = node({
                status: 'offline',
                lastHeartbeatAt: new Date(Date.now() - 3 * 60 * 60_000),
                offlineNoticedAt: new Date(),
            });
            repository.findOfflineUnnoticed.mockResolvedValue([gone]);
            const before = Date.now();
            const service = build();

            await service.listEnrolledForUser('user-1');

            const [userId, longCutoff] = repository.findOfflineUnnoticed.mock.calls[0];
            expect(userId).toBe('user-1');
            const offset = before - (longCutoff as Date).getTime();
            expect(offset).toBeGreaterThanOrEqual(
                FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS - 1000,
            );
            expect(offset).toBeLessThanOrEqual(FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS + 1000);
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].title).toBe('Fleet node still offline: Office PC');
            expect(inbox.notice.mock.calls[0][1].body).toContain('30 minutes');
        });

        it('is not repeated on the next list read', async () => {
            // The repository predicate (`offlineLongNoticedAt IS NULL`) is
            // what stops the repeat; the CAS is the belt for two replicas.
            repository.findOfflineUnnoticed.mockResolvedValue([node({ status: 'offline' })]);
            repository.markLongOfflineNoticed.mockResolvedValue(false);
            const service = build();

            await service.listEnrolledForUser('user-1');

            expect(inbox.notice).not.toHaveBeenCalled();
        });

        it('does not take the node list down when the notice bookkeeping fails', async () => {
            // The node list is the page an operator opens BECAUSE something
            // is wrong. It must survive a broken notice path.
            repository.findStaleOnline.mockRejectedValue(new Error('db hiccup'));
            repository.findByUser.mockResolvedValue([node({ status: 'online' })]);
            const service = build();

            await expect(service.listEnrolledForUser('user-1')).resolves.toHaveLength(1);
            expect(repository.sweepOffline).toHaveBeenCalledTimes(1);
        });
    });

    describe('without an Inbox producer bound', () => {
        it('touches none of the notice machinery and sweeps exactly as before', async () => {
            // Unit tests, the worker's RPC context and installs without the
            // api layer all run with the token unbound. Extension, not
            // replacement: today's behaviour byte for byte.
            const service = build(false);

            await service.listEnrolledForUser('user-1');

            expect(repository.findStaleOnline).not.toHaveBeenCalled();
            expect(repository.findOfflineUnnoticed).not.toHaveBeenCalled();
            expect(repository.markOfflineIfStale).not.toHaveBeenCalled();
            expect(repository.sweepOffline).toHaveBeenCalledTimes(1);
        });

        it('re-arms nothing either — a later binding must not inherit markers', async () => {
            repository.findById.mockResolvedValue(
                node({ status: 'offline', offlineNoticedAt: new Date() }),
            );
            const service = build(false);

            await beat(service, { workerState: 'idle' });

            expect(repository.update.mock.calls[0][1]).not.toHaveProperty('offlineNoticedAt');
        });

        it('writes no dedup markers on a heartbeat', async () => {
            repository.findById.mockResolvedValue(node({ workerState: 'idle' }));
            const service = build(false);

            await beat(service, { workerState: 'quarantined', workerStateReason: 'why' });

            const patch = repository.update.mock.calls[0][1];
            // The state itself IS still recorded — only the notice
            // bookkeeping is inert, so a deployment that later binds the
            // inbox does not inherit stale markers.
            expect(patch.workerState).toBe('quarantined');
            expect(patch).not.toHaveProperty('quarantineNoticedAt');
        });
    });
});
