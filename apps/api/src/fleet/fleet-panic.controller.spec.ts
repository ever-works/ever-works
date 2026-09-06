import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { FleetJobView, FleetNodeView } from '@ever-works/contracts';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { CancelFleetInFlightDto } from './dto/fleet-kill-switch.dto';
import { FleetPanicController } from './fleet-panic.controller';
import { FleetPanicService } from './fleet-panic.service';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

const auth = { userId: 'user-1' } as AuthenticatedUser;
const otherAuth = { userId: 'user-2' } as AuthenticatedUser;

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-online',
        name: 'PC',
        kind: 'node',
        status: 'online',
        platform: 'win32/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        capabilitiesPinned: false,
        ...over,
    } as FleetNodeView;
}

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'running',
        nodeId: 'node-online',
        targetNodeId: null,
        requiredCapabilities: [],
        payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        queuedReason: null,
        ...over,
    } as FleetJobView;
}

/**
 * Panic controls (EW-778) — the owner half: drain-all and the explicit
 * cancel-in-flight, through `FleetPanicService` and its controller.
 *
 * What is pinned: everything is keyed by the SESSION user (the node
 * list, every drain, every job read, every run cancel); the per-node
 * order (disable BEFORE requeue) is preserved by drain-all; enrolling and
 * disabled nodes are skipped; the audit row is written with the actor
 * and its failure never undoes the action; and cancel-in-flight runs the
 * DB-first order per job while leaving the concurrency queue alone.
 */
