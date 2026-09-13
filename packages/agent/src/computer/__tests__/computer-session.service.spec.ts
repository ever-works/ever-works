import type { FleetNodeView } from '@ever-works/contracts';
import { COMPUTER_CLOSE_REASONS } from '@ever-works/contracts';
import type { ComputerSession } from '../../entities/computer-session.entity';
import {
    ComputerSessionEndedEvent,
    ComputerSessionService,
    orderNodeOptions,
    toNodeOption,
} from '../computer-session.service';

/**
 * The live-view session lifecycle. What an owner depends on, pinned:
 *
 *  - opening a view refuses honestly (stopped fleet, no machines, a machine
 *    that cannot be watched, the caps) and never enqueues a job it refused;
 *  - a view is always pinned to the machine it names, bound to a Run once;
 *  - an unclaimed view is abandoned inline so it cannot hold a slot;
 *  - a close happens once: one audit row, one `ended` event, one job withdrawal.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = { id: '22222222-2222-4222-8222-222222222222', name: 'Ops', organizationId: 'org-1' };
const NODE_A = '33333333-3333-4333-8333-333333333333';
const NODE_B = '44444444-4444-4444-8444-444444444444';

function nodeView(id: string, overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id,
        name: id === NODE_A ? 'studio' : 'build-box',
        kind: 'desktop-node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: ['browser', 'screen', 'attended', 'terminal'],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: null,
        persisted: true,
        ...overrides,
    };
}

function build(
    options: { nodes?: FleetNodeView[]; stopped?: boolean; boundNodeId?: string | null } = {},
) {
    const rows = new Map<string, ComputerSession>();
    let seq = 0;
    let lockTail: Promise<unknown> = Promise.resolve();
    const sessions = {
        create: jest.fn(async (data: Partial<ComputerSession>) => {
            const row = {
                id: `session-${++seq}`,
                createdAt: new Date(),
                frameCount: 0,
                bytesOut: 0,
                recorded: false,
                ...data,
            } as ComputerSession;
            rows.set(row.id, row);
            return row;
        }),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        findForOwner: jest.fn(async (id: string, userId: string, agentId: string) => {
            const row = rows.get(id);
            return row && row.userId === userId && row.agentId === agentId ? row : null;
        }),
        findForNode: jest.fn(async (id: string, nodeId: string) => {
            const row = rows.get(id);
            return row && row.nodeId === nodeId ? row : null;
        }),
        findOpenForNode: jest.fn(async (nodeId: string) =>
            [...rows.values()].filter((row) => row.nodeId === nodeId && row.status !== 'ended'),
        ),
        findOpenForScope: jest.fn(async () =>
            [...rows.values()].filter((row) => row.status !== 'ended'),
        ),
        findOpenForOwner: jest.fn(async (userId: string) =>
            [...rows.values()].filter((row) => row.userId === userId && row.status !== 'ended'),
        ),
        // A real mutex: each critical section runs to completion before the next starts.
        withAdmissionLock: jest.fn(async (_keys: unknown, fn: () => Promise<unknown>) => {
            const run = lockTail.then(fn);
            lockTail = run.catch(() => undefined);
            return run;
        }),
        findPendingIdsForNode: jest.fn(async (nodeId: string) =>
            [...rows.values()]
                .filter((r) => r.nodeId === nodeId && r.status === 'requested')
                .map((r) => r.id),
        ),
        setFleetJob: jest.fn(async (id: string, jobId: string) => {
            (rows.get(id) as ComputerSession).fleetJobId = jobId;
        }),
        updateOpen: jest.fn(async (id: string, patch: Partial<ComputerSession>) => {
            const row = rows.get(id);
            if (!row || row.status === 'ended') return false;
            Object.assign(row, patch);
            return true;
        }),
        recordFrames: jest.fn(async (id: string, frames: number) => {
            const row = rows.get(id) as ComputerSession;
            row.frameCount += frames;
            const becameLive = row.status === 'requested' || row.status === 'stalled';
            if (becameLive) row.status = 'live';
            return { becameLive };
        }),
        markStalled: jest.fn(async () => true),
        bindRun: jest.fn(async (id: string, runId: string) => {
            const row = rows.get(id) as ComputerSession;
            if (row.runId) return false;
            row.runId = runId;
            return true;
        }),
        close: jest.fn(async (id: string, patch: Partial<ComputerSession>) => {
            const row = rows.get(id);
            if (!row || row.status === 'ended') return false;
            Object.assign(row, patch, { status: 'ended' });
            return true;
        }),
    };
    const fleet = {
        listForUser: jest.fn(async () => options.nodes ?? [nodeView(NODE_A)]),
        listEnrolledForUser: jest.fn(async () => options.nodes ?? [nodeView(NODE_A)]),
    };
    const affinities = {
        findForOwnedAgent: jest.fn(async () =>
            options.boundNodeId ? { nodeId: options.boundNodeId } : null,
        ),
    };
    const jobs = { findActiveForUser: jest.fn(async () => [] as unknown[]) };
    const profiles = { ensure: jest.fn(async () => ({ profileKey: 'opaque-key' })) };
    const killSwitch = {
        isStopped: jest.fn(async () => Boolean(options.stopped)),
        publicState: jest.fn(async () => ({
            stopped: Boolean(options.stopped),
            reason: 'Investigating a runaway job',
            since: '2026-09-13T08:55:00.000Z',
            unverified: false,
        })),
    };
    const audit = { tryRecord: jest.fn(async (_input: unknown) => true) };
    const dispatcher = {
        enqueue: jest.fn(async () => ({ jobId: 'job-1' })),
        cancel: jest.fn(async () => true),
    };
    const events = { emit: jest.fn() };
    const service = new ComputerSessionService(
        sessions as never,
        fleet as never,
        affinities as never,
        jobs as never,
        profiles as never,
        killSwitch as never,
        audit as never,
        dispatcher as never,
        events as never,
    );
    return { service, sessions, rows, fleet, jobs, profiles, audit, dispatcher, events };
}

describe('ComputerSessionService.open', () => {
    it('opens a requested view pinned to the machine, with the Agent profile key and an audit row', async () => {
        const { service, dispatcher, audit } = build();

        const outcome = await service.open({ userId: USER, agent: AGENT });

        expect('opened' in outcome).toBe(true);
        const view = (outcome as { opened: { status: string; nodeId: string; quality: string } })
            .opened;
        expect(view).toMatchObject({ status: 'requested', nodeId: NODE_A, quality: 'sharp' });
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                nodeId: NODE_A,
                profileKey: 'opaque-key',
                channels: ['screen'],
            }),
        );
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'computer.session-open', nodeId: NODE_A }),
        );
    });

    it('refuses while the fleet stop switch is on, carrying the stop reason, and enqueues nothing', async () => {
        const { service, dispatcher } = build({ stopped: true });

        const outcome = await service.open({ userId: USER, agent: AGENT });

        expect(outcome).toMatchObject({
            refused: 'stopped',
            stop: { reason: 'Investigating a runaway job' },
        });
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('refuses with no-nodes when the owner has no machine', async () => {
        const { service } = build({ nodes: [] });
        expect(await service.open({ userId: USER, agent: AGENT })).toEqual({ refused: 'no-nodes' });
    });

    it('answers node-not-found for a machine the owner does not have', async () => {
        const { service } = build();
        expect(await service.open({ userId: USER, agent: AGENT, nodeId: NODE_B })).toEqual({
            refused: 'node-not-found',
        });
    });

    it.each<[Partial<FleetNodeView>, string]>([
        [{ status: 'offline' }, 'offline'],
        [{ status: 'paused' }, 'paused'],
        [{ status: 'disabled' }, 'disabled'],
        [{ capabilities: ['browser', 'screen'] }, 'not-attended'],
        [{ capabilities: ['attended'] }, 'no-browser'],
    ])('refuses a machine that cannot be watched (%o → %s)', async (overrides, reason) => {
        const { service, dispatcher } = build({ nodes: [nodeView(NODE_A, overrides)] });

        expect(await service.open({ userId: USER, agent: AGENT, nodeId: NODE_A })).toEqual({
            refused: 'node-unwatchable',
            nodeId: NODE_A,
            reason,
        });
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('prefers the machine the Agent is pinned to when none is named', async () => {
        const { service } = build({
            nodes: [nodeView(NODE_A), nodeView(NODE_B)],
            boundNodeId: NODE_B,
        });
        const outcome = await service.open({ userId: USER, agent: AGENT });
        expect((outcome as { opened: { nodeId: string } }).opened.nodeId).toBe(NODE_B);
    });

    it('refuses a channel the machine cannot serve, naming why', async () => {
        const { service, dispatcher } = build({
            nodes: [nodeView(NODE_A, { capabilities: ['screen', 'attended'] })],
        });
        expect(await service.open({ userId: USER, agent: AGENT, channels: ['terminal'] })).toEqual({
            refused: 'channel-unavailable',
            nodeId: NODE_A,
            channel: 'terminal',
            reason: 'no-terminal',
        });
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('opens a terminal-only view on a machine with no display, and refuses its screen', async () => {
        const headless = nodeView(NODE_A, { capabilities: ['terminal', 'workspace', 'attended'] });
        const { service, dispatcher } = build({ nodes: [headless] });

        const terminal = await service.open({ userId: USER, agent: AGENT, channels: ['terminal'] });
        expect((terminal as { opened: { channels: string[] } }).opened.channels).toEqual([
            'terminal',
        ]);
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ channels: ['terminal'] }),
        );

        expect(await service.open({ userId: USER, agent: AGENT, channels: ['screen'] })).toEqual({
            refused: 'channel-unavailable',
            nodeId: NODE_A,
            channel: 'screen',
            reason: 'no-browser',
        });
    });

    it('defaults to the terminal when the machine cannot show a screen', async () => {
        const headless = nodeView(NODE_A, { capabilities: ['terminal', 'browser', 'attended'] });
        const { service } = build({ nodes: [headless] });
        const outcome = await service.open({ userId: USER, agent: AGENT });
        expect(
            (outcome as { opened: { channels: string[]; activeChannel: string } }).opened,
        ).toMatchObject({
            channels: ['terminal'],
            activeChannel: 'terminal',
        });
    });

    it('opens the pinned machine and refuses with ITS reason rather than swapping machines', async () => {
        const { service, dispatcher } = build({
            nodes: [nodeView(NODE_A), nodeView(NODE_B, { status: 'offline' })],
            boundNodeId: NODE_B,
        });
        expect(await service.open({ userId: USER, agent: AGENT })).toEqual({
            refused: 'node-unwatchable',
            nodeId: NODE_B,
            reason: 'offline',
        });
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('enforces two views per machine and names the existing holders', async () => {
        const { service } = build();
        await service.open({ userId: USER, agent: AGENT });
        await service.open({ userId: USER, agent: AGENT });

        const third = await service.open({ userId: USER, agent: AGENT });

        expect(third).toMatchObject({ refused: 'node-session-cap', limit: 2 });
        expect((third as { sessions: unknown[] }).sessions).toHaveLength(2);
    });

    it('enforces the per-Organization cap across machines', async () => {
        const saved = process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION;
        process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION = '1';
        try {
            const { service } = build({ nodes: [nodeView(NODE_A), nodeView(NODE_B)] });
            await service.open({ userId: USER, agent: AGENT, nodeId: NODE_A });
            expect(
                await service.open({ userId: USER, agent: AGENT, nodeId: NODE_B }),
            ).toMatchObject({
                refused: 'organization-session-cap',
                limit: 1,
            });
        } finally {
            if (saved === undefined) delete process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION;
            else process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION = saved;
        }
    });

    it('abandons an unclaimed view inline, so it no longer holds a slot', async () => {
        const { service, rows, dispatcher } = build();
        await service.open({ userId: USER, agent: AGENT });
        await service.open({ userId: USER, agent: AGENT });
        for (const row of rows.values()) row.createdAt = new Date(Date.now() - 41_000);

        const outcome = await service.open({ userId: USER, agent: AGENT });

        expect('opened' in outcome).toBe(true);
        expect([...rows.values()].filter((row) => row.closeReason === 'abandoned')).toHaveLength(2);
        expect(dispatcher.cancel).toHaveBeenCalledTimes(2);
    });

    it('does not let another member’s abandoned view hold an Organization slot', async () => {
        const saved = process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION;
        process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION = '1';
        try {
            const { service, rows, dispatcher } = build({
                nodes: [nodeView(NODE_A), nodeView(NODE_B)],
            });
            rows.set('stale-of-another-member', {
                id: 'stale-of-another-member',
                userId: 'another-member',
                organizationId: AGENT.organizationId,
                agentId: AGENT.id,
                nodeId: NODE_B,
                openedByUserId: 'another-member',
                status: 'requested',
                fleetJobId: 'job-stale',
                createdAt: new Date(Date.now() - 41_000),
                frameCount: 0,
                bytesOut: 0,
            } as ComputerSession);

            const outcome = await service.open({ userId: USER, agent: AGENT, nodeId: NODE_A });

            expect('opened' in outcome).toBe(true);
            expect(rows.get('stale-of-another-member')).toMatchObject({
                status: 'ended',
                closeReason: 'abandoned',
            });
            expect(dispatcher.cancel).toHaveBeenCalledWith('job-stale');
        } finally {
            if (saved === undefined) delete process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION;
            else process.env.COMPUTER_SESSION_MAX_PER_ORGANIZATION = saved;
        }
    });

    it('never names a due view as a holder, even when another caller already ended it', async () => {
        const { service, rows, sessions } = build();
        await service.open({ userId: USER, agent: AGENT });
        await service.open({ userId: USER, agent: AGENT });
        for (const row of rows.values()) row.createdAt = new Date(Date.now() - 41_000);
        // Another replica's close wins every race: this caller's CAS never lands.
        sessions.close.mockResolvedValue(false);

        const outcome = await service.open({ userId: USER, agent: AGENT });

        expect('opened' in outcome).toBe(true);
    });

    it('serializes admission, so a burst of opens cannot walk past the per-machine cap', async () => {
        const { service, sessions, dispatcher } = build();

        const outcomes = await Promise.all(
            Array.from({ length: 5 }, () => service.open({ userId: USER, agent: AGENT })),
        );

        expect(outcomes.filter((outcome) => 'opened' in outcome)).toHaveLength(2);
        expect(
            outcomes.filter(
                (outcome) => (outcome as { refused?: string }).refused === 'node-session-cap',
            ),
        ).toHaveLength(3);
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        expect(sessions.withAdmissionLock).toHaveBeenCalledWith(
            { nodeId: NODE_A, scopeKey: `org:${AGENT.organizationId}` },
            expect.any(Function),
        );
    });

    it('locks a personal workspace’s admission on its owner', async () => {
        const { service, sessions } = build();
        await service.open({ userId: USER, agent: { ...AGENT, organizationId: null } });
        expect(sessions.withAdmissionLock).toHaveBeenCalledWith(
            { nodeId: NODE_A, scopeKey: `user:${USER}` },
            expect.any(Function),
        );
    });

    it('reports dispatcher-unavailable when no fleet runtime is wired', async () => {
        const { service } = build();
        (service as unknown as { dispatcher: undefined }).dispatcher = undefined;
        expect(await service.open({ userId: USER, agent: AGENT })).toEqual({
            refused: 'dispatcher-unavailable',
        });
    });

    it('ends the row as `error` and rethrows when the enqueue fails', async () => {
        const { service, rows, dispatcher } = build();
        dispatcher.enqueue.mockRejectedValueOnce(new Error('queue down'));

        await expect(service.open({ userId: USER, agent: AGENT })).rejects.toThrow('queue down');
        expect([...rows.values()][0]).toMatchObject({ status: 'ended', closeReason: 'error' });
    });
});

describe('ComputerSessionService lifecycle', () => {
    async function opened() {
        const ctx = build();
        const outcome = await ctx.service.open({ userId: USER, agent: AGENT });
        const id = (outcome as { opened: { id: string } }).opened.id;
        return { ...ctx, id, row: ctx.rows.get(id) as ComputerSession };
    }

    it('goes live on the first picture and binds the Run in flight exactly once', async () => {
        const { service, jobs, row } = await opened();
        jobs.findActiveForUser.mockResolvedValue([
            { nodeId: NODE_A, kind: 'agent-task', payload: { agentId: AGENT.id, runId: 'run-1' } },
        ]);

        await service.recordPublished(row, { frames: 2, bytes: 100 });
        jobs.findActiveForUser.mockResolvedValue([
            { nodeId: NODE_A, kind: 'agent-task', payload: { agentId: AGENT.id, runId: 'run-2' } },
        ]);
        row.status = 'stalled';
        await service.recordPublished(row, { frames: 1, bytes: 10 });

        expect(row.status).toBe('live');
        expect(row.runId).toBe('run-1');
    });

    it('does not bind a Run of another Agent, or of another machine', async () => {
        const { service, jobs, row } = await opened();
        jobs.findActiveForUser.mockResolvedValue([
            { nodeId: NODE_A, kind: 'agent-task', payload: { agentId: 'other', runId: 'run-x' } },
            { nodeId: NODE_B, kind: 'agent-task', payload: { agentId: AGENT.id, runId: 'run-y' } },
        ]);
        await service.recordPublished(row, { frames: 1, bytes: 1 });
        expect(row.runId ?? null).toBeNull();
    });

    it('closes once: one audit row, one ended event, one job withdrawal', async () => {
        const { service, audit, events, dispatcher, id } = await opened();

        expect(await service.closeForOwner(USER, AGENT.id, id)).toBe(true);
        expect(await service.closeForOwner(USER, AGENT.id, id)).toBe(true);

        const closes = audit.tryRecord.mock.calls.filter(
            ([input]) => (input as { action: string }).action === 'computer.session-close',
        );
        expect(closes).toHaveLength(1);
        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(events.emit.mock.calls[0][1]).toBeInstanceOf(ComputerSessionEndedEvent);
        expect(dispatcher.cancel).toHaveBeenCalledWith('job-1');
    });

    it('never lets another owner read, change or close a session', async () => {
        const { service, id } = await opened();
        expect(await service.getForOwner('someone-else', AGENT.id, id)).toBeNull();
        expect(
            await service.updateForOwner('someone-else', AGENT.id, id, { quality: 'steady' }),
        ).toBeNull();
        expect(await service.closeForOwner('someone-else', AGENT.id, id)).toBe(false);
    });

    it('changes quality, but only to a channel the session asked for', async () => {
        const { service, id } = await opened();
        const view = await service.updateForOwner(USER, AGENT.id, id, {
            quality: 'steady',
            activeChannel: 'terminal',
        });
        expect(view).toMatchObject({ quality: 'steady', activeChannel: 'screen' });
    });

    it('accepts only whitelisted close reasons from a node report', async () => {
        const { service, row } = await opened();
        await service.recordNodeReport(row, { status: 'ended', closeReason: 'closed-by-user' });
        expect(row.closeReason).toBe('node-unavailable');
    });

    it('ends a still-requested view as abandoned when its job settles on its own', async () => {
        const { service, id, rows } = await opened();
        await service.closeForSettledJob(id);
        expect(rows.get(id)).toMatchObject({ status: 'ended', closeReason: 'abandoned' });
    });

    it('lists pending sessions for the heartbeat hint', async () => {
        const { service, id } = await opened();
        expect(await service.pendingForNode(NODE_A)).toEqual([id]);
        expect(await service.pendingForNode(NODE_B)).toEqual([]);
    });

    it('expires every view on the machine before hinting, whoever opened it', async () => {
        const { service, id, rows, dispatcher } = await opened();
        const row = rows.get(id) as ComputerSession;
        row.userId = 'another-member';
        row.createdAt = new Date(Date.now() - 41_000);

        expect(await service.pendingForNode(NODE_A)).toEqual([]);
        expect(row).toMatchObject({ status: 'ended', closeReason: 'abandoned' });
        expect(dispatcher.cancel).toHaveBeenCalledWith('job-1');
    });

    it('expires a due view for the machine-facing routes, and leaves a fresh one alone', async () => {
        const { service, row } = await opened();
        expect(await service.expireIfDue(row)).toBe(row);
        expect(row.status).toBe('requested');

        row.createdAt = new Date(Date.now() - 41_000);
        expect(await service.expireIfDue(row)).toMatchObject({
            status: 'ended',
            closeReason: 'abandoned',
        });
    });

    describe('a lease of the job a view rides on', () => {
        it('withdraws the lease when the view was never claimed in time, ending it as abandoned', async () => {
            const { service, id, row, dispatcher } = await opened();
            row.createdAt = new Date(Date.now() - 41_000);

            expect(await service.withdrawLeaseIfOver(id, 'job-1')).toBe(true);
            expect(row).toMatchObject({ status: 'ended', closeReason: 'abandoned' });
            expect(dispatcher.cancel).toHaveBeenCalledTimes(1);
            expect(dispatcher.cancel).toHaveBeenCalledWith('job-1');
        });

        it('withdraws the lease of a view that already ended, or no longer exists', async () => {
            const { service, id, dispatcher } = await opened();
            await service.closeForOwner(USER, AGENT.id, id);
            dispatcher.cancel.mockClear();

            expect(await service.withdrawLeaseIfOver(id, 'job-1')).toBe(true);
            expect(await service.withdrawLeaseIfOver('gone', 'job-9')).toBe(true);
            expect(dispatcher.cancel.mock.calls).toEqual([['job-1'], ['job-9']]);
        });

        it('withdraws a lease that won the race against the job id being recorded', async () => {
            const { service, id, row, dispatcher } = await opened();
            row.fleetJobId = null;
            row.createdAt = new Date(Date.now() - 41_000);
            dispatcher.cancel.mockClear();

            expect(await service.withdrawLeaseIfOver(id, 'job-1')).toBe(true);
            expect(dispatcher.cancel).toHaveBeenCalledWith('job-1');
        });

        it('keeps the lease of a view still within its time, and ignores a job that is not the view’s', async () => {
            const { service, id, row, dispatcher } = await opened();

            expect(await service.withdrawLeaseIfOver(id, 'job-1')).toBe(false);
            row.createdAt = new Date(Date.now() - 41_000);
            expect(await service.withdrawLeaseIfOver(id, 'some-other-job')).toBe(false);
            expect(row.status).toBe('requested');
            expect(dispatcher.cancel).not.toHaveBeenCalled();
        });
    });

    it.each([...COMPUTER_CLOSE_REASONS])('can end a session with %s', async (reason) => {
        const { service, row, audit } = await opened();
        expect(await service.close(row, reason, null)).toBe(true);
        expect(row.closeReason).toBe(reason);
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'computer.session-close',
                details: expect.objectContaining({ closeReason: reason }),
            }),
        );
    });

    it('ends a live view as node-unavailable when its job settles on its own', async () => {
        const { service, id, rows, row } = await opened();
        row.status = 'live';
        await service.closeForSettledJob(id);
        expect(rows.get(id)).toMatchObject({ status: 'ended', closeReason: 'node-unavailable' });
    });

    it('takes a node-restarted report from the machine at its word', async () => {
        const { service, row } = await opened();
        await service.recordNodeReport(row, { status: 'ended', closeReason: 'node-restarted' });
        expect(row.closeReason).toBe('node-restarted');
    });
});

describe('node options', () => {
    it('orders the pinned machine first, then online by latest heartbeat, then the rest', () => {
        const older = new Date(Date.now() - 60_000).toISOString();
        const newer = new Date().toISOString();
        const options = orderNodeOptions([
            toNodeOption(nodeView('offline-1', { status: 'offline' }), 'pinned'),
            toNodeOption(nodeView('online-old', { lastHeartbeatAt: older }), 'pinned'),
            toNodeOption(nodeView('online-new', { lastHeartbeatAt: newer }), 'pinned'),
            toNodeOption(nodeView('pinned', { status: 'offline' }), 'pinned'),
        ]);
        expect(options.map((option) => option.id)).toEqual([
            'pinned',
            'online-new',
            'online-old',
            'offline-1',
        ]);
        expect(options[0].boundToAgent).toBe(true);
    });

    it('lists a display-less machine as watchable on its terminal, with the screen reason beside it', () => {
        const option = toNodeOption(
            nodeView('h', { capabilities: ['terminal', 'workspace', 'attended'] }),
            null,
        );
        expect(option).toMatchObject({
            watchable: true,
            unwatchableReason: null,
            servableChannels: ['terminal'],
            channelReasons: { screen: 'no-browser' },
        });
    });

    it('lists a cluster node as unwatchable rather than hiding it', () => {
        const option = toNodeOption(nodeView('k', { kind: 'k8s', persisted: false }), null);
        expect(option).toMatchObject({
            watchable: false,
            unwatchableReason: 'cluster',
            controlPolicy: 'owner',
        });
    });
});
