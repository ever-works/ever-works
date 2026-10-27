import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
    FLEET_SESSION_MAX_OWNER_PER_NODE,
    type FleetSessionEventMessage,
} from '@ever-works/contracts';
import type { FleetNode } from '../../../entities/fleet-node.entity';
import type { FleetSession } from '../../../entities/fleet-session.entity';
import { readFleetSessionError, fleetSessionError } from '../fleet-session.errors';
import type { FleetSessionNodePort, FleetSessionNodeRequest } from '../fleet-session-node.port';
import {
    defaultFleetSessionTitle,
    fleetSessionFolderTitle,
    FleetSessionService,
} from '../fleet-session.service';

/**
 * FL-04 — `FleetSessionService`, the one writer of `fleet_sessions`, against
 * in-memory fakes of its repository, the node registry, the access check,
 * the kill switch, the audit writer and the node port.
 *
 * What is pinned: every refusal reaches the caller as its CONTRACTS §8 code;
 * an owner session's row is written only after the machine said the process
 * runs (no phantom rows), and a start that lost the admission race ends the
 * process it started; end needs `confirm`, ends an unreachable machine's
 * session platform-side and is idempotent; node reports move rows, early
 * reports wait for their row, ended screens are acknowledged; reconciliation
 * ends what the daemon no longer holds and tells the daemon to end what the
 * platform already ended; the sweeper ends stale starts. Audit rows carry no
 * terminal byte, no input and no first message.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const NODE_ID = '44444444-4444-4444-8444-444444444444';

function makeNode(overrides: Partial<FleetNode> = {}): FleetNode {
    return {
        id: NODE_ID,
        userId: OWNER,
        organizationId: null,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        capabilities: ['sessions', 'managed', 'claude-code', 'codex'],
        lastHeartbeatAt: new Date(),
        consents: { work: true, attend: false, manage: true, usageScan: false },
        workerState: 'idle',
        sessionDaemon: { state: 'running', sessions: 0 },
        ...overrides,
    } as unknown as FleetNode;
}

/** In-memory `FleetSessionRepository` with the methods the service calls. */
class FakeSessionRepository {
    rows = new Map<string, FleetSession>();
    /** Rows a concurrent start admitted while this one talked to the machine. */
    raceRows: FleetSession[] = [];

    async withAdmissionLock<T>(_nodeId: string, fn: () => Promise<T>): Promise<T> {
        for (const row of this.raceRows.splice(0)) this.rows.set(row.id, row);
        return fn();
    }

    async create(data: Partial<FleetSession>): Promise<FleetSession> {
        const now = new Date();
        const row = { createdAt: now, updatedAt: now, ...data } as FleetSession;
        this.rows.set(row.id, row);
        return { ...row };
    }

    async findById(id: string): Promise<FleetSession | null> {
        const row = this.rows.get(id);
        return row ? { ...row } : null;
    }

    async findByDaemonId(nodeId: string, daemonSessionId: string): Promise<FleetSession | null> {
        for (const row of this.rows.values()) {
            if (row.nodeId === nodeId && row.daemonSessionId === daemonSessionId) return { ...row };
        }
        return null;
    }

    async findLiveForNode(nodeId: string): Promise<FleetSession[]> {
        return [...this.rows.values()]
            .filter((row) => row.nodeId === nodeId && row.state !== 'ended')
            .map((row) => ({ ...row }));
    }

    async findLiveOwnerForNode(nodeId: string): Promise<FleetSession[]> {
        return (await this.findLiveForNode(nodeId)).filter((row) => row.kind === 'owner');
    }

    async recentFolders(nodeId: string): Promise<string[]> {
        const out: string[] = [];
        for (const row of this.rows.values()) {
            if (row.nodeId === nodeId && !out.includes(row.cwd)) out.push(row.cwd);
        }
        return out;
    }

    async listForNodes(nodeIds: readonly string[]): Promise<FleetSession[]> {
        return [...this.rows.values()]
            .filter((row) => nodeIds.includes(row.nodeId))
            .map((row) => ({ ...row }));
    }

    async update(id: string, patch: Partial<FleetSession>): Promise<void> {
        const row = this.rows.get(id);
        if (row) this.rows.set(id, { ...row, ...patch, updatedAt: new Date() });
    }

    async updateIfLive(id: string, patch: Partial<FleetSession>): Promise<boolean> {
        const row = this.rows.get(id);
        if (!row || row.state === 'ended') return false;
        this.rows.set(id, { ...row, ...patch, updatedAt: new Date() });
        return true;
    }

    async findStartingBefore(cutoff: Date): Promise<FleetSession[]> {
        return [...this.rows.values()]
            .filter(
                (row) =>
                    row.state === 'starting' &&
                    row.kind === 'owner' &&
                    new Date(row.createdAt).getTime() < cutoff.getTime(),
            )
            .map((row) => ({ ...row }));
    }

