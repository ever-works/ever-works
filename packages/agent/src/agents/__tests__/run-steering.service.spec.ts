import { ConflictException, NotFoundException } from '@nestjs/common';
import { RunSteeringService } from '../run-steering.service';

/**
 * Run steering (Wave 4 M5) — steer / interrupt / resume.
 *
 * The load-bearing behaviours, each called out inline:
 *  - steer on a LIVE run injects (does not spawn a second run);
 *  - steer on a TERMINAL run refuses to inject and tells the caller to start
 *    a new one — the whole point of the routing rule;
 *  - resume carries `cliSessionId`, which is what makes it a *resume* rather
 *    than a fresh conversation.
 */
describe('RunSteeringService', () => {
    const userId = 'user-1';
    const runId = 'run-1';

    let runs: any;
    let runLogs: any;
    let dispatcher: any;
    let gate: any;

    function makeRun(over: Record<string, unknown> = {}) {
        return {
            id: runId,
            agentId: 'agent-1',
            userId,
            status: 'running',
            taskId: 'task-1',
            workId: 'work-1',
            organizationId: 'org-1',
            awaitingInput: false,
            terminalEndedReason: null,
            cliSessionId: null,
            runnerKind: null,
            pendingInput: null,
            ...over,
        };
    }

    function makeSvc(): RunSteeringService {
        const svc = new RunSteeringService(runs, runLogs, dispatcher, gate);
        for (const level of ['log', 'warn'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    beforeEach(() => {
        runs = {
            findByIdAndUser: jest.fn().mockResolvedValue(makeRun()),
            findById: jest.fn().mockResolvedValue(makeRun({ pendingInput: ['hi'] })),
            appendPendingInput: jest.fn().mockResolvedValue(true),
            requestInterrupt: jest.fn().mockResolvedValue(true),
            setAwaitingInput: jest.fn().mockResolvedValue(undefined),
            seedResumeContext: jest.fn().mockResolvedValue(undefined),
            createQueued: jest.fn().mockResolvedValue({ id: 'run-2' }),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-run-2' }) };
        gate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
    });

    afterEach(() => jest.restoreAllMocks());

    // ── steer ──────────────────────────────────────────────────────

    describe('steer', () => {
        it('⭐ injects into a RUNNING run instead of starting a second one', async () => {
            const result = await makeSvc().steer({ runId, userId, message: 'use fixture data' });
            expect(result.dispatched).toBe('injected');
            expect(result.runId).toBe(runId);
            expect(runs.appendPendingInput).toHaveBeenCalledWith(runId, 'use fixture data');
            expect(runs.createQueued).not.toHaveBeenCalled();
        });

        it('injects into a QUEUED run too — a run that has not started yet still takes input', async () => {
            runs.findByIdAndUser.mockResolvedValue(makeRun({ status: 'queued' }));
            const result = await makeSvc().steer({ runId, userId, message: 'wait for me' });
            expect(result.dispatched).toBe('injected');
            expect(runs.appendPendingInput).toHaveBeenCalled();
        });

        it('⭐ answers new-run for a TERMINAL run and injects nothing', async () => {
            // THE ROUTING RULE. Injecting into a finished run would silently
            // swallow the user's message: nothing is left to read the queue.
            runs.findByIdAndUser.mockResolvedValue(makeRun({ status: 'completed' }));
            const result = await makeSvc().steer({ runId, userId, message: 'and now deploy' });
            expect(result.dispatched).toBe('new-run');
            expect(runs.appendPendingInput).not.toHaveBeenCalled();
        });

        it('answers new-run when the append loses the race with a terminal write', async () => {
            runs.appendPendingInput.mockResolvedValue(false);
            const result = await makeSvc().steer({ runId, userId, message: 'ping' });
            expect(result.dispatched).toBe('new-run');
        });

        it('404s a run owned by another user (no existence oracle)', async () => {
            runs.findByIdAndUser.mockResolvedValue(null);
            await expect(
                makeSvc().steer({ runId, userId: 'someone-else', message: 'ping' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('rejects an empty message rather than queueing whitespace', async () => {
            await expect(makeSvc().steer({ runId, userId, message: '   ' })).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(runs.appendPendingInput).not.toHaveBeenCalled();
        });

        it('stamps the acting user on the run (executor stamping)', async () => {
            await makeSvc().steer({ runId, userId, message: 'ping' });
            expect(runLogs.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    runId,
                    step: 'steering',
                    metadata: expect.objectContaining({ action: 'steer', actorUserId: userId }),
                }),
            );
        });
    });

    // ── interrupt ──────────────────────────────────────────────────

    describe('interrupt', () => {
        it('⭐ records the cooperative stop flag on a live run', async () => {
            const result = await makeSvc().interrupt(runId, userId);
            expect(result).toEqual({ interrupted: true, runId });
            expect(runs.requestInterrupt).toHaveBeenCalledWith(runId);
        });

        it('409s on an already-terminal run (no meaningful fallback action)', async () => {
            runs.findByIdAndUser.mockResolvedValue(makeRun({ status: 'completed' }));
            await expect(makeSvc().interrupt(runId, userId)).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(runs.requestInterrupt).not.toHaveBeenCalled();
        });

        it('409s when the CAS loses to a terminal write mid-flight', async () => {
            runs.requestInterrupt.mockResolvedValue(false);
            await expect(makeSvc().interrupt(runId, userId)).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('404s a run owned by another user', async () => {
            runs.findByIdAndUser.mockResolvedValue(null);
            await expect(makeSvc().interrupt(runId, userId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    // ── resume ─────────────────────────────────────────────────────

    describe('resume', () => {
        const parked = () =>
            makeRun({
                status: 'completed',
                terminalEndedReason: 'parked',
                cliSessionId: 'cli-session-abc',
            });

        it('⭐ carries cliSessionId onto the NEW run — that is what makes it a resume', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            const result = await makeSvc().resume(runId, userId, 'yes, ship it');
            expect(result).toEqual(
                expect.objectContaining({
                    dispatched: 'new-run',
                    runId: 'run-2',
                    resumedFromRunId: runId,
                    carriedCliSession: true,
                    queued: false,
                }),
            );
            expect(runs.seedResumeContext).toHaveBeenCalledWith('run-2', {
                cliSessionId: 'cli-session-abc',
                pendingInput: ['yes, ship it'],
            });
        });

        it('resumes an awaiting-input run and clears its parked flag', async () => {
            runs.findByIdAndUser.mockResolvedValue(
                makeRun({ status: 'completed', awaitingInput: true }),
            );
            await makeSvc().resume(runId, userId, 'option B');
            expect(runs.setAwaitingInput).toHaveBeenCalledWith(runId, false);
        });

        it('resumes with no message at all ("carry on")', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            await makeSvc().resume(runId, userId, null);
            expect(runs.seedResumeContext).toHaveBeenCalledWith('run-2', {
                cliSessionId: 'cli-session-abc',
                pendingInput: null,
            });
        });

        it('dispatches the new run with a run-scoped dedup key', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            await makeSvc().resume(runId, userId);
            expect(dispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({
                    agentId: 'agent-1',
                    taskId: 'task-1',
                    runId: 'run-2',
                    dedupKey: 'task-1:agent-1:resume:run-2',
                }),
            );
            expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-2', 'trigger-run-2');
        });

        it('parks the resumed run (and skips the enqueue) when the gate refuses admission', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            gate.admit.mockResolvedValue({ admitted: false, queuedReason: 'concurrency-limit' });
            const result = await makeSvc().resume(runId, userId);
            expect(result.queued).toBe(true);
            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({ queuedReason: 'concurrency-limit' }),
            );
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('409s a run that is still live — resume is not a second dispatch button', async () => {
            runs.findByIdAndUser.mockResolvedValue(makeRun({ status: 'running' }));
            await expect(makeSvc().resume(runId, userId)).rejects.toBeInstanceOf(ConflictException);
            expect(runs.createQueued).not.toHaveBeenCalled();
        });

        it('409s a run that ended for a non-parked reason', async () => {
            runs.findByIdAndUser.mockResolvedValue(
                makeRun({ status: 'failed', terminalEndedReason: 'crashed' }),
            );
            await expect(makeSvc().resume(runId, userId)).rejects.toBeInstanceOf(ConflictException);
        });

        it('409s a parked run with no Task — nothing to dispatch onto', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            runs.findByIdAndUser.mockResolvedValue({ ...parked(), taskId: null });
            await expect(makeSvc().resume(runId, userId)).rejects.toBeInstanceOf(ConflictException);
            expect(runs.createQueued).not.toHaveBeenCalled();
        });

        it('rolls the new run to dispatch-failed when the enqueue throws', async () => {
            runs.findByIdAndUser.mockResolvedValue(parked());
            dispatcher.enqueue.mockRejectedValue(new Error('runtime down'));
            await expect(makeSvc().resume(runId, userId)).rejects.toBeInstanceOf(ConflictException);
            expect(runs.markDispatchFailed).toHaveBeenCalledWith(
                'run-2',
                expect.stringContaining('dispatch-failed'),
            );
        });

        it('404s a run owned by another user', async () => {
            runs.findByIdAndUser.mockResolvedValue(null);
            await expect(makeSvc().resume(runId, userId)).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