describe('FleetPanicService', () => {
    let calls: string[];
    let fleet: {
        listEnrolledForUser: jest.Mock;
        setDisabledForUser: jest.Mock;
        // EW-799 — the owner-scoped read behind the `node.drain` row's
        // `before`, so the trail states the status the node actually had
        // rather than inferring it from what was requested.
        getForUser: jest.Mock;
    };
    let jobs: {
        releaseClaimsForNode: jest.Mock;
        activeForUser: jest.Mock;
        queuedForUser: jest.Mock;
        cancel: jest.Mock;
    };
    let agentRuns: { cancel: jest.Mock };
    let audit: { record: jest.Mock; recordNodeAction: jest.Mock };
    let service: FleetPanicService;

    beforeEach(() => {
        calls = [];
        fleet = {
            listEnrolledForUser: jest.fn(async () => [
                node({ id: 'node-online' }),
                node({ id: 'node-busy', status: 'online' }),
                node({ id: 'node-enrolling', status: 'enrolling' }),
                node({ id: 'node-disabled', status: 'disabled' }),
            ]),
            setDisabledForUser: jest.fn(async (_user: string, id: string, disabled: boolean) => {
                calls.push(`disable:${id}`);
                return node({ id, status: disabled ? 'disabled' : 'offline' });
            }),
            getForUser: jest.fn(async (_user: string, id: string) => node({ id })),
        };
        jobs = {
            releaseClaimsForNode: jest.fn(async (_user: string, id: string) => {
                calls.push(`release:${id}`);
                return id === 'node-busy' ? 2 : 1;
            }),
            activeForUser: jest.fn(async () => [
                job({ id: 'job-1', payload: { taskId: 'task-1', runId: 'run-1' } }),
                job({
                    id: 'job-2',
                    status: 'leased',
                    payload: { taskId: 'task-2', runId: 'run-2' },
                }),
                job({ id: 'job-3', kind: 'acceptance-checks', payload: null }),
            ]),
            queuedForUser: jest.fn(async () => [
                job({
                    id: 'job-q',
                    status: 'queued',
                    nodeId: null,
                    payload: { taskId: 't', runId: 'run-q' },
                }),
            ]),
            cancel: jest.fn(async (id: string) => {
                calls.push(`job-cancel:${id}`);
                return id === 'job-q'
                    ? { cancelled: true, state: 'queued-dropped' }
                    : { cancelled: true, state: 'cancel-requested' };
            }),
        };
        agentRuns = {
            cancel: jest.fn(async (runId: string) => {
                calls.push(`run-cancel:${runId}`);
                return { found: true, previousStatus: 'running', triggerRunId: null, workId: 'w' };
            }),
        };
        audit = {
            record: jest.fn(async () => ({ id: 'audit-1' })),
            // EW-799 — the lifecycle-row entry point; never throws by
            // contract, so the stub returns a boolean, not a row.
            recordNodeAction: jest.fn(async () => true),
        };
        service = new FleetPanicService(
            fleet as never,
            jobs as never,
            agentRuns as never,
            audit as never,
        );
        for (const level of ['warn', 'error', 'log'] as const) {
            jest.spyOn(
                (service as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
    });

    describe('drainNodeForUser (the per-node drain, shared with the :id/drain route)', () => {
        it('disables FIRST, then requeues the claims', async () => {
            const result = await service.drainNodeForUser('user-1', 'node-online', true);
            expect(calls).toEqual(['disable:node-online', 'release:node-online']);
            expect(fleet.setDisabledForUser).toHaveBeenCalledWith(
                'user-1',
                'node-online',
                true,
                // EW-799: the drain suppresses the inner
                // `node.disable` row — the drain IS the decision,
                // and two rows for one act is not a better trail.
                { suppress: true },
            );
            expect(jobs.releaseClaimsForNode).toHaveBeenCalledWith('user-1', 'node-online');
            expect(result).toEqual({
                node: expect.objectContaining({ status: 'disabled' }),
                releasedJobs: 1,
            });
        });

        it('returning to service requeues nothing', async () => {
            const result = await service.drainNodeForUser('user-1', 'node-online', false);
            expect(jobs.releaseClaimsForNode).not.toHaveBeenCalled();
            expect(result.releasedJobs).toBe(0);
        });

        it('writes ONE node.drain row with the actor, the node and the release count', async () => {
            // EW-799: the per-node drain used to be the one panic action
            // that left no trace at all, while drain-all — which calls it
            // — was audited.
            await service.drainNodeForUser('user-1', 'node-online', true);

            expect(audit.recordNodeAction).toHaveBeenCalledTimes(1);
            expect(audit.recordNodeAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'node.drain',
                    actorUserId: 'user-1',
                    ownerUserId: 'user-1',
                    nodeId: 'node-online',
                    // The status the node ACTUALLY had, read before the
                    // disable — not inferred from what was requested.
                    before: { status: 'online', drained: false },
                    after: expect.objectContaining({ status: 'disabled', drained: true }),
                    extra: expect.objectContaining({ releasedJobs: 1, via: 'node-drain' }),
                }),
            );
        });

        it('states the status the node ACTUALLY had, not the one the request implies', async () => {
            // Draining an already-disabled node is the case the inferred
            // `before` got wrong: it filed a row claiming the machine had
            // been running.
            fleet.getForUser.mockResolvedValueOnce(node({ id: 'node-online', status: 'disabled' }));

            await service.drainNodeForUser('user-1', 'node-online', true);

            expect(audit.recordNodeAction).toHaveBeenCalledWith(
                expect.objectContaining({ before: { status: 'disabled', drained: true } }),
            );
        });

        it('an unreadable prior status degrades the delta, it does not cost the drain', async () => {
            fleet.getForUser.mockRejectedValueOnce(new Error('db down'));

            const result = await service.drainNodeForUser('user-1', 'node-online', true);

            expect(result.node.status).toBe('disabled');
            expect(audit.recordNodeAction).toHaveBeenCalledWith(
                expect.objectContaining({ before: null }),
            );
        });
    });

    describe('drainAllForUser', () => {
        it('drains only the caller’s drainable nodes, in disable-then-requeue order, and sums the releases', async () => {
            const result = await service.drainAllForUser('user-1');

            expect(fleet.listEnrolledForUser).toHaveBeenCalledWith('user-1');
            // Enrolling + disabled are skipped; the two online nodes drain.
            expect(fleet.setDisabledForUser).toHaveBeenCalledTimes(2);
            expect(fleet.setDisabledForUser).toHaveBeenCalledWith(
                'user-1',
                'node-online',
                true,
                // EW-799: the drain suppresses the inner
                // `node.disable` row — the drain IS the decision,
                // and two rows for one act is not a better trail.
                { suppress: true },
            );
            expect(fleet.setDisabledForUser).toHaveBeenCalledWith(
                'user-1',
                'node-busy',
                true,
                // EW-799: the drain suppresses the inner
                // `node.disable` row — the drain IS the decision,
                // and two rows for one act is not a better trail.
                { suppress: true },
            );
            expect(fleet.setDisabledForUser).not.toHaveBeenCalledWith(
                'user-1',
                'node-enrolling',
                expect.anything(),
            );
            expect(fleet.setDisabledForUser).not.toHaveBeenCalledWith(
                'user-1',
                'node-disabled',
                expect.anything(),
            );
            expect(calls).toEqual([
                'disable:node-online',
                'release:node-online',
                'disable:node-busy',
                'release:node-busy',
            ]);
            expect(result).toMatchObject({
                drainedNodes: 2,
                skippedNodes: 2,
                releasedJobs: 3,
                auditFailed: false,
            });
            expect(result.nodes).toHaveLength(4);
            expect(result.nodes.find((n) => n.id === 'node-online')?.status).toBe('disabled');
            expect(result.nodes.find((n) => n.id === 'node-enrolling')?.status).toBe('enrolling');
        });

        it('records the drain-all decision ONCE, not once per node', async () => {
            // EW-799: per-node drains under drain-all are suppressed, so
            // the aggregate row (written through `record`) stays the one
            // record of the decision instead of being buried under N
            // `node.drain` rows.
            await service.drainAllForUser('user-1');
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.recordNodeAction).not.toHaveBeenCalled();
            // And it pays no per-node read for a `before` it will not file.
            expect(fleet.getForUser).not.toHaveBeenCalled();
        });

        it('is scoped to the SESSION user — a different session drains a different owner', async () => {
            fleet.listEnrolledForUser.mockResolvedValueOnce([]);
            const result = await service.drainAllForUser('user-2');
            expect(fleet.listEnrolledForUser).toHaveBeenCalledWith('user-2');
            expect(fleet.listEnrolledForUser).not.toHaveBeenCalledWith('user-1');
            expect(fleet.setDisabledForUser).not.toHaveBeenCalled();
            expect(result.drainedNodes).toBe(0);
        });

        it('writes ONE audit row carrying the actor, the owner and the counts', async () => {
            await service.drainAllForUser('user-1');
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith({
                action: 'drain-all',
                actorUserId: 'user-1',
                ownerUserId: 'user-1',
                details: {
                    drainedNodes: 2,
                    skippedNodes: 2,
                    releasedJobs: 3,
                    nodeIds: ['node-online', 'node-busy'],
                    failedNodeIds: [],
                },
            });
        });

        it('keeps draining the rest when one node fails, and records the failure', async () => {
            fleet.setDisabledForUser.mockImplementationOnce(async () => {
                throw new Error('registry hiccup');
            });
            const result = await service.drainAllForUser('user-1');
            expect(result).toMatchObject({ drainedNodes: 1, skippedNodes: 3, releasedJobs: 2 });
            expect(audit.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: expect.objectContaining({ failedNodeIds: ['node-online'] }),
                }),
            );
        });

        it('never undoes a drain because the audit write failed — it reports it', async () => {
            audit.record.mockRejectedValue(new Error('audit down'));
            const result = await service.drainAllForUser('user-1');
            expect(result.drainedNodes).toBe(2);
            expect(result.auditFailed).toBe(true);
        });

        it('never cancels anything — draining is not killing', async () => {
            await service.drainAllForUser('user-1');
            expect(jobs.cancel).not.toHaveBeenCalled();
            expect(agentRuns.cancel).not.toHaveBeenCalled();
        });
    });

    describe('cancelInFlightForUser', () => {
        it('cancels the run row FIRST, then the job, for every active job the caller owns', async () => {
            const result = await service.cancelInFlightForUser('user-1');

            expect(jobs.activeForUser).toHaveBeenCalledWith('user-1');
            expect(jobs.queuedForUser).not.toHaveBeenCalled();
            expect(agentRuns.cancel).toHaveBeenCalledWith('run-1', 'user-1');
            expect(agentRuns.cancel).toHaveBeenCalledWith('run-2', 'user-1');
            expect(agentRuns.cancel).toHaveBeenCalledTimes(2);
            expect(calls).toEqual([
                'run-cancel:run-1',
                'job-cancel:job-1',
                'run-cancel:run-2',
                'job-cancel:job-2',
                'job-cancel:job-3',
            ]);
            expect(result).toEqual({
                requested: 3,
                cancelled: 3,
                runsCancelled: 2,
                byState: {
                    'queued-dropped': 0,
                    'cancel-requested': 3,
                    terminal: 0,
                    'not-found': 0,
                },
                jobIds: ['job-1', 'job-2', 'job-3'],
                auditFailed: false,
            });
        });

        it('includeQueued defaults to false and, when set, adds the queued rows', async () => {
            const result = await service.cancelInFlightForUser('user-1', { includeQueued: true });
            expect(jobs.queuedForUser).toHaveBeenCalledWith('user-1');
            expect(result.requested).toBe(4);
            expect(result.byState['queued-dropped']).toBe(1);
            expect(agentRuns.cancel).toHaveBeenCalledWith('run-q', 'user-1');
        });

        it('is scoped to the SESSION user', async () => {
            jobs.activeForUser.mockResolvedValueOnce([]);
            await service.cancelInFlightForUser('user-2');
            expect(jobs.activeForUser).toHaveBeenCalledWith('user-2');
            expect(jobs.cancel).not.toHaveBeenCalled();
        });

        it('writes ONE audit row carrying the actor and per-state counts', async () => {
            await service.cancelInFlightForUser('user-1');
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'cancel-in-flight',
                    actorUserId: 'user-1',
                    ownerUserId: 'user-1',
                    details: expect.objectContaining({
                        includeQueued: false,
                        requested: 3,
                        cancelled: 3,
                        runsCancelled: 2,
                        byState: expect.objectContaining({ 'cancel-requested': 3 }),
                    }),
                }),
            );
        });

        it('counts a run that was already terminal as not cancelled, and still cancels the job', async () => {
            agentRuns.cancel.mockResolvedValueOnce({ found: true, previousStatus: 'completed' });
            const result = await service.cancelInFlightForUser('user-1');
            expect(result.runsCancelled).toBe(1);
            expect(jobs.cancel).toHaveBeenCalledTimes(3);
        });

        it('a run cancel that throws does not stop the job cancel or the rest of the batch', async () => {
            agentRuns.cancel.mockRejectedValueOnce(new Error('db blip'));
            const result = await service.cancelInFlightForUser('user-1');
            expect(jobs.cancel).toHaveBeenCalledTimes(3);
            expect(result.cancelled).toBe(3);
        });

        it('reports an audit failure without undoing the cancel', async () => {
            audit.record.mockRejectedValue(new Error('audit down'));
            const result = await service.cancelInFlightForUser('user-1');
            expect(result.cancelled).toBe(3);
            expect(result.auditFailed).toBe(true);
        });
    });
});

