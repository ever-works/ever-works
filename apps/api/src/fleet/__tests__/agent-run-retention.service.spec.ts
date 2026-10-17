import { Logger } from '@nestjs/common';
import { AgentRunRetentionService } from '../agent-run-retention.service';

/**
 * Self-build slice AT — the nightly agent run retention pass: the windows it
 * computes, the "logs first, stamp second" order, the opt-in row purge, the
 * lock, the off switch, and that a failure never escapes a cron tick.
 */
describe('AgentRunRetentionService', () => {
    const NOW = new Date('2026-10-17T03:45:00.000Z');
    const DAY = 86_400_000;
    const env = { ...process.env };

    let runs: {
        findLogRetentionCandidates: jest.Mock;
        markLogsPurged: jest.Mock;
        deleteRetainedRuns: jest.Mock;
    };
    let runLogs: { deleteForRuns: jest.Mock };
    let taskLock: { runExclusive: jest.Mock };
    let order: string[];

    beforeEach(() => {
        order = [];
        runs = {
            findLogRetentionCandidates: jest.fn().mockResolvedValue([]),
            markLogsPurged: jest.fn(async (ids: string[]) => {
                order.push('mark');
                return ids.length;
            }),
            deleteRetainedRuns: jest.fn().mockResolvedValue(0),
        };
        runLogs = {
            deleteForRuns: jest.fn(async (ids: string[]) => {
                order.push('delete-logs');
                return ids.length * 10;
            }),
        };
        taskLock = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        for (const level of ['log', 'warn', 'error', 'debug'] as const) {
            jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
        }
        delete process.env.AGENT_RUN_LOG_RETENTION_DAYS;
        delete process.env.AGENT_RUN_RETENTION_DAYS;
        delete process.env.AGENT_RUN_RETENTION_ENABLED;
    });

    afterEach(() => {
        process.env = { ...env };
        jest.restoreAllMocks();
    });

    const service = () =>
        new AgentRunRetentionService(runs as never, runLogs as never, taskLock as never);

    it('purges timelines older than 90 days by default, logs before the stamp, and keeps run rows', async () => {
        runs.findLogRetentionCandidates
            .mockResolvedValueOnce(['r1', 'r2'])
            .mockResolvedValueOnce([]);

        const summary = await service().purge(NOW, 2);

        const [cutoff, batch] = runs.findLogRetentionCandidates.mock.calls[0];
        expect((cutoff as Date).toISOString()).toBe(
            new Date(NOW.getTime() - 90 * DAY).toISOString(),
        );
        expect(batch).toBe(2);
        expect(order).toEqual(['delete-logs', 'mark']);
        expect(runs.markLogsPurged).toHaveBeenCalledWith(['r1', 'r2'], NOW);
        expect(summary).toEqual({ runsWithLogsPurged: 2, logRowsDeleted: 20, runsDeleted: 0 });
        // Row deletion is opt-in.
        expect(runs.deleteRetainedRuns).not.toHaveBeenCalled();
    });

    it('stops at a short batch and at the per-pass ceiling', async () => {
        runs.findLogRetentionCandidates.mockResolvedValue(['a', 'b']);
        await service().purge(NOW, 2, 3);
        expect(runs.findLogRetentionCandidates).toHaveBeenCalledTimes(3);

        runs.findLogRetentionCandidates.mockReset().mockResolvedValueOnce(['a']);
        await service().purge(NOW, 2, 3);
        expect(runs.findLogRetentionCandidates).toHaveBeenCalledTimes(1);
    });

    it('deletes run rows only when AGENT_RUN_RETENTION_DAYS is set, clamped to at least 30 days', async () => {
        process.env.AGENT_RUN_RETENTION_DAYS = '7';
        runs.deleteRetainedRuns.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

        const summary = await service().purge(NOW, 2);

        const [cutoff] = runs.deleteRetainedRuns.mock.calls[0];
        expect((cutoff as Date).toISOString()).toBe(
            new Date(NOW.getTime() - 30 * DAY).toISOString(),
        );
        expect(summary.runsDeleted).toBe(3);
    });

    it('honours AGENT_RUN_LOG_RETENTION_DAYS and never goes below 7 days', async () => {
        process.env.AGENT_RUN_LOG_RETENTION_DAYS = '1';
        await service().purge(NOW);
        const [cutoff] = runs.findLogRetentionCandidates.mock.calls[0];
        expect((cutoff as Date).toISOString()).toBe(
            new Date(NOW.getTime() - 7 * DAY).toISOString(),
        );
    });

    it('runs under the distributed lock, is switched off by AGENT_RUN_RETENTION_ENABLED=false, and swallows failures', async () => {
        await service().purgeExpiredRuns();
        expect(taskLock.runExclusive).toHaveBeenCalledWith(
            'agent-runs:retention',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 3_600_000 }),
        );

        process.env.AGENT_RUN_RETENTION_ENABLED = 'false';
        taskLock.runExclusive.mockClear();
        await service().purgeExpiredRuns();
        expect(taskLock.runExclusive).not.toHaveBeenCalled();

        delete process.env.AGENT_RUN_RETENTION_ENABLED;
        runs.findLogRetentionCandidates.mockRejectedValue(new Error('db down'));
        await expect(service().purgeExpiredRuns()).resolves.toBeUndefined();
    });
});