    async findAgentStartingBefore(cutoff: Date): Promise<FleetSession[]> {
        return [...this.rows.values()]
            .filter(
                (row) =>
                    row.state === 'starting' &&
                    row.kind === 'agent' &&
                    new Date(row.createdAt).getTime() < cutoff.getTime(),
            )
            .map((row) => ({ ...row }));
    }

    seed(overrides: Partial<FleetSession> = {}): FleetSession {
        const id =
            overrides.id ?? `aaaaaaaa-0000-4000-8000-${String(this.rows.size).padStart(12, '0')}`;
        const past = new Date(Date.now() - 10 * 60_000);
        const row = {
            id,
            nodeId: NODE_ID,
            userId: OWNER,
            organizationId: null,
            kind: 'owner',
            provider: 'shell',
            agentId: null,
            agentRunId: null,
            checkoutId: null,
            cwd: '~/code/app',
            title: 'app',
            state: 'working',
            outcome: null,
            daemonSessionId: id,
            providerSessionId: null,
            firstMessage: null,
            lastScreen: null,
            restartOfSessionId: null,
            startedBy: `user:${OWNER}`,
            lastActivityAt: past,
            startedAt: past,
            endedAt: null,
            endedReason: null,
            exitCode: null,
            recordingState: 'off',
            createdAt: past,
            updatedAt: past,
            ...overrides,
        } as FleetSession;
        this.rows.set(id, row);
        return row;
    }
}

interface Harness {
    service: FleetSessionService;
    repo: FakeSessionRepository;
    node: FleetNode;
    port: jest.Mocked<FleetSessionNodePort>;
    audit: { tryRecord: jest.Mock };
    killSwitch: { isStopped: jest.Mock };
}

function harness(
    options: {
        node?: Partial<FleetNode>;
        port?: Partial<FleetSessionNodePort> | null;
        stopped?: boolean;
    } = {},
): Harness {
    const node = makeNode(options.node);
    const repo = new FakeSessionRepository();
    const nodes = {
        findById: jest.fn(async (id: string) => (id === node.id ? node : null)),
        findByUser: jest.fn(async (userId: string) => (userId === node.userId ? [node] : [])),
    };
    const access = {
        resolveForFamily: jest.fn(async (nodeId: string, caller: string) => {
            if (nodeId !== node.id) throw new NotFoundException(`Fleet node ${nodeId} not found`);
            if (caller === node.userId) return { node, role: 'owner' };
            if (caller === MEMBER) {
                throw new ForbiddenException({
                    statusCode: 403,
                    message: 'ask the owner',
                    error: {
                        code: 'permission_denied',
                        hint: 'ask the owner',
                        details: { family: 'sessions' },
                    },
                });
            }
            throw new NotFoundException(`Fleet node ${nodeId} not found`);
        }),
        listSharedWith: jest.fn(async () => []),
    };
    const killSwitch = { isStopped: jest.fn(async () => options.stopped === true) };
    const audit = { tryRecord: jest.fn(async () => undefined) };
    const port: jest.Mocked<FleetSessionNodePort> = {
        isConnected: jest.fn(() => true),
        liveConsents: jest.fn(() => ({
            work: true,
            attend: false,
            manage: true,
            usageScan: false,
        })),
        request: jest.fn(async () => ({ sessionId: 'x' })),
        ack: jest.fn(),
        ...(options.port ?? {}),
    } as jest.Mocked<FleetSessionNodePort>;
    const service = new FleetSessionService(
        repo as never,
        nodes as never,
        access as never,
        killSwitch as never,
        audit as never,
        options.port === null ? undefined : port,
    );
    return { service, repo, node, port, audit, killSwitch };
}

async function refusalOf(
    promise: Promise<unknown>,
): Promise<{ code: string; hint: string; details?: unknown }> {
    try {
        await promise;
    } catch (error) {
        const typed = readFleetSessionError(error);
        if (typed) return typed;
        throw error;
    }
    throw new Error('expected a refusal');
}

const START = { kind: 'owner' as const, provider: 'shell' as const, cwd: '~/code/app' };

/** Every audit row's details, flattened to text — must never hold terminal bytes or the first message. */
function auditText(audit: { tryRecord: jest.Mock }): string {
    return JSON.stringify(audit.tryRecord.mock.calls.map((call) => call[0]));
}

