import { AgentRunSweeperService } from '../agent-run-sweeper.service';
import { QUEUED_REASON_AGENT_PAUSED } from '../run-dispatch-gate.service';

/**
 * AW-23 — work held because its Agent is paused is never reaped.
 *
 * Pause promises "nothing is lost". An agent paused over a weekend
 * outlives any stuck-run TTL by days, so without this exemption the
 * sweeper would quietly fail every held run and the promise would be a
 * lie. BOTH halves are required and both are pinned here: the SQL
 * predicate the repository is asked for, and the belt-and-braces filter
 * in the service — this service is the last gate before
 * `markStuckFailed`, and an older API replica handing back a held row
 * must still not reap it.
 */
describe('AgentRunSweeperService — runs held by a paused agent are never reaped (AW-23)', () => {
    const ENV_KEYS = [
        'AGENT_RUN_SWEEPER_ENABLED',
        'AGENT_RUN_STUCK_SWEEP_MINUTES',
        'AGENT_RUN_STUCK_SWEEP_BATCH',
        'AGENT_RUN_STALE_PARK_ENABLED',
    ];
    const saved: Record<string, string | undefined> = {};
    let runs: Record<string, jest.Mock>;

    const row = (over: Record<string, unknown> = {}) => ({
        id: 'r1',
        agentId: 'a1',
        triggerKind: 'task',
        status: 'queued',
        startedAt: null,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        workId: 'work-1',
        awaitingInput: false,
        queuedReason: null,
        ...over,
    });

    const makeSvc = () => {
        const svc = new AgentRunSweeperService(runs as never);
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
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('asks the repository to exempt agent-paused rows in the SQL', async () => {
        await makeSvc().sweepStuckRuns();
        expect(runs.findStuckNonTerminal).toHaveBeenCalledWith(
            expect.any(Date),
            expect.any(Number),
            expect.arrayContaining([QUEUED_REASON_AGENT_PAUSED]),
        );
    });

    it('re-asserts the exemption in the service: a held row handed back is not reaped', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            row({ id: 'held', queuedReason: QUEUED_REASON_AGENT_PAUSED }),
        ]);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(0);
        expect(summary.scanned).toBe(0);
        expect(runs.markStuckFailed).not.toHaveBeenCalled();
    });

    it('still reaps a genuinely stuck queued row in the same batch', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            row({ id: 'held', queuedReason: QUEUED_REASON_AGENT_PAUSED }),
            row({ id: 'dead', queuedReason: null }),
        ]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(1);
        expect(runs.markStuckFailed).toHaveBeenCalledWith(['dead'], expect.any(String));
    });
});
