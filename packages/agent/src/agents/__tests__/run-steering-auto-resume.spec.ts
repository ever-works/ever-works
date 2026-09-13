import { ConflictException } from '@nestjs/common';
import { RunSteeringService } from '../run-steering.service';

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the one status
 * `resume` learned to accept, and everything it still refuses.
 *
 * Why this needed a widening at all: a red build arrives MINUTES after
 * the run that pushed the branch has ended cleanly, so the run the fix
 * loop must continue is always `completed`. Before this, `resume` threw
 * 409 for it, which would have made the whole slice inert.
 *
 * The risk of the widening is the opposite one — that the human Resume
 * button, or a webhook, starts reviving runs nobody meant to revive. So
 * every assertion below is about what did NOT become resumable.
 */
describe('RunSteeringService — auto-resume widening (slice AC)', () => {
    const baseRun = {
        id: 'run-old',
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        workId: 'work-1',
        status: 'completed',
        awaitingInput: false,
        terminalEndedReason: null as string | null,
        cliSessionId: 'cli-abc',
        organizationId: null,
        tenantId: null,
        persistent: false,
        runnerKind: null,
    };

    let runs: any;
    let dispatcher: any;

    function makeSvc(): RunSteeringService {
        const svc = new RunSteeringService(runs, undefined, dispatcher);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    beforeEach(() => {
        runs = {
            findByIdAndUser: jest.fn().mockResolvedValue({ ...baseRun }),
            createQueued: jest.fn().mockResolvedValue({ id: 'run-new' }),
            seedResumeContext: jest.fn().mockResolvedValue(undefined),
            setAwaitingInput: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-1' }) };
    });

    describe('isAutoResumable', () => {
        const shape = (over: Record<string, unknown>) => ({
            status: 'completed',
            awaitingInput: false,
            terminalEndedReason: null,
            ...over,
        });

        it('accepts a normally finished run, which plain isResumable refuses', () => {
            const run = shape({}) as never;
            expect(RunSteeringService.isResumable(run)).toBe(false);
            expect(RunSteeringService.isAutoResumable(run)).toBe(true);
        });

        it('still accepts everything the human path accepts', () => {
            for (const run of [
                shape({ awaitingInput: true }),
                shape({ terminalEndedReason: 'parked' }),
            ]) {
                expect(RunSteeringService.isAutoResumable(run as never)).toBe(true);
            }
        });

        it('refuses a live, failed or cancelled run — a cancel is a human stop', () => {
            for (const status of ['queued', 'running', 'failed', 'cancelled']) {
                expect(RunSteeringService.isAutoResumable(shape({ status }) as never)).toBe(false);
            }
        });
    });

    it('refuses a completed run WITHOUT the flag — the human Resume button is unchanged', async () => {
        await expect(makeSvc().resume('run-old', 'user-1')).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(runs.createQueued).not.toHaveBeenCalled();
    });

    it('resumes a completed run WITH the flag, through the ordinary dispatch path', async () => {
        const outcome = await makeSvc().resumeRun({
            runId: 'run-old',
            userId: 'user-1',
            allowCompleted: true,
        });
        expect(outcome).toMatchObject({ runId: 'run-new', resumedFromRunId: 'run-old' });
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 'task-1', userId: 'user-1' }),
        );
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ dedupKey: 'task-1:agent-1:resume:run-new' }),
        );
    });

    it('still refuses a cancelled run even with the flag', async () => {
        runs.findByIdAndUser.mockResolvedValue({ ...baseRun, status: 'cancelled' });
        await expect(
            makeSvc().resumeRun({ runId: 'run-old', userId: 'user-1', allowCompleted: true }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(runs.createQueued).not.toHaveBeenCalled();
    });

    it('still refuses a heartbeat run with no Task', async () => {
        runs.findByIdAndUser.mockResolvedValue({ ...baseRun, taskId: null });
        await expect(
            makeSvc().resumeRun({ runId: 'run-old', userId: 'user-1', allowCompleted: true }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('is owner-scoped: a run the acting user does not own is a 404, not a resume', async () => {
        runs.findByIdAndUser.mockResolvedValue(null);
        await expect(
            makeSvc().resumeRun({ runId: 'run-old', userId: 'someone-else', allowCompleted: true }),
        ).rejects.toThrow(/not found/);
        expect(runs.createQueued).not.toHaveBeenCalled();
    });

    it('seeds a caller message when one is given, and nothing when it is not', async () => {
        await makeSvc().resumeRun({
            runId: 'run-old',
            userId: 'user-1',
            message: 'CI is red on lint-and-test.',
            allowCompleted: true,
        });
        expect(runs.seedResumeContext).toHaveBeenCalledWith('run-new', {
            cliSessionId: 'cli-abc',
            pendingInput: ['CI is red on lint-and-test.'],
        });

        runs.seedResumeContext.mockClear();
        await makeSvc().resumeRun({ runId: 'run-old', userId: 'user-1', allowCompleted: true });
        expect(runs.seedResumeContext).toHaveBeenCalledWith('run-new', {
            cliSessionId: 'cli-abc',
            pendingInput: null,
        });
    });

    it('stamps the audit row as an AUTOMATED resume', async () => {
        const runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        const svc = new RunSteeringService(runs, runLogs as never, dispatcher);
        jest.spyOn(
            (svc as never as { logger: Record<string, () => void> }).logger,
            'log',
        ).mockImplementation(() => undefined);

        await svc.resumeRun({ runId: 'run-old', userId: 'user-1', allowCompleted: true });
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ action: 'resume', autoResume: true }),
            }),
        );

        runLogs.append.mockClear();
        runs.findByIdAndUser.mockResolvedValue({ ...baseRun, awaitingInput: true });
        await svc.resume('run-old', 'user-1', 'my answer');
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ autoResume: false }),
            }),
        );
    });
});