describe('fleetSessionFolderTitle (CodeQL 276: no polynomial regex)', () => {
    it('names the last folder, with or without trailing separators', () => {
        expect(fleetSessionFolderTitle('/home/me/code/app')).toBe('app');
        expect(fleetSessionFolderTitle('/home/me/code/app///')).toBe('app');
        expect(fleetSessionFolderTitle('C:\\Users\\me\\repo\\')).toBe('repo');
        expect(fleetSessionFolderTitle('~')).toBe('~');
        expect(fleetSessionFolderTitle('~/')).toBe('~');
        expect(fleetSessionFolderTitle('/')).toBe('~');
        expect(fleetSessionFolderTitle('')).toBe('~');
    });

    it('stays linear on a long run of separators that does not end the path', () => {
        const hostile = `${'/'.repeat(200_000)}x`;
        const started = Date.now();
        expect(fleetSessionFolderTitle(hostile)).toBe('x');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('titles an agent CLI session by its first message, redacted and shortened', () => {
        const title = defaultFleetSessionTitle(
            'claude-code',
            '~/code/app',
            `  fix   the ${'x'.repeat(80)}`,
        );
        expect(title.startsWith('fix the ')).toBe(true);
        expect(title.length).toBeLessThanOrEqual(60);
        expect(defaultFleetSessionTitle('shell', '~/code/app', 'ignored')).toBe('app');
    });
});

describe('FleetSessionService.start', () => {
    it('writes the row only after the machine says the process runs, and audits without the first message', async () => {
        const h = harness();
        h.port.request.mockImplementation(async () => {
            expect(h.repo.rows.size).toBe(0);
            return { sessionId: 'ignored' };
        });
        const view = await h.service.start(
            NODE_ID,
            { userId: OWNER },
            {
                kind: 'owner',
                provider: 'claude-code',
                cwd: '~/code/app',
                firstMessage: 'deploy with token sk-ant-api03-SECRETSECRETSECRETSECRET',
            },
        );
        expect(view.state).toBe('working');
        expect(view.nodeId).toBe(NODE_ID);
        expect(view.startedBy).toBe(`user:${OWNER}`);
        expect(h.repo.rows.size).toBe(1);
        const request = h.port.request.mock.calls[0][0] as FleetSessionNodeRequest;
        expect(request.verb).toBe('session.start');
        expect(request.kind).toBe('owner');
        expect(request.stateChanging).toBe(true);
        expect(request.sessionId).toBe(view.id);
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.session.start',
                nodeId: NODE_ID,
                details: expect.objectContaining({
                    family: 'sessions',
                    target: view.id,
                    outcome: 'started',
                }),
            }),
        );
        expect(auditText(h.audit)).not.toContain('deploy with token');
    });

    it('answers a stranger with the 404 of an unknown computer', async () => {
        const h = harness();
        expect((await refusalOf(h.service.start(NODE_ID, { userId: STRANGER }, START))).code).toBe(
            'not_found',
        );
        expect(h.port.request).not.toHaveBeenCalled();
    });

    it('answers a member outside the sessions audience permission_denied', async () => {
        const h = harness();
        expect((await refusalOf(h.service.start(NODE_ID, { userId: MEMBER }, START))).code).toBe(
            'permission_denied',
        );
    });

    it('refuses Agent sessions until P2, a folder that is not one, and checkout starts', async () => {
        const h = harness();
        expect(
            (
                await refusalOf(
                    h.service.start(NODE_ID, { userId: OWNER }, { ...START, kind: 'agent' }),
                )
            ).code,
        ).toBe('invalid');
        expect(
            (await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, { ...START, cwd: '  ' })))
                .code,
        ).toBe('invalid');
        expect(
            (
                await refusalOf(
                    h.service.start(NODE_ID, { userId: OWNER }, { ...START, cwd: 'a\0b' }),
                )
            ).code,
        ).toBe('invalid');
        expect(
            (
                await refusalOf(
                    h.service.start(
                        NODE_ID,
                        { userId: OWNER },
                        {
                            ...START,
                            checkoutId: '55555555-5555-4555-8555-555555555555',
                        },
                    ),
                )
            ).code,
        ).toBe('invalid');
        expect(h.port.request).not.toHaveBeenCalled();
    });

    it('refuses under the kill switch, and when the kill switch cannot be read (fail-closed)', async () => {
        const h = harness({ stopped: true });
        expect((await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START))).code).toBe(
            'kill_switch',
        );
        h.killSwitch.isStopped.mockRejectedValueOnce(new Error('db down'));
        expect((await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START))).code).toBe(
            'kill_switch',
        );
        expect(h.port.request).not.toHaveBeenCalled();
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.session.start',
                details: expect.objectContaining({ outcome: 'refused', code: 'kill_switch' }),
            }),
        );
    });

    it('refuses without --manage, offline, without the daemon and without the CLI', async () => {
        const noManage = harness({
            port: {
                liveConsents: jest.fn(() => ({
                    work: true,
                    attend: false,
                    manage: false,
                    usageScan: false,
                })),
            },
        });
        expect(
            (await refusalOf(noManage.service.start(NODE_ID, { userId: OWNER }, START))).code,
        ).toBe('consent_missing');

        const offline = harness({
            port: { isConnected: jest.fn(() => false), liveConsents: jest.fn(() => null) },
        });
        expect(
            (await refusalOf(offline.service.start(NODE_ID, { userId: OWNER }, START))).code,
        ).toBe('unreachable');

        const noDaemon = harness({ node: { capabilities: ['managed'] } });
        expect(
            (await refusalOf(noDaemon.service.start(NODE_ID, { userId: OWNER }, START))).code,
        ).toBe('unsupported_on_node');

        const noCli = harness({ node: { capabilities: ['sessions', 'managed'] } });
        expect(
            (
                await refusalOf(
                    noCli.service.start(
                        NODE_ID,
                        { userId: OWNER },
                        { ...START, provider: 'codex' },
                    ),
                )
            ).code,
        ).toBe('unsupported_on_node');
    });

    it('answers unreachable when the deployment binds no node port', async () => {
        const h = harness({ port: null });
        // No port: the link reads as not connected, so the policy refuses first.
        expect((await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START))).code).toBe(
            'unreachable',
        );
        expect(h.repo.rows.size).toBe(0);
    });

    it('refuses the ninth owner session with the eight listed', async () => {
        const h = harness();
        for (let i = 0; i < FLEET_SESSION_MAX_OWNER_PER_NODE; i += 1) h.repo.seed();
        const refusal = await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START));
        expect(refusal.code).toBe('limit_exceeded');
        expect((refusal.details as { sessions: unknown[] }).sessions).toHaveLength(
            FLEET_SESSION_MAX_OWNER_PER_NODE,
        );
        expect(h.port.request).not.toHaveBeenCalled();
    });

    it('a start that lost the admission race ends the process it started and writes no row', async () => {
        const h = harness();
        for (let i = 0; i < FLEET_SESSION_MAX_OWNER_PER_NODE - 1; i += 1) h.repo.seed();
        // Another start is admitted while this one talks to the machine.
        const racing = h.repo.seed();
        h.repo.rows.delete(racing.id);
        h.repo.raceRows.push(racing);
        const before = h.repo.rows.size;
        const refusal = await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START));
        expect(refusal.code).toBe('limit_exceeded');
        expect(h.repo.rows.size).toBe(before + 1); // only the racing row
        const verbs = h.port.request.mock.calls.map(
            (call) => (call[0] as FleetSessionNodeRequest).verb,
        );
        expect(verbs).toEqual(['session.start', 'session.end']);
    });

    it('carries the machine refusal back and writes nothing', async () => {
        const h = harness({
            port: {
                request: jest.fn(async () => {
                    throw fleetSessionError('invalid', 'that folder is outside your home folder', {
                        field: 'cwd',
                    });
                }),
            },
        });
        const refusal = await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, START));
        expect(refusal).toMatchObject({
            code: 'invalid',
            hint: 'that folder is outside your home folder',
        });
        expect(h.repo.rows.size).toBe(0);
    });

    it('applies a report that beat the row once the row lands', async () => {
        const h = harness();
        h.port.request.mockImplementation(async (request: FleetSessionNodeRequest) => {
            await h.service.applyNodeEvent(NODE_ID, {
                type: 'session.event',
                sessionId: request.sessionId,
                event: 'title',
                title: 'renamed on the machine',
            });
            return {};
        });
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        expect(view.title).toBe('renamed on the machine');
    });
});

