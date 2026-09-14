import { DataSource, type Repository } from 'typeorm';
import type { ComputerSession } from '../../entities/computer-session.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { ComputerControlRepository } from '../computer-control.repository';
import type { ComputerSessionRepository } from '../computer-session.repository';
import {
    ComputerControlArbiter,
    ComputerControlChangedEvent,
    closeSpan,
    openSpan,
    type ComputerControlChange,
} from '../control-arbiter.service';

/**
 * The control arbiter over a REAL lock (in-memory better-sqlite3), with the
 * sessions held in memory. What a person taking over depends on, pinned:
 *
 *  - two concurrent take-overs produce exactly one winner, and the loser is
 *    told who holds it;
 *  - give back, idle, the ceiling and a vanished browser each release with
 *    their own reason — at the boundary, never a millisecond early — and a
 *    stale release never evicts a newer holder;
 *  - a stretch extends once; a request declines on its own after a minute;
 *    a hand-over moves control to the requester and nobody else;
 *  - every grant, release and refusal is audited and published.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const AGENT = '22222222-2222-4222-8222-222222222222';
const NODE = '33333333-3333-4333-8333-333333333333';
const VIEW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T0 = new Date('2026-09-14T09:00:00.000Z');

describe('ComputerControlArbiter', () => {
    let dataSource: DataSource;
    let nodes: Repository<FleetNode>;
    let sessions: Map<string, ComputerSession>;
    let arbiter: ComputerControlArbiter;
    let audit: { tryRecord: jest.Mock };
    let changes: ComputerControlChange[];
    let now: Date;

    const actor = (sessionId: string, userId = OWNER) => ({ userId, agentId: AGENT, sessionId });
    const advance = (ms: number) => {
        now = new Date(now.getTime() + ms);
    };
    /** Let time pass while the holder's socket keeps answering its 30 s heartbeat. */
    const advanceConnected = async (sessionId: string, ms: number) => {
        const end = now.getTime() + ms;
        while (now.getTime() + 30_000 < end) {
            advance(30_000);
            await arbiter.acknowledge(sessionId);
        }
        now = new Date(end);
    };

    function addSession(id: string, patch: Partial<ComputerSession> = {}): ComputerSession {
        const row = {
            id,
            userId: OWNER,
            agentId: AGENT,
            nodeId: NODE,
            openedByUserId: OWNER,
            status: 'live',
            controlSpans: [],
            ...patch,
        } as unknown as ComputerSession;
        sessions.set(id, row);
        return row;
    }

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [FleetNode],
            synchronize: true,
        });
        await dataSource.initialize();
        nodes = dataSource.getRepository(FleetNode);
        await nodes.save(
            nodes.create({
                id: NODE,
                userId: OWNER,
                name: 'studio',
                kind: 'desktop-node',
                status: 'online',
                capabilities: ['attended', 'screen'],
            } as Partial<FleetNode>),
        );
        sessions = new Map();
        addSession(VIEW_A);
        addSession(VIEW_B);
        const sessionRepo = {
            findForOwner: jest.fn(async (id: string, userId: string, agentId: string) => {
                const row = sessions.get(id);
                return row && row.userId === userId && row.agentId === agentId ? row : null;
            }),
            findById: jest.fn(async (id: string) => sessions.get(id) ?? null),
            recordInput: jest.fn(async (id: string, at: Date) => {
                const row = sessions.get(id);
                if (row) row.lastInputAt = at;
            }),
            setControlSpans: jest.fn(async (id: string, spans: ComputerSession['controlSpans']) => {
                const row = sessions.get(id);
                if (row) row.controlSpans = spans;
            }),
        };
        audit = { tryRecord: jest.fn(async () => true) };
        changes = [];
        const events = {
            emit: jest.fn((name: string, event: ComputerControlChangedEvent) => {
                expect(name).toBe(ComputerControlChangedEvent.EVENT_NAME);
                changes.push(event.change);
                return true;
            }),
        };
        now = T0;
        arbiter = new ComputerControlArbiter(
            new ComputerControlRepository(nodes),
            sessionRepo as unknown as ComputerSessionRepository,
            audit as never,
            events as never,
        );
        arbiter.clock = () => now;
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const auditActions = () =>
        audit.tryRecord.mock.calls.map(([input]) => (input as { action: string }).action);

    describe('take over', () => {
        it('grants control to a live view, opens a span, audits and publishes it', async () => {
            const outcome = await arbiter.take(actor(VIEW_A));

            expect(outcome).toMatchObject({
                state: {
                    mode: 'controlling',
                    canControl: true,
                    holder: { sessionId: VIEW_A, you: true, thisView: true, extended: false },
                },
            });
            expect(sessions.get(VIEW_A)?.controlSpans).toEqual([
                { userId: OWNER, startedAt: T0.toISOString(), endedAt: null, reason: null },
            ]);
            expect(auditActions()).toEqual(['computer.control-grant']);
            expect(changes).toEqual([
                expect.objectContaining({
                    sessionId: VIEW_A,
                    held: true,
                    untilMs: T0.getTime() + 10 * 60_000,
                    agentId: AGENT,
                }),
            ]);
        });

        it('lets exactly one of two concurrent take-overs win; the loser reads the real holder', async () => {
            const [a, b] = await Promise.all([
                arbiter.take(actor(VIEW_A)),
                arbiter.take(actor(VIEW_B)),
            ]);
            const outcomes = [a, b];
            const winners = outcomes.filter((outcome) => outcome && !('refused' in outcome));
            const losers = outcomes.filter((outcome) => outcome && 'refused' in outcome);

            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            const winnerView = winners[0]?.state.sessionId;
            expect(losers[0]).toMatchObject({
                refused: 'held',
                state: { mode: 'watching', holder: { sessionId: winnerView, thisView: false } },
            });
            expect(auditActions().sort()).toEqual([
                'computer.control-grant',
                'computer.control-refused',
            ]);
        });

        it('is idempotent for the view that already holds control', async () => {
            await arbiter.take(actor(VIEW_A));
            const again = await arbiter.take(actor(VIEW_A));
            expect(again).toMatchObject({ state: { mode: 'controlling' } });
            expect(auditActions()).toEqual(['computer.control-grant']);
        });

        it('refuses a view that is not showing pictures, an ended view, and a foreign view', async () => {
            addSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { status: 'requested' });
            addSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { status: 'ended' });
            expect(await arbiter.take(actor('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).toMatchObject(
                {
                    refused: 'not-live',
                },
            );
            expect(await arbiter.take(actor('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).toMatchObject(
                {
                    refused: 'session-ended',
                },
            );
            expect(await arbiter.take(actor(VIEW_A, STRANGER))).toBeNull();
        });

        it('refuses a person outside the machine’s policy, naming the policy in the audit row', async () => {
            // A view of a machine this person does not own (never reachable through
            // the owner routes today, but the rule is enforced here, not by routing).
            const foreign = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
            addSession(foreign, { userId: OWNER, openedByUserId: STRANGER });
            sessions.get(foreign)!.userId = OWNER;
            const originalFind = (arbiter as unknown as { sessions: { findForOwner: jest.Mock } })
                .sessions.findForOwner;
            originalFind.mockImplementationOnce(async () => sessions.get(foreign));

            const outcome = await arbiter.take(actor(foreign, STRANGER));
            expect(outcome).toMatchObject({
                refused: 'policy',
                state: { canControl: false, policy: 'owner' },
            });
            expect(audit.tryRecord).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'computer.control-refused',
                    details: { sessionId: foreign, policy: 'owner', holderPresent: false },
                }),
            );
        });
    });

    describe('give back and automatic release', () => {
        it('gives control back with its reason, closing the span and publishing the release', async () => {
            await arbiter.take(actor(VIEW_A));
            advance(42_000);
            const outcome = await arbiter.giveBack(actor(VIEW_A));

            expect(outcome).toMatchObject({
                state: { mode: 'watching', holder: null, lastRelease: { reason: 'given-back' } },
            });
            expect(sessions.get(VIEW_A)?.controlSpans?.[0]).toMatchObject({ reason: 'given-back' });
            expect(audit.tryRecord).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    action: 'computer.control-release',
                    details: { sessionId: VIEW_A, releaseReason: 'given-back', heldMs: 42_000 },
                }),
            );
            expect(changes.at(-1)).toMatchObject({
                sessionId: VIEW_A,
                held: false,
                reason: 'given-back',
            });
        });

        it('a view that does not hold control has nothing to give back and evicts nobody', async () => {
            await arbiter.take(actor(VIEW_A));
            const outcome = await arbiter.giveBack(actor(VIEW_B));
            expect(outcome).toMatchObject({ state: { holder: { sessionId: VIEW_A } } });
            expect(auditActions()).toEqual(['computer.control-grant']);
        });

        it('releases for inactivity at 10 minutes exactly, not a millisecond before', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.acknowledge(VIEW_A);
            advance(10 * 60_000 - 1);
            // Keep the browser acknowledged so only inactivity can release.
            await nodes.update({ id: NODE }, { controlAckAt: now });
            expect(await arbiter.getState(actor(VIEW_A))).toMatchObject({ mode: 'controlling' });

            advance(1);
            expect(await arbiter.getState(actor(VIEW_A))).toMatchObject({
                mode: 'watching',
                holder: null,
                lastRelease: { reason: 'idle' },
            });
        });

        it('input pushes the idle deadline, so an active controller is not released', async () => {
            await arbiter.take(actor(VIEW_A));
            await advanceConnected(VIEW_A, 9 * 60_000);
            expect(await arbiter.recordInput(VIEW_A)).toEqual({
                held: true,
                untilMs: now.getTime() + 10 * 60_000,
            });
            expect(sessions.get(VIEW_A)?.lastInputAt).toEqual(now);
            await advanceConnected(VIEW_A, 2 * 60_000);
            expect(await arbiter.holdOf(VIEW_A)).toMatchObject({ held: true });
        });

        it('"Keep control" pushes the idle deadline and publishes the new one', async () => {
            await arbiter.take(actor(VIEW_A));
            await advanceConnected(VIEW_A, 9 * 60_000 + 40_000);
            const outcome = await arbiter.keep(actor(VIEW_A));
            expect(outcome).toMatchObject({ state: { mode: 'controlling' } });
            expect(changes.at(-1)).toMatchObject({
                held: true,
                untilMs: now.getTime() + 10 * 60_000,
            });
            expect(await arbiter.keep(actor(VIEW_B))).toMatchObject({ refused: 'not-holder' });
        });

        it('releases at the 60-minute ceiling however busy the controller is, and extends only once', async () => {
            await arbiter.take(actor(VIEW_A));
            expect(await arbiter.extend(actor(VIEW_A))).toMatchObject({
                state: { holder: { extended: true } },
            });
            expect(await arbiter.extend(actor(VIEW_A))).toMatchObject({
                refused: 'already-extended',
            });

            for (let minute = 5; minute < 120; minute += 5) {
                await advanceConnected(VIEW_A, T0.getTime() + minute * 60_000 - now.getTime());
                expect(await arbiter.recordInput(VIEW_A)).toMatchObject({ held: true });
            }
            await advanceConnected(VIEW_A, T0.getTime() + 120 * 60_000 - now.getTime());
            expect(await arbiter.recordInput(VIEW_A)).toEqual({ held: false, untilMs: null });
            expect(sessions.get(VIEW_A)?.controlSpans?.at(-1)).toMatchObject({ reason: 'ceiling' });
        });

        it('releases a hold nobody acknowledged past the floor as disconnected', async () => {
            await arbiter.take(actor(VIEW_A));
            advance(arbiter.limits().ackFloorMs - 1);
            expect(await arbiter.holdOf(VIEW_A)).toMatchObject({ held: true });
            advance(1);
            expect(await arbiter.holdOf(VIEW_A)).toEqual({ held: false, untilMs: null });
            expect(changes.at(-1)).toMatchObject({ held: false, reason: 'disconnected' });
        });

        it('releases when the gateway reports the controller’s socket gone, and when the view ends', async () => {
            await arbiter.take(actor(VIEW_A));
            expect(await arbiter.releaseForSession(VIEW_A, 'disconnected')).toBe(true);
            expect(await arbiter.releaseForSession(VIEW_A, 'disconnected')).toBe(false);

            await arbiter.take(actor(VIEW_B));
            sessions.get(VIEW_B)!.status = 'ended';
            // The ended view's hold is settled on the next read, by anyone.
            expect(await arbiter.getState(actor(VIEW_A))).toMatchObject({ holder: null });
            expect(changes.at(-1)).toMatchObject({ sessionId: VIEW_B, reason: 'session-ended' });
        });

        it('a release decided late never evicts the view that took control since', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.giveBack(actor(VIEW_A));
            await arbiter.take(actor(VIEW_B));
            expect(await arbiter.releaseForSession(VIEW_A, 'disconnected')).toBe(false);
            expect(await arbiter.holdOf(VIEW_B)).toMatchObject({ held: true });
        });
    });

    describe('request and hand over', () => {
        it('refuses a request when nobody holds control (take it instead)', async () => {
            expect(await arbiter.request(actor(VIEW_B))).toMatchObject({ refused: 'not-held' });
        });

        it('shows a request to the holder, hands control over, and releases the holder as handed-over', async () => {
            await arbiter.take(actor(VIEW_A));
            advance(5000);
            expect(await arbiter.request(actor(VIEW_B))).toMatchObject({
                state: { request: { requestId: VIEW_B, you: true }, mode: 'watching' },
            });
            const holderState = await arbiter.getState(actor(VIEW_A));
            expect(holderState?.request).toMatchObject({
                requestId: VIEW_B,
                you: false,
                expiresAt: new Date(now.getTime() + 60_000).toISOString(),
            });

            advance(1000);
            const outcome = await arbiter.answer(actor(VIEW_A), VIEW_B, 'hand-over');
            expect(outcome).toMatchObject({
                state: {
                    mode: 'watching',
                    holder: { sessionId: VIEW_B },
                    request: null,
                    lastRelease: { reason: 'handed-over' },
                },
            });
            expect(await arbiter.getState(actor(VIEW_B))).toMatchObject({ mode: 'controlling' });
            expect(changes.slice(-2)).toEqual([
                expect.objectContaining({ sessionId: VIEW_A, held: false, reason: 'handed-over' }),
                expect.objectContaining({ sessionId: VIEW_B, held: true }),
            ]);
        });

        it('declines on its own after 60 seconds, after which it cannot be handed over', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.request(actor(VIEW_B));
            advance(59_999);
            expect((await arbiter.getState(actor(VIEW_B)))?.request).not.toBeNull();
            advance(1);
            expect((await arbiter.getState(actor(VIEW_B)))?.request).toBeNull();
            expect(await arbiter.answer(actor(VIEW_A), VIEW_B, 'hand-over')).toMatchObject({
                refused: 'no-request',
            });
            expect(await arbiter.holdOf(VIEW_A)).toMatchObject({ held: true });
        });

        it('keeps control when the holder says so, and never transfers it silently', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.request(actor(VIEW_B));
            expect(await arbiter.answer(actor(VIEW_A), VIEW_B, 'keep')).toMatchObject({
                state: { mode: 'controlling', request: null },
            });
            expect(await arbiter.holdOf(VIEW_B)).toMatchObject({ held: false });
        });

        it('only the holder can answer, and a second request waits for the first', async () => {
            await arbiter.take(actor(VIEW_A));
            const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
            addSession(third);
            await arbiter.request(actor(VIEW_B));
            expect(await arbiter.request(actor(third))).toMatchObject({
                refused: 'already-requested',
            });
            expect(await arbiter.answer(actor(VIEW_B), VIEW_B, 'hand-over')).toMatchObject({
                refused: 'not-holder',
            });
        });

        it('a hand-over racing the holder giving back never leaves two holders', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.request(actor(VIEW_B));
            await Promise.all([
                arbiter.answer(actor(VIEW_A), VIEW_B, 'hand-over'),
                arbiter.giveBack(actor(VIEW_A)),
            ]);
            const a = await arbiter.holdOf(VIEW_A);
            const b = await arbiter.holdOf(VIEW_B);
            expect(a.held && b.held).toBe(false);
            expect(a.held).toBe(false);
        });

        it('withdraws a request whose view ended', async () => {
            await arbiter.take(actor(VIEW_A));
            await arbiter.request(actor(VIEW_B));
            sessions.get(VIEW_B)!.status = 'ended';
            expect((await arbiter.getState(actor(VIEW_A)))?.request).toBeNull();
        });
    });
});

describe('control spans', () => {
    const T = new Date('2026-09-14T09:00:00.000Z');

    it('appends an open span and caps the list at 50', () => {
        const many = Array.from({ length: 50 }, (_, index) => ({
            userId: `u${index}`,
            startedAt: T.toISOString(),
            endedAt: T.toISOString(),
            reason: 'given-back' as const,
        }));
        const next = openSpan(many, 'latest', T);
        expect(next).toHaveLength(50);
        expect(next.at(-1)).toMatchObject({ userId: 'latest', endedAt: null });
        expect(next[0].userId).toBe('u1');
    });

    it('closes only the newest open span, and reports nothing to close otherwise', () => {
        const spans = openSpan([], 'u1', T);
        expect(closeSpan(spans, T, 'idle')?.[0]).toMatchObject({
            reason: 'idle',
            endedAt: T.toISOString(),
        });
        expect(closeSpan(closeSpan(spans, T, 'idle'), T, 'ceiling')).toBeNull();
        expect(closeSpan(null, T, 'idle')).toBeNull();
    });
});
