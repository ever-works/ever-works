import { AgentRunSweeperService } from '../agent-run-sweeper.service';
import { QUEUED_REASON_APP_CHANGES_PAUSED } from '../run-admission-chain';

/**
 * APW-08 T49 (XC-10, FR-74, R-30) — an App Work run parked while the operator had changes off
 * (`app-changes-paused`) is a WAIT: never reaped as stuck, and released by the sweeper's tick once
 * `EVER_WORKS_APP_CHANGES_ENABLED` is on again ("turning it back on resumes"). While the switch is
 * off nothing is read or released.
 */
describe('AgentRunSweeperService — runs parked by the App changes switch (APW-08 T49)', () => {
    const ENV_KEYS = [
        'EVER_WORKS_APP_CHANGES_ENABLED',
        'AGENT_RUN_SWEEPER_ENABLED',
        'AGENT_RUN_STUCK_SWEEP_MINUTES',
        'AGENT_RUN_STUCK_SWEEP_BATCH',
        'AGENT_RUN_STALE_PARK_ENABLED',
    ];
    const saved: Record<string, string | undefined> = {};
    let runs: Record<string, jest.Mock>;
    let gate: { promoteParked: jest.Mock; drainForWork: jest.Mock };

    const row = (over: Record<string, unknown> = {}) => ({
        id: 'r1',
        agentId: 'a1',
        triggerKind: 'task',
        status: 'queued',
        startedAt: null,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        workId: 'work-app',
        awaitingInput: false,
        queuedReason: null,
        ...over,
    });

    const makeSvc = () => {
        const svc = new AgentRunSweeperService(runs as never, gate as never);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    };

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        runs = {
            findStuckNonTerminal: jest.fn().mockResolvedValue([]),
            markStuckFailed: jest.fn().mockResolvedValue(0),
            parkStaleRunning: jest.fn().mockResolvedValue(0),
            findQueuedTooLong: jest.fn().mockResolvedValue([]),
            setAttention: jest.fn().mockResolvedValue(true),
            findById: jest.fn().mockResolvedValue(null),
        };
        gate = {
            promoteParked: jest.fn().mockResolvedValue({ promoted: 0, works: 0 }),
            // The sweeper drains the Works it reaped runs from.
            drainForWork: jest.fn().mockResolvedValue({ dispatched: false }),
        };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('never reaps a parked App Work run: exempt in the SQL and re-asserted in the service', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            row({ id: 'held', queuedReason: QUEUED_REASON_APP_CHANGES_PAUSED }),
            row({ id: 'dead', queuedReason: null }),
        ]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(runs.findStuckNonTerminal).toHaveBeenCalledWith(
            expect.any(Date),
            expect.any(Number),
            expect.arrayContaining([QUEUED_REASON_APP_CHANGES_PAUSED]),
        );
        expect(runs.markStuckFailed).toHaveBeenCalledWith(['dead'], expect.any(String));
        expect(summary.swept).toBe(1);
    });

    it('releases them on the tick once changes are ON (unset is on), through the gate', async () => {
        await makeSvc().sweepStuckRuns();
        expect(gate.promoteParked).toHaveBeenCalledWith(QUEUED_REASON_APP_CHANGES_PAUSED);
    });

    it('while the switch is OFF it releases nothing (a release would start a stopped change)', async () => {
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        const svc = makeSvc();
        await svc.releaseAppChangesWaits();
        await svc.sweepStuckRuns();
        expect(gate.promoteParked).not.toHaveBeenCalledWith(QUEUED_REASON_APP_CHANGES_PAUSED);
    });

    it('a release that throws never fails the tick', async () => {
        gate.promoteParked.mockRejectedValue(new Error('gate down'));
        await expect(makeSvc().releaseAppChangesWaits()).resolves.toBeUndefined();
    });
});