describe('FleetSessionService.rename / end / restart', () => {
    it('renames, tells a live session’s machine, and audits', async () => {
        const h = harness();
        const row = h.repo.seed();
        const view = await h.service.rename(row.id, { userId: OWNER }, '  release build  ');
        expect(view.title).toBe('release build');
        expect((h.port.request.mock.calls[0][0] as FleetSessionNodeRequest).verb).toBe(
            'session.rename',
        );
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'node.session.rename' }),
        );
        expect((await refusalOf(h.service.rename(row.id, { userId: OWNER }, ''))).code).toBe(
            'invalid',
        );
    });

    it('end needs confirm, then ends on the machine and audits class confirm', async () => {
        const h = harness();
        const row = h.repo.seed();
        const ask = await refusalOf(h.service.end(row.id, { userId: OWNER }));
        expect(ask.code).toBe('confirmation_required');
        expect(ask.details).toMatchObject({ class: 'confirm' });
        expect(h.port.request).not.toHaveBeenCalled();

        const view = await h.service.end(row.id, { userId: OWNER }, { confirm: true });
        expect(view.state).toBe('ended');
        expect(view.endedReason).toBe('user');
        expect(view.outcome).toBe('cancelled');
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.session.end',
                details: expect.objectContaining({
                    confirmationClass: 'confirm',
                    outcome: 'ended',
                }),
            }),
        );
    });

    it('ends an unreachable machine’s session platform-side, and is idempotent', async () => {
        const h = harness({
            port: {
                request: jest.fn(async () => {
                    throw fleetSessionError('unreachable', 'build-01 is not connected');
                }),
            },
        });
        const row = h.repo.seed();
        const view = await h.service.end(row.id, { userId: OWNER }, { confirm: true });
        expect(view.state).toBe('ended');
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                details: expect.objectContaining({ outcome: 'ended-platform-side' }),
            }),
        );
        const again = await h.service.end(row.id, { userId: OWNER }, { confirm: true });
        expect(again.state).toBe('ended');
        expect(h.port.request).toHaveBeenCalledTimes(1);
    });

    it('keeps a real refusal from the machine (the session stays live)', async () => {
        const h = harness({
            port: {
                request: jest.fn(async () => {
                    throw fleetSessionError('kill_switch', 'clear it under Settings → Fleet');
                }),
            },
        });
        const row = h.repo.seed();
        expect(
            (await refusalOf(h.service.end(row.id, { userId: OWNER }, { confirm: true }))).code,
        ).toBe('kill_switch');
        expect(h.repo.rows.get(row.id)!.state).toBe('working');
    });

    it('hides a session on a computer the caller may not see, and an id that is not one', async () => {
        const h = harness();
        const row = h.repo.seed();
        expect((await refusalOf(h.service.get(row.id, { userId: STRANGER }))).code).toBe(
            'not_found',
        );
        expect((await refusalOf(h.service.get('not-a-uuid', { userId: OWNER }))).code).toBe(
            'not_found',
        );
    });

    it('restart refuses a live session, then starts a new one linked back', async () => {
        const h = harness();
        const live = h.repo.seed();
        expect((await refusalOf(h.service.restart(live.id, { userId: OWNER }))).code).toBe(
            'invalid',
        );
        const ended = h.repo.seed({
            state: 'ended',
            endedReason: 'exit',
            outcome: 'success',
            title: 'tests',
        });
        const view = await h.service.restart(ended.id, { userId: OWNER });
        expect(view.restartOfSessionId).toBe(ended.id);
        expect(view.title).toBe('tests');
        const calls = h.port.request.mock.calls;
        const request = calls[calls.length - 1][0] as FleetSessionNodeRequest;
        expect(request.verb).toBe('session.restart');
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'node.session.restart' }),
        );
    });

    it('restart through the start route refuses a session of another computer', async () => {
        const h = harness();
        const ended = h.repo.seed({ state: 'ended', endedReason: 'exit' });
        const refusal = await refusalOf(
            h.service.restart(
                ended.id,
                { userId: OWNER },
                {},
                { expectNodeId: '66666666-6666-4666-8666-666666666666' },
            ),
        );
        expect(refusal.code).toBe('invalid');
        expect(h.port.request).not.toHaveBeenCalled();
    });
});

