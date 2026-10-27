import { DataSource, type Repository } from 'typeorm';
import type { ComputerSession } from '../../entities/computer-session.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { ComputerControlRepository } from '../computer-control.repository';
import type { ComputerSessionRepository } from '../computer-session.repository';
import { ComputerControlArbiter, type ComputerControlActor } from '../control-arbiter.service';

/**
 * Desktop view & control (FL-07 P2, T-32, FR-36, FR-41) — the arbiter over a
 * REAL lock for Desktop-source views: rows with no Agent, found by who opened
 * them; the SAME one lock per machine an Agent's browser view takes; every act
 * audited `node.desktop.control.*` (never also `computer.*`).
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const NODE = '33333333-3333-4333-8333-333333333333';
const DESKTOP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESKTOP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BROWSER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T0 = new Date('2026-10-27T09:00:00.000Z');

describe('ComputerControlArbiter — Desktop views', () => {
    let dataSource: DataSource;
    let nodes: Repository<FleetNode>;
    let sessions: Map<string, ComputerSession>;
    let arbiter: ComputerControlArbiter;
    let audit: { tryRecord: jest.Mock };
    let now: Date;

    const desktop = (sessionId: string, userId = OWNER): ComputerControlActor => ({
        userId,
        agentId: '',
        sessionId,
        source: 'desktop',
    });

    function addSession(id: string, patch: Partial<ComputerSession>): void {
        sessions.set(id, {
            id,
            userId: OWNER,
            nodeId: NODE,
            openedByUserId: OWNER,
            status: 'live',
            controlSpans: [],
            ...patch,
        } as unknown as ComputerSession);
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
                kind: 'node',
                status: 'online',
                capabilities: ['attended', 'screen:desktop'],
            } as Partial<FleetNode>),
        );
        sessions = new Map();
        addSession(DESKTOP_A, { agentId: null, source: 'desktop' });
        addSession(DESKTOP_B, { agentId: null, source: 'desktop' });
        addSession(BROWSER, { agentId: AGENT, source: 'browser' });
        const sessionRepo = {
            findForOwner: jest.fn(async (id: string, userId: string, agentId: string) => {
                const row = sessions.get(id);
                return row && row.userId === userId && row.agentId === agentId ? row : null;
            }),
            findDesktopViewFor: jest.fn(async (id: string, openedByUserId: string) => {
                const row = sessions.get(id);
                return row &&
                    row.openedByUserId === openedByUserId &&
                    row.source === 'desktop' &&
                    !row.agentId
                    ? row
                    : null;
            }),
            findById: jest.fn(async (id: string) => sessions.get(id) ?? null),
            recordInput: jest.fn(async () => undefined),
            setControlSpans: jest.fn(async (id: string, spans: ComputerSession['controlSpans']) => {
                const row = sessions.get(id);
                if (row) row.controlSpans = spans;
            }),
        };
        audit = { tryRecord: jest.fn(async () => true) };
        now = T0;
        arbiter = new ComputerControlArbiter(
            new ComputerControlRepository(nodes),
            sessionRepo as unknown as ComputerSessionRepository,
            audit as never,
            { emit: jest.fn(() => true) } as never,
        );
        arbiter.clock = () => now;
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const audited = () =>
        audit.tryRecord.mock.calls.map(
            ([input]) => input as { action: string; details: Record<string, unknown> },
        );

    it('finds a desktop view by who opened it — and nobody else’s', async () => {
        expect(await arbiter.getState(desktop(DESKTOP_A))).toMatchObject({
            sessionId: DESKTOP_A,
            mode: 'watching',
        });
        expect(
            await arbiter.getState(desktop(DESKTOP_A, '99999999-9999-4999-8999-999999999999')),
        ).toBeNull();
        // An Agent's browser view is never reachable as a desktop one.
        expect(await arbiter.getState(desktop(BROWSER))).toBeNull();
    });

    it('takes the ONE lock of the machine, audited node.desktop.control.take (class confirm)', async () => {
        const taken = await arbiter.take(desktop(DESKTOP_A));
        expect(taken && 'refused' in taken).toBe(false);
        expect(taken?.state.mode).toBe('controlling');
        const row = audited().find((entry) => entry.action === 'node.desktop.control.take');
        expect(row?.details).toMatchObject({
            family: 'desktop',
            target: DESKTOP_A,
            requestedBy: `user:${OWNER}`,
            confirmationClass: 'confirm',
            outcome: 'granted',
        });
        expect(audited().some((entry) => entry.action.startsWith('computer.'))).toBe(false);
        // The machine is held: an Agent's browser view of the same machine cannot take it.
        const browser = await arbiter.take({ userId: OWNER, agentId: AGENT, sessionId: BROWSER });
        expect(browser).toMatchObject({ refused: 'held' });
    });

    it('audits a request and the hand-over that follows (release, then take)', async () => {
        await arbiter.take(desktop(DESKTOP_A));
        const asked = await arbiter.request(desktop(DESKTOP_B));
        expect(asked && 'refused' in asked).toBe(false);
        expect(audited().map((entry) => entry.action)).toContain('node.desktop.control.request');
        const handed = await arbiter.answer(desktop(DESKTOP_A), DESKTOP_B, 'hand-over');
        expect(handed?.state.mode).toBe('watching');
        expect((await arbiter.holdOf(DESKTOP_B)).held).toBe(true);
        const release = audited().find((entry) => entry.action === 'node.desktop.control.release');
        expect(release?.details).toMatchObject({
            target: DESKTOP_A,
            outcome: 'released',
            releaseReason: 'handed-over',
        });
    });

    it('gives back with its own audit row, and an automatic release names the system', async () => {
        await arbiter.take(desktop(DESKTOP_A));
        await arbiter.giveBack(desktop(DESKTOP_A));
        expect(
            audited().filter((entry) => entry.action === 'node.desktop.control.release'),
        ).toHaveLength(1);
        await arbiter.take(desktop(DESKTOP_A));
        expect(await arbiter.releaseForSession(DESKTOP_A, 'disconnected')).toBe(true);
        const last = audited()
            .filter((entry) => entry.action === 'node.desktop.control.release')
            .pop();
        expect(last?.details).toMatchObject({
            requestedBy: 'system:control-arbiter',
            releaseReason: 'disconnected',
        });
    });
});
