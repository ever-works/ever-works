import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Heartbeat cancel accounting.
 *
 * `agent-heartbeat.task.ts` decides the Agent's post-run fate with:
 *
 *   const completed = result.status === 'assembled' || result.status === 'dispatched';
 *
 * Widening `AgentRunExecuteResult['status']` with `'cancelled'` compiles
 * perfectly against that line and silently routes a cancelled run into the
 * `else` branch — `incrementErrorCount` — so every user cancel would count
 * toward `pauseAfterFailures` until the Agent auto-pauses. TypeScript cannot
 * catch it. This spec is the guard.
 */
const {
    taskMock,
    createApplicationContextMock,
    createTriggerLoggerMock,
    StubInternalModule,
    AgentRepositoryToken,
    AgentRunRepositoryToken,
    AgentRunServiceToken,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class AgentRepositoryToken {}
    class AgentRunRepositoryToken {}
    class AgentRunServiceToken {}
    return {
        taskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        createTriggerLoggerMock: vi.fn().mockReturnValue({ __kind: 'trigger-logger' }),
        StubInternalModule,
        AgentRepositoryToken,
        AgentRunRepositoryToken,
        AgentRunServiceToken,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('@ever-works/agent/database', () => ({
    AgentRepository: AgentRepositoryToken,
    AgentRunRepository: AgentRunRepositoryToken,
}));

vi.mock('@ever-works/agent/agents', () => ({
    AgentRunService: AgentRunServiceToken,
    computeNextHeartbeat: () => new Date('2026-01-01T00:05:00Z'),
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: createTriggerLoggerMock,
}));

type TaskConfig = {
    id: string;
    run: (payload: any, params?: any) => Promise<any>;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

describe('agentHeartbeatTask — cancelled run accounting', () => {
    let agents: any;
    let runs: any;
    let runner: any;
    let registeredConfig: TaskConfig;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();

        agents = {
            findByIdAndUser: vi.fn().mockResolvedValue({
                id: AGENT_ID,
                userId: OWNER,
                heartbeatCadence: '*/5 * * * *',
            }),
            findById: vi.fn().mockResolvedValue({
                id: AGENT_ID,
                userId: OWNER,
                heartbeatCadence: '*/5 * * * *',
            }),
            releaseAfterRun: vi.fn().mockResolvedValue(undefined),
            incrementErrorCount: vi.fn().mockResolvedValue(undefined),
        };
        runs = {
            findById: vi.fn().mockResolvedValue(null),
            findInFlightForAgent: vi.fn().mockResolvedValue(null),
            createQueued: vi.fn().mockResolvedValue({ id: 'run-1', status: 'queued' }),
            markStarted: vi.fn().mockResolvedValue(true),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
        };
        runner = { execute: vi.fn().mockResolvedValue({ status: 'dispatched' }) };

        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === AgentRepositoryToken) return agents;
                if (token === AgentRunRepositoryToken) return runs;
                if (token === AgentRunServiceToken) return runner;
                throw new Error(`Unexpected DI token: ${String(token)}`);
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });

        await import('../tasks/trigger/agent-heartbeat.task');
        const lastCall = taskMock.mock.calls[taskMock.mock.calls.length - 1];
        registeredConfig = lastCall[0] as TaskConfig;
    });

    const payload = {
        agentId: AGENT_ID,
        userId: OWNER,
        scheduledFor: '2026-01-01T00:00:00Z',
    };

    it('releases the Agent as cancelled and does NOT count an error', async () => {
        runner.execute.mockResolvedValueOnce({ status: 'cancelled' });

        await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(agents.releaseAfterRun).toHaveBeenCalledWith(
            AGENT_ID,
            expect.anything(),
            'cancelled',
        );
        // The regression this file exists for: without the explicit cancelled
        // arm, a user cancel walks agents toward auto-pause.
        expect(agents.incrementErrorCount).not.toHaveBeenCalled();
    });

    it('still counts a genuine dispatch failure as an error', async () => {
        runner.execute.mockResolvedValueOnce({ status: 'dispatch-failed' });

        await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(agents.incrementErrorCount).toHaveBeenCalled();
        expect(agents.releaseAfterRun).not.toHaveBeenCalledWith(
            AGENT_ID,
            expect.anything(),
            'cancelled',
        );
    });

    it('abandons the run when markStarted loses the CAS, without executing', async () => {
        // The row went terminal first — a user cancel, or the stuck-run sweeper
        // reaping it. Executing anyway burns the work and then loses it, because
        // the terminal write at the end no-ops against the same guard.
        runs.markStarted.mockResolvedValueOnce(false);

        const result = await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(runner.execute).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ reason: 'run-already-terminal' }));
    });

    it('still releases a completed run as completed', async () => {
        runner.execute.mockResolvedValueOnce({ status: 'dispatched' });

        await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(agents.releaseAfterRun).toHaveBeenCalledWith(
            AGENT_ID,
            expect.anything(),
            'completed',
        );
        expect(agents.incrementErrorCount).not.toHaveBeenCalled();
    });
});