describe('FleetSessionService — what the node reports', () => {
    const event = (
        sessionId: string,
        patch: Partial<FleetSessionEventMessage>,
    ): FleetSessionEventMessage => ({
        type: 'session.event',
        sessionId,
        event: 'activity',
        ...patch,
    });

    it('started, activity and title move a live row', async () => {
        const h = harness();
        const row = h.repo.seed({ state: 'starting', startedAt: null });
        await h.service.applyNodeEvent(NODE_ID, event(row.daemonSessionId, { event: 'started' }));
        expect(h.repo.rows.get(row.id)!.state).toBe('working');
        expect(h.repo.rows.get(row.id)!.startedAt).toBeInstanceOf(Date);
        await h.service.applyNodeEvent(
            NODE_ID,
            event(row.daemonSessionId, { event: 'title', title: 'npm test' }),
        );
        expect(h.repo.rows.get(row.id)!.title).toBe('npm test');
    });

    it('exited ends the row with the exit code and screen, and acks the screen', async () => {
        const h = harness();
        const row = h.repo.seed();
        await h.service.applyNodeEvent(
            NODE_ID,
            event(row.daemonSessionId, { event: 'exited', exitCode: 1, screen: 'FAIL 3 tests' }),
        );
        const stored = h.repo.rows.get(row.id)!;
        expect(stored).toMatchObject({
            state: 'ended',
            endedReason: 'exit',
            outcome: 'failure',
            exitCode: 1,
        });
        expect(stored.lastScreen).toBe('FAIL 3 tests');
        expect(h.port.ack).toHaveBeenCalledWith(NODE_ID, [row.daemonSessionId]);
    });

    it('a drain end is audited as the system; a user end racing an exit keeps the first reason', async () => {
        const h = harness();
        const drained = h.repo.seed();
        await h.service.applyNodeEvent(
            NODE_ID,
            event(drained.daemonSessionId, { event: 'exited', reason: 'drain' }),
        );
        expect(h.repo.rows.get(drained.id)!.endedReason).toBe('drain');
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.session.end',
                actorUserId: null,
                details: expect.objectContaining({ reason: 'drain', requestedBy: 'system:drain' }),
            }),
        );

        const ended = h.repo.seed({ state: 'ended', endedReason: 'user', outcome: 'cancelled' });
        await h.service.applyNodeEvent(
            NODE_ID,
            event(ended.daemonSessionId, { event: 'exited', exitCode: 0, screen: 'bye' }),
        );
        expect(h.repo.rows.get(ended.id)).toMatchObject({
            endedReason: 'user',
            outcome: 'cancelled',
            exitCode: 0,
            lastScreen: 'bye',
        });
    });

    it('lost ends the row node-restart, unconfirmed', async () => {
        const h = harness();
        const row = h.repo.seed();
        await h.service.applyNodeEvent(
            NODE_ID,
            event(row.daemonSessionId, { event: 'lost', screen: 'last' }),
        );
        expect(h.repo.rows.get(row.id)).toMatchObject({
            state: 'ended',
            endedReason: 'node-restart',
            outcome: 'unconfirmed',
        });
    });

    it('never throws on a report for a broken repository', async () => {
        const h = harness();
        h.repo.findByDaemonId = jest.fn(async () => {
            throw new Error('db down');
        });
        await expect(h.service.applyNodeEvent(NODE_ID, event('x', {}))).resolves.toBeUndefined();
    });
});

