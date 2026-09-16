import { DataSource, type Repository } from 'typeorm';
import { FleetNode } from '../../entities/fleet-node.entity';
import {
    ComputerControlRepository,
    type ComputerControlGrant,
} from '../computer-control.repository';

/**
 * The machine control lock, against a real database (in-memory
 * better-sqlite3 — the same engine the e2e stack runs). Every act is one
 * conditional UPDATE, so what is pinned here is what the database decides:
 *
 *  - two takes of a free machine racing each other produce exactly one holder;
 *  - a release is scoped by the holding view and by the deadline that
 *    expired, so a stale releaser never evicts a newer holder;
 *  - a hand-over moves the lock only while that exact request is pending.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const NODE = '33333333-3333-4333-8333-333333333333';
const VIEW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T0 = new Date('2026-09-14T09:00:00.000Z');

function at(offsetMs: number): Date {
    return new Date(T0.getTime() + offsetMs);
}

function grant(sessionId: string, now = T0): ComputerControlGrant {
    return {
        userId: OWNER,
        sessionId,
        now,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        idleAt: new Date(now.getTime() + 10 * 60_000),
    };
}

describe('ComputerControlRepository (better-sqlite3)', () => {
    let dataSource: DataSource;
    let rows: Repository<FleetNode>;
    let locks: ComputerControlRepository;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [FleetNode],
            synchronize: true,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(FleetNode);
        await rows.save(
            rows.create({
                id: NODE,
                userId: OWNER,
                name: 'studio',
                kind: 'desktop-node',
                status: 'online',
                enrollmentTokenHash: 'hash',
                capabilities: ['attended', 'screen'],
            } as Partial<FleetNode>),
        );
        locks = new ComputerControlRepository(rows);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('lets exactly one of two racing takes win, and the loser reads the real holder', async () => {
        const [a, b] = await Promise.all([
            locks.take(NODE, OWNER, grant(VIEW_A)),
            locks.take(NODE, OWNER, grant(VIEW_B)),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
        const lock = await locks.findLock(NODE, OWNER);
        expect(lock?.controlHolderSessionId).toBe(a ? VIEW_A : VIEW_B);
    });

    it('never takes another owner’s machine, and reads it as unknown', async () => {
        const stranger = '99999999-9999-4999-8999-999999999999';
        expect(await locks.take(NODE, stranger, grant(VIEW_A))).toBe(false);
        expect(await locks.findLock(NODE, stranger)).toBeNull();
    });

    it('scopes a release by the holding view: a stale releaser cannot evict a newer holder', async () => {
        expect(await locks.take(NODE, OWNER, grant(VIEW_A))).toBe(true);
        expect(await locks.release(NODE, VIEW_A, { kind: 'holder' })).toBe(true);
        expect(await locks.take(NODE, OWNER, grant(VIEW_B))).toBe(true);

        // View A's late "give back" (or a timer that fired late) finds nothing to release.
        expect(await locks.release(NODE, VIEW_A, { kind: 'holder' })).toBe(false);
        expect((await locks.findLock(NODE, OWNER))?.controlHolderSessionId).toBe(VIEW_B);
    });

    it('releases for inactivity only once the idle deadline has passed, and not after input moved it', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        const idleAt = at(10 * 60_000);

        expect(
            await locks.release(NODE, VIEW_A, {
                kind: 'idle',
                now: new Date(idleAt.getTime() - 1),
            }),
        ).toBe(false);
        expect(await locks.recordActivity(NODE, VIEW_A, at(9 * 60_000), at(19 * 60_000))).toBe(
            true,
        );
        // A release decided from the old deadline loses to the input that moved it.
        expect(await locks.release(NODE, VIEW_A, { kind: 'idle', now: idleAt })).toBe(false);
        expect(await locks.release(NODE, VIEW_A, { kind: 'idle', now: at(19 * 60_000) })).toBe(
            true,
        );
    });

    it('releases at the ceiling, and refuses input that arrives after it', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        const ceiling = at(60 * 60_000);
        expect(await locks.recordActivity(NODE, VIEW_A, ceiling, at(70 * 60_000))).toBe(false);
        expect(await locks.release(NODE, VIEW_A, { kind: 'ceiling', now: ceiling })).toBe(true);
    });

    it('releases an unacknowledged hold only past the floor', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        expect(await locks.acknowledge(NODE, VIEW_A, at(20_000))).toBe(true);
        expect(
            await locks.release(NODE, VIEW_A, { kind: 'unacknowledged', before: at(19_999) }),
        ).toBe(false);
        expect(
            await locks.release(NODE, VIEW_A, { kind: 'unacknowledged', before: at(20_000) }),
        ).toBe(true);
    });

    it('extends a stretch exactly once', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        expect(await locks.extend(NODE, VIEW_A, at(1000), at(120 * 60_000))).toBe(true);
        expect(await locks.extend(NODE, VIEW_A, at(2000), at(180 * 60_000))).toBe(false);
        expect(await locks.extend(NODE, VIEW_B, at(2000), at(180 * 60_000))).toBe(false);
    });

    it('parks one request; a second waits until the first declined on its own', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        expect(
            await locks.request(
                NODE,
                VIEW_A,
                { userId: OWNER, sessionId: VIEW_B },
                at(0),
                at(-60_000),
            ),
        ).toBe(true);
        expect(
            await locks.request(
                NODE,
                VIEW_A,
                { userId: OWNER, sessionId: other },
                at(59_999),
                at(-1),
            ),
        ).toBe(false);
        expect(
            await locks.request(
                NODE,
                VIEW_A,
                { userId: OWNER, sessionId: other },
                at(60_000),
                at(0),
            ),
        ).toBe(true);
        expect((await locks.findLock(NODE, OWNER))?.controlRequestSessionId).toBe(other);
    });

    it('hands over only to the pending, fresh request, in the same statement that clears it', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        await locks.request(
            NODE,
            VIEW_A,
            { userId: OWNER, sessionId: VIEW_B },
            at(1000),
            at(-60_000),
        );

        // A request that has declined on its own cannot be handed over to.
        expect(await locks.handOver(NODE, VIEW_A, grant(VIEW_B, at(61_000)), at(1000))).toBe(false);
        // A view that does not hold the lock cannot hand it over.
        expect(await locks.handOver(NODE, VIEW_B, grant(VIEW_B, at(2000)), at(-58_000))).toBe(
            false,
        );

        expect(await locks.handOver(NODE, VIEW_A, grant(VIEW_B, at(2000)), at(-58_000))).toBe(true);
        const lock = await locks.findLock(NODE, OWNER);
        expect(lock?.controlHolderSessionId).toBe(VIEW_B);
        expect(lock?.controlRequestSessionId).toBeNull();
        // The old holder's release now finds nothing.
        expect(await locks.release(NODE, VIEW_A, { kind: 'holder' })).toBe(false);
    });

    it('a hand-over and a give-back racing each other never leave two holders', async () => {
        await locks.take(NODE, OWNER, grant(VIEW_A));
        await locks.request(
            NODE,
            VIEW_A,
            { userId: OWNER, sessionId: VIEW_B },
            at(1000),
            at(-60_000),
        );
        const [handedOver, gaveBack] = await Promise.all([
            locks.handOver(NODE, VIEW_A, grant(VIEW_B, at(2000)), at(-58_000)),
            locks.release(NODE, VIEW_A, { kind: 'holder' }),
        ]);
        expect([handedOver, gaveBack].filter(Boolean)).toHaveLength(1);
        const lock = await locks.findLock(NODE, OWNER);
        expect(lock?.controlHolderSessionId).toBe(handedOver ? VIEW_B : null);
    });
});
