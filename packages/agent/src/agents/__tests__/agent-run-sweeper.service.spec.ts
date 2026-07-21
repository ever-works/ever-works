import { AgentRunSweeperService, STUCK_SWEEP_PREFIX } from '../agent-run-sweeper.service';

/**
 * Stuck-run sweeper.
 *
 * Two tests here carry the entire safety argument and are called out inline:
 * one proves the sweep actually reaps (a no-op implementation would pass every
 * other test in this file), the other proves a live run is NOT reaped.
 */
describe('AgentRunSweeperService', () => {
    const ENV_KEYS = [
        'AGENT_RUN_SWEEPER_ENABLED',
        'AGENT_RUN_STUCK_SWEEP_MINUTES',
        'AGENT_RUN_STUCK_SWEEP_BATCH',
        'AGENT_MAX_RUN_DURATION_SECONDS',
    ];
    let saved: Record<string, string | undefined>;
    let runs: any;
    let warn: jest.SpyInstance;

    function makeSvc(): AgentRunSweeperService {
        const svc = new AgentRunSweeperService(runs);
        warn = jest.spyOn((svc as never as { logger: { warn: () => void } }).logger, 'warn');
        warn.mockImplementation(() => undefined);
        jest.spyOn(
            (svc as never as { logger: { log: () => void } }).logger,
            'log',
        ).mockImplementation(() => undefined);
        return svc;
    }

    function stuckRow(over: Record<string, unknown> = {}) {
        return {
            id: 'r1',
            agentId: 'a1',
            triggerKind: 'task',
            status: 'running',
            startedAt: new Date(Date.now() - 24 * 60 * 60_000),
            createdAt: new Date(Date.now() - 24 * 60 * 60_000),
            ...over,
        };
    }

    beforeEach(() => {
        saved = {};
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        runs = {
            findStuckNonTerminal: jest.fn().mockResolvedValue([]),
            markStuckFailed: jest.fn().mockResolvedValue(0),
        };
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        jest.restoreAllMocks();
    });

    it('⭐ reaps a run older than the cutoff', async () => {
        // THE NO-OP CATCHER. An implementation that returns { swept: 0 }
        // unconditionally passes every safety test in this file — only this
        // one fails it.
        runs.findStuckNonTerminal.mockResolvedValue([stuckRow()]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(1);
        expect(runs.markStuckFailed).toHaveBeenCalledWith(['r1'], expect.any(String));
    });

    it('⭐ uses a cutoff far longer than the longest agent run, so a live run is never reaped', async () => {
        // THE LIVE-RUN TEST. agent-task-execute pins maxDuration 3600s, so a
        // cutoff at or below 60m could reap a run that is still executing —
        // destroying its result while its side effects still fire. This line
        // fails loudly if anyone "simplifies" the config to reuse
        // getStuckTimeoutMinutes() (60m).
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.cutoffMinutes).toBeGreaterThan(60);

        const cutoff: Date = runs.findStuckNonTerminal.mock.calls[0][0];
        const ageMinutes = (Date.now() - cutoff.getTime()) / 60_000;
        expect(ageMinutes).toBeGreaterThan(60);
        expect(Math.round(ageMinutes)).toBe(summary.cutoffMinutes);
    });

    it('clamps a dangerously low configured cutoff up to the retry-chain floor', async () => {
        // Without the floor clamp this silently reintroduces the exact bug the
        // previous test guards against.
        process.env.AGENT_RUN_STUCK_SWEEP_MINUTES = '5';
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.cutoffMinutes).toBeGreaterThanOrEqual(180);
    });

    it('sweeps a queued row that never started, keyed on createdAt', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            stuckRow({ status: 'queued', startedAt: null, triggerKind: 'heartbeat' }),
        ]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(1);
        expect(summary.byKind).toEqual({ heartbeat: 1 });
    });

    it('reports what the CAS actually transitioned, not the number scanned', async () => {
        // A worker that finished in the gap wins the CAS. Reporting ids.length
        // would overstate every sweep that loses that race.
        runs.findStuckNonTerminal.mockResolvedValue([
            stuckRow({ id: 'r1' }),
            stuckRow({ id: 'r2' }),
            stuckRow({ id: 'r3' }),
        ]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.scanned).toBe(3);
        expect(summary.swept).toBe(1);
    });

    it('uses a distinct errorMessage prefix that cannot collide with the dispatch prefixes', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([stuckRow()]);
        runs.markStuckFailed.mockResolvedValue(1);
        await makeSvc().sweepStuckRuns();
        const message: string = runs.markStuckFailed.mock.calls[0][1];
        expect(message).toContain(STUCK_SWEEP_PREFIX);
        // Existing specs pin these with toContain — a collision would make them
        // pass against a swept run.
        expect(message).not.toContain('dispatch-failed');
        expect(message).not.toContain('enqueue-failed');
    });

    it('flags a full batch loudly instead of truncating silently', async () => {
        process.env.AGENT_RUN_STUCK_SWEEP_BATCH = '2';
        runs.findStuckNonTerminal.mockResolvedValue([
            stuckRow({ id: 'r1' }),
            stuckRow({ id: 'r2' }),
        ]);
        runs.markStuckFailed.mockResolvedValue(2);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.batchLimitReached).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('batch limit'));
    });

    it('does nothing and touches no rows when disabled', async () => {
        process.env.AGENT_RUN_SWEEPER_ENABLED = 'false';
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary).toEqual(expect.objectContaining({ enabled: false, swept: 0 }));
        expect(runs.findStuckNonTerminal).not.toHaveBeenCalled();
        expect(runs.markStuckFailed).not.toHaveBeenCalled();
    });

    it('stays quiet when nothing is stuck', async () => {
        // Prevents WARN-noise regression: the warn is the anomaly signal, so it
        // must not fire on the common path.
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(0);
        expect(warn).not.toHaveBeenCalled();
        expect(runs.markStuckFailed).not.toHaveBeenCalled();
    });

    it('reports oldest age and per-kind counts so an operator can triage', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            stuckRow({
                id: 'r1',
                triggerKind: 'task',
                startedAt: new Date(Date.now() - 90 * 60_000),
            }),
            stuckRow({
                id: 'r2',
                triggerKind: 'chat',
                startedAt: new Date(Date.now() - 600 * 60_000),
            }),
        ]);
        runs.markStuckFailed.mockResolvedValue(2);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.byKind).toEqual({ task: 1, chat: 1 });
        expect(Math.round((summary.oldestAgeMs ?? 0) / 60_000)).toBe(600);
    });
});