describe('FleetSessionService.reconcileList and sweepStale', () => {
    const daemon = { state: 'running' as const, sessions: 0 };

    it('ends a live row the running daemon no longer holds (after the grace), keeps a young one', async () => {
        const h = harness();
        const gone = h.repo.seed();
        const young = h.repo.seed({ createdAt: new Date() });
        await h.service.reconcileList(NODE_ID, { type: 'session.list', sessions: [], daemon });
        expect(h.repo.rows.get(gone.id)).toMatchObject({
            state: 'ended',
            endedReason: 'node-restart',
        });
        expect(h.repo.rows.get(young.id)!.state).toBe('working');
    });

    it('decides nothing when the daemon is not running', async () => {
        const h = harness();
        const row = h.repo.seed();
        await h.service.reconcileList(NODE_ID, {
            type: 'session.list',
            sessions: [],
            daemon: { state: 'stopped', sessions: 0 },
        });
        expect(h.repo.rows.get(row.id)!.state).toBe('working');
    });

    it('tells the daemon to end a session the platform already ended', async () => {
        const h = harness();
        const ended = h.repo.seed({ state: 'ended', endedReason: 'user', outcome: 'cancelled' });
        await h.service.reconcileList(NODE_ID, {
            type: 'session.list',
            sessions: [
                {
                    sessionId: ended.daemonSessionId,
                    kind: 'owner',
                    provider: 'shell',
                    cwd: ended.cwd,
                    title: ended.title,
                    startedAt: new Date().toISOString(),
                    alive: true,
                    exitCode: null,
                    cols: 120,
                    rows: 32,
                    viewers: 0,
                    drivers: 0,
                },
            ],
            daemon,
        });
        const request = h.port.request.mock.calls[0][0] as FleetSessionNodeRequest;
        expect(request.verb).toBe('session.end');
        expect(request.caller).toEqual({ kind: 'system', job: 'session-reconcile' });
    });

    it('the sweeper ends owner sessions still starting after a minute', async () => {
        const h = harness();
        const stale = h.repo.seed({
            state: 'starting',
            createdAt: new Date(Date.now() - 5 * 60_000),
        });
        const fresh = h.repo.seed({ state: 'starting', createdAt: new Date() });
        expect(await h.service.sweepStale()).toEqual({ ended: 1 });
        expect(h.repo.rows.get(stale.id)).toMatchObject({
            state: 'ended',
            endedReason: 'timeout',
            outcome: 'unconfirmed',
        });
        expect(h.repo.rows.get(fresh.id)!.state).toBe('starting');
        // Idempotent.
        expect(await h.service.sweepStale()).toEqual({ ended: 0 });
    });
});

