import { describe, it, expect, vi, beforeEach } from 'vitest';

const { taskMock, loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
    taskMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: vi.fn() },
    logger: {
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

type RetryConfig = {
    maxAttempts: number;
    factor: number;
    minTimeoutInMs: number;
    maxTimeoutInMs: number;
    randomize: boolean;
};

type TaskConfig = {
    id: string;
    maxDuration: number;
    retry: RetryConfig;
    run: (payload: { onboardingId: string; workId: string }) => Promise<{
        onboardingId: string;
        workId: string;
        status: string;
    }>;
};

let registeredConfig: TaskConfig;

describe('workOnboardingTask', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();

        await import('../tasks/trigger/work-onboarding.task');
        const lastCall = taskMock.mock.calls[taskMock.mock.calls.length - 1];
        registeredConfig = lastCall[0] as TaskConfig;
    });

    describe('registration', () => {
        it('registers a task with id "work-onboarding"', () => {
            expect(registeredConfig.id).toBe('work-onboarding');
        });

        it('declares a 2-hour maxDuration (mirrors work-import)', () => {
            expect(registeredConfig.maxDuration).toBe(3600 * 2);
        });

        it('configures retry with 3 attempts, exponential factor 2, 30s..5min envelope, randomize jitter', () => {
            expect(registeredConfig.retry).toEqual({
                maxAttempts: 3,
                factor: 2,
                minTimeoutInMs: 30_000,
                maxTimeoutInMs: 5 * 60_000,
                randomize: true,
            });
        });

        it('exposes a run() handler', () => {
            expect(typeof registeredConfig.run).toBe('function');
        });
    });

    describe('run()', () => {
        it('returns {onboardingId, workId, status:"handoff-pending"} envelope', async () => {
            const result = await registeredConfig.run({
                onboardingId: 'onb-1',
                workId: 'w-1',
            });

            expect(result).toEqual({
                onboardingId: 'onb-1',
                workId: 'w-1',
                status: 'handoff-pending',
            });
        });

        it('logs the start event with the full payload via logger.info', async () => {
            await registeredConfig.run({ onboardingId: 'onb-9', workId: 'w-9' });

            expect(loggerInfoMock).toHaveBeenCalledWith(
                'work-onboarding.start',
                expect.objectContaining({ onboardingId: 'onb-9', workId: 'w-9' }),
            );
        });

        it('logs a deferred-handoff warning carrying the workId via logger.warn', async () => {
            await registeredConfig.run({ onboardingId: 'onb-9', workId: 'w-42' });

            expect(loggerWarnMock).toHaveBeenCalledWith(
                expect.stringContaining('handoff_pending'),
                expect.objectContaining({ workId: 'w-42' }),
            );
        });

        it('returns a fresh object on each call (no shared envelope reference)', async () => {
            const a = await registeredConfig.run({ onboardingId: 'a', workId: 'a' });
            const b = await registeredConfig.run({ onboardingId: 'b', workId: 'b' });
            expect(a).not.toBe(b);
        });
    });
});