describe('FleetPanicController', () => {
    let panic: { drainAllForUser: jest.Mock; cancelInFlightForUser: jest.Mock };
    let killSwitch: { publicState: jest.Mock; state: jest.Mock };
    /** EW-799 — rotate-all is a whole-fleet owner verb, so it lives here. */
    let rotator: { queueRotationForUser: jest.Mock };
    let controller: FleetPanicController;

    beforeEach(() => {
        panic = {
            drainAllForUser: jest.fn(async () => ({
                drainedNodes: 1,
                skippedNodes: 0,
                releasedJobs: 0,
                nodes: [],
                auditFailed: false,
            })),
            cancelInFlightForUser: jest.fn(async () => ({
                requested: 0,
                cancelled: 0,
                runsCancelled: 0,
                byState: {
                    'queued-dropped': 0,
                    'cancel-requested': 0,
                    terminal: 0,
                    'not-found': 0,
                },
                jobIds: [],
                auditFailed: false,
            })),
        };
        killSwitch = {
            publicState: jest.fn(async () => ({
                stopped: true,
                reason: 'incident',
                since: '2026-09-05T02:00:00.000Z',
                unverified: false,
            })),
            state: jest.fn(),
        };
        rotator = {
            // EW-799 — rotate-all QUEUES; it never mints a credential here.
            queueRotationForUser: jest.fn(async () => ({
                queuedNodes: 2,
                skippedNodes: 1,
                nodes: [],
                auditFailed: false,
            })),
        };
        controller = new FleetPanicController(
            panic as never,
            killSwitch as never,
            rotator as never,
        );
    });

    it('drain-all is scoped to the SESSION user', async () => {
        await controller.drainAll(auth);
        expect(panic.drainAllForUser).toHaveBeenCalledWith('user-1');
        await controller.drainAll(otherAuth);
        expect(panic.drainAllForUser).toHaveBeenLastCalledWith('user-2');
    });

    it('cancel-in-flight is scoped to the session user and defaults includeQueued to false', async () => {
        await controller.cancelInFlight(auth, {});
        expect(panic.cancelInFlightForUser).toHaveBeenCalledWith('user-1', {
            includeQueued: false,
        });
        await controller.cancelInFlight(auth, { includeQueued: true });
        expect(panic.cancelInFlightForUser).toHaveBeenLastCalledWith('user-1', {
            includeQueued: true,
        });
    });

    it('drain-all never triggers cancel-in-flight (two routes, two decisions)', async () => {
        await controller.drainAll(auth);
        expect(panic.cancelInFlightForUser).not.toHaveBeenCalled();
    });

    it('rotate-all is scoped to the SESSION user', async () => {
        await controller.rotateAll(auth);
        expect(rotator.queueRotationForUser).toHaveBeenCalledWith('user-1');
        await controller.rotateAll(otherAuth);
        expect(rotator.queueRotationForUser).toHaveBeenLastCalledWith('user-2');
    });

    it('rotate-all reports what it QUEUED and returns no credential', async () => {
        const result = await controller.rotateAll(auth);
        expect(result).toMatchObject({ queuedNodes: 2, skippedNodes: 1, auditFailed: false });
        // The point of queueing: only the machine can store a new secret,
        // so this response must never carry one.
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(JSON.stringify(result)).not.toContain('token');
    });

    it('GET kill-switch answers the PUBLIC projection — the actor is never in it', async () => {
        const state = await controller.killSwitchState();
        expect(killSwitch.publicState).toHaveBeenCalledTimes(1);
        expect(killSwitch.state).not.toHaveBeenCalled();
        expect(state).not.toHaveProperty('setByUserId');
        expect(state.stopped).toBe(true);
    });

    it('is gated on FLEET_ENABLED and is NOT a public controller', () => {
        const guards = Reflect.getMetadata('__guards__', FleetPanicController) ?? [];
        expect(guards).toContain(FleetEnabledGuard);
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetPanicController)).toBeFalsy();
        for (const route of [
            'drainAll',
            'cancelInFlight',
            'rotateAll',
            'killSwitchState',
        ] as const) {
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller[route])).toBeFalsy();
        }
    });
});

describe('CancelFleetInFlightDto', () => {
    it('accepts an empty body and a boolean includeQueued', async () => {
        await expect(validate(plainToInstance(CancelFleetInFlightDto, {}))).resolves.toHaveLength(
            0,
        );
        await expect(
            validate(plainToInstance(CancelFleetInFlightDto, { includeQueued: true })),
        ).resolves.toHaveLength(0);
    });

    it('rejects a non-boolean includeQueued', async () => {
        const errors = await validate(
            plainToInstance(CancelFleetInFlightDto, { includeQueued: 'yes' }),
        );
        expect(errors.map((error) => error.property)).toContain('includeQueued');
    });
});