describe('FleetSessionService reads', () => {
    it('lists the computer’s sessions with a cursor on a full page', async () => {
        const h = harness();
        h.repo.seed();
        h.repo.seed();
        const page = await h.service.listPage({ userId: OWNER }, { nodeId: NODE_ID, limit: 2 });
        expect(page.sessions).toHaveLength(2);
        expect(page.nextCursor).toEqual(expect.stringContaining('|'));
        const all = await h.service.listPage({ userId: OWNER }, { limit: 50 });
        expect(all.nextCursor).toBeNull();
        expect(
            (await refusalOf(h.service.listPage({ userId: STRANGER }, { nodeId: NODE_ID }))).code,
        ).toBe('not_found');
    });

    it('lists no sessions on computers the caller cannot see', async () => {
        const h = harness();
        h.repo.seed();
        expect((await h.service.listPage({ userId: STRANGER })).sessions).toEqual([]);
    });

    it('detail carries the last screen; a list does not', async () => {
        const h = harness();
        const row = h.repo.seed({ state: 'ended', endedReason: 'exit', lastScreen: 'done' });
        expect((await h.service.get(row.id, { userId: OWNER })).lastScreen).toBe('done');
        const page = await h.service.listPage({ userId: OWNER });
        expect(page.sessions[0]).not.toHaveProperty('lastScreen');
    });
});

describe('FleetSessionService — Agent sessions (FL-04 P2)', () => {
    const AGENT_ID = '55555555-5555-4555-8555-555555555555';
    const RUN_ID = '66666666-6666-4666-8666-666666666666';
    const AGENT_START = {
        kind: 'agent' as const,
        provider: 'claude-code' as const,
        cwd: '~/code/app',
        agentId: AGENT_ID,
        firstMessage: 'Fix the failing build please',
    };

    function agentHarness(options: { agentOwner?: string; enqueueFails?: boolean } = {}) {
        const base = harness();
        const agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) =>
                id === AGENT_ID && userId === (options.agentOwner ?? OWNER)
                    ? { id, name: 'Nina' }
                    : null,
            ),
        };
        const runs = {
            createQueued: jest.fn(async () => ({ id: RUN_ID })),
            markDispatchFailed: jest.fn(async () => undefined),
            markStarted: jest.fn(async () => true),
            markCompleted: jest.fn(async () => undefined),
            markFailed: jest.fn(async () => undefined),
            cancel: jest.fn(async () => ({ found: true })),
        };
        const dispatcher = {
            enqueue: jest.fn(async () => {
                if (options.enqueueFails) throw new Error('no runtime');
                return { jobId: 'job-1' };
            }),
            cancelForSession: jest.fn(async () => true),
        };
        const service = new FleetSessionService(
            base.repo as never,
            {
                findById: jest.fn(async () => base.node),
                findByUser: jest.fn(async () => [base.node]),
            } as never,
            {
                resolveForFamily: jest.fn(async () => ({ node: base.node, role: 'owner' })),
                listSharedWith: jest.fn(async () => []),
            } as never,
            base.killSwitch as never,
            base.audit as never,
            base.port,
            agents as never,
            runs as never,
            dispatcher as never,
        );
        return { ...base, service, agents, runs, dispatcher };
    }

    it('queues an Agent session: row starting, its Run linked both ways, the job pinned to the node', async () => {
        const h = agentHarness();
        const view = await h.service.start(NODE_ID, { userId: OWNER }, AGENT_START);
        expect(view.state).toBe('starting');
        expect(view.kind).toBe('agent');
        expect(view.agentRunId).toBe(RUN_ID);
        expect(view.startedBy).toBe(`agent:${AGENT_ID}`);
        expect(h.runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({
                triggerKind: 'session',
                fleetSessionId: view.id,
                agentId: AGENT_ID,
            }),
        );
        const enqueued = (h.dispatcher.enqueue.mock.calls[0] as unknown[])[0] as {
            payload: Record<string, unknown>;
        };
        expect(enqueued.payload).toMatchObject({
            fleetSessionId: view.id,
            nodeId: NODE_ID,
            agentRunId: RUN_ID,
        });
        // The machine is not asked on the link: the job carries the start.
        expect(h.port.request).not.toHaveBeenCalled();
    });

    it('treats an Agent actor as an Agent session of itself, whatever the request says (FR-51)', async () => {
        const h = agentHarness();
        const view = await h.service.start(
            NODE_ID,
            { userId: OWNER, agentId: AGENT_ID },
            {
                kind: 'owner',
                provider: 'claude-code',
                cwd: '~/code/app',
                firstMessage: 'do the thing now',
            },
        );
        expect(view.kind).toBe('agent');
        expect(view.agentId).toBe(AGENT_ID);
    });

    it('refuses a shell, a short first message, somebody else’s Agent', async () => {
        const h = agentHarness();
        expect(
            (
                await refusalOf(
                    h.service.start(
                        NODE_ID,
                        { userId: OWNER },
                        { ...AGENT_START, provider: 'shell' },
                    ),
                )
            ).code,
        ).toBe('invalid');
        expect(
            (
                await refusalOf(
                    h.service.start(
                        NODE_ID,
                        { userId: OWNER },
                        { ...AGENT_START, firstMessage: 'hi' },
                    ),
                )
            ).code,
        ).toBe('invalid');
        const other = agentHarness({ agentOwner: MEMBER });
        expect(
            (await refusalOf(other.service.start(NODE_ID, { userId: OWNER }, AGENT_START))).code,
        ).toBe('not_found');
    });

    it('ends the row and fails the Run when the job cannot be queued — no session waits on nothing', async () => {
        const h = agentHarness({ enqueueFails: true });
        expect(
            (await refusalOf(h.service.start(NODE_ID, { userId: OWNER }, AGENT_START))).code,
        ).toBe('unreachable');
        expect(h.runs.markDispatchFailed).toHaveBeenCalledWith(RUN_ID, expect.any(String));
        expect([...h.repo.rows.values()].every((row) => row.state === 'ended')).toBe(true);
    });

    it('ending an Agent session withdraws its job and settles its Run (R-1)', async () => {
        const h = agentHarness();
        const view = await h.service.start(NODE_ID, { userId: OWNER }, AGENT_START);
        await h.service.end(view.id, { userId: OWNER }, { confirm: true });
        expect(h.dispatcher.cancelForSession).toHaveBeenCalledWith(view.id);
        expect(h.runs.cancel).toHaveBeenCalledWith(RUN_ID, OWNER);
    });

    it('a settled job ends a still-live session and completes the Run on success', async () => {
        const h = agentHarness();
        const view = await h.service.start(NODE_ID, { userId: OWNER }, AGENT_START);
        await h.service.agentSessionJobSettled(view.id, {
            succeeded: true,
            result: { exitCode: 0, outcome: 'success', providerSessionId: null },
            error: null,
        });
        expect(h.repo.rows.get(view.id)?.state).toBe('ended');
        expect(h.runs.markCompleted).toHaveBeenCalledWith(RUN_ID, expect.any(String));
    });
});

describe('FleetSessionService — recording (FL-04 P3)', () => {
    function recordedHarness(nodeOverrides: Record<string, unknown> = {}) {
        const base = harness({ node: nodeOverrides as never });
        const recorder = { ensure: jest.fn(), stop: jest.fn() };
        const service = new FleetSessionService(
            base.repo as never,
            {
                findById: jest.fn(async () => base.node),
                findByUser: jest.fn(async () => [base.node]),
            } as never,
            {
                resolveForFamily: jest.fn(async () => ({ node: base.node, role: 'owner' })),
                listSharedWith: jest.fn(async () => []),
            } as never,
            base.killSwitch as never,
            base.audit as never,
            base.port,
            undefined,
            undefined,
            undefined,
            recorder,
        );
        return { ...base, service, recorder };
    }

    it('records an owner session when the computer asks for watched sessions to be recorded', async () => {
        const h = recordedHarness({ recordWatchSessions: true });
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        expect(view.recordingState).toBe('recording');
        expect(h.recorder.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ id: view.id, nodeId: NODE_ID }),
        );
    });

    it('does not record by default', async () => {
        const h = recordedHarness();
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        expect(view.recordingState).toBe('off');
        expect(h.recorder.ensure).not.toHaveBeenCalled();
    });

    it('switches recording on and off with one audit row each', async () => {
        const h = recordedHarness();
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        const on = await h.service.setRecording(view.id, { userId: OWNER }, true);
        expect(on.recordingState).toBe('recording');
        expect(h.recorder.ensure).toHaveBeenCalled();
        const off = await h.service.setRecording(view.id, { userId: OWNER }, false);
        expect(off.recordingState).toBe('off');
        expect(h.recorder.stop).toHaveBeenCalledWith(view.id);
        const actions = h.audit.tryRecord.mock.calls.map(
            (call) => (call[0] as { action: string }).action,
        );
        expect(actions).toEqual(
            expect.arrayContaining(['node.session.recording.start', 'node.session.recording.stop']),
        );
    });

    it('stores the recording when the session ends, and stops the recorder', async () => {
        const h = recordedHarness({ recordWatchSessions: true });
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        await h.service.end(view.id, { userId: OWNER }, { confirm: true });
        expect(h.repo.rows.get(view.id)?.recordingState).toBe('stored');
        expect(h.recorder.stop).toHaveBeenCalledWith(view.id);
    });

    it('a storage failure stops recording with an audit row', async () => {
        const h = recordedHarness({ recordWatchSessions: true });
        const view = await h.service.start(NODE_ID, { userId: OWNER }, START);
        await h.service.recordingFailed(view.id);
        expect(h.repo.rows.get(view.id)?.recordingState).toBe('off');
    });
});
