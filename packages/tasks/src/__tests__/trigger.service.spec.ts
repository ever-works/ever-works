import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
    configureMock,
    runsCancelMock,
    workGenTriggerMock,
    workImportTriggerMock,
    triggerConfig,
    subscriptionsConfig,
} = vi.hoisted(() => {
    return {
        configureMock: vi.fn(),
        runsCancelMock: vi.fn(),
        workGenTriggerMock: vi.fn(),
        workImportTriggerMock: vi.fn(),
        triggerConfig: {
            shouldUseTrigger: vi.fn(),
            getSecretKey: vi.fn(),
            getApiUrl: vi.fn(),
            getMachine: vi.fn(),
            getInternalBaseUrl: vi.fn(),
            getInternalSecret: vi.fn(),
        },
        subscriptionsConfig: { getDispatchIntervalMinutes: vi.fn(() => 5) },
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    configure: configureMock,
    runs: { cancel: runsCancelMock },
    task: vi.fn().mockImplementation(() => ({ id: 'mock-task' })),
    schedules: { task: vi.fn().mockImplementation(() => ({ id: 'mock-schedule-task' })) },
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: triggerConfig,
        subscriptions: subscriptionsConfig,
    },
}));

vi.mock('@ever-works/agent/tasks', () => ({
    WORK_GENERATION_DISPATCHER: Symbol('WORK_GENERATION_DISPATCHER'),
    WORK_IMPORT_DISPATCHER: Symbol('WORK_IMPORT_DISPATCHER'),
}));

vi.mock('../tasks/trigger/work-generation.task', () => ({
    workGenerationTask: { trigger: workGenTriggerMock },
}));
vi.mock('../tasks/trigger/work-import.task', () => ({
    workImportTask: { trigger: workImportTriggerMock },
}));

import { TriggerService } from '../trigger/trigger.service';

describe('TriggerService', () => {
    let service: TriggerService;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.shouldUseTrigger.mockReturnValue(true);
        triggerConfig.getSecretKey.mockReturnValue('tr_test_secret');
        triggerConfig.getApiUrl.mockReturnValue('https://api.trigger.test');
        triggerConfig.getMachine.mockReturnValue('small-1x');
        service = new TriggerService();
        // Silence Nest Logger noise from intentional error paths in tests.
        vi.spyOn((service as any).logger, 'error').mockImplementation(() => {});
        vi.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('dispatchWorkGeneration', () => {
        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(out).toBeNull();
            expect(configureMock).not.toHaveBeenCalled();
            expect(workGenTriggerMock).not.toHaveBeenCalled();
        });

        it('returns null and skips configure when secret key is missing', async () => {
            triggerConfig.getSecretKey.mockReturnValue('');
            const out = await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(out).toBeNull();
            expect(configureMock).not.toHaveBeenCalled();
        });

        it('configures the SDK on first dispatch and returns the run id', async () => {
            workGenTriggerMock.mockResolvedValue({ id: 'run_123' });

            const out = await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(out).toBe('run_123');
            expect(configureMock).toHaveBeenCalledWith({
                accessToken: 'tr_test_secret',
                baseURL: 'https://api.trigger.test',
            });
            expect(workGenTriggerMock).toHaveBeenCalledWith(
                expect.objectContaining({ workId: 'w1' }),
                expect.objectContaining({
                    tags: ['work-generation', 'full', 'w1'],
                    machine: 'small-1x',
                }),
            );
        });

        it('does not reconfigure on subsequent dispatches', async () => {
            workGenTriggerMock.mockResolvedValue({ id: 'run_a' });
            await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);
            await service.dispatchWorkGeneration({
                workId: 'w2',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(configureMock).toHaveBeenCalledTimes(1);
            expect(workGenTriggerMock).toHaveBeenCalledTimes(2);
        });

        it('passes machine=undefined when getMachine() returns an unsupported value', async () => {
            triggerConfig.getMachine.mockReturnValue('giant-99x');
            workGenTriggerMock.mockResolvedValue({ id: 'run_x' });

            await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(workGenTriggerMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ machine: undefined }),
            );
        });

        it('returns null and logs when trigger() throws', async () => {
            workGenTriggerMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

            const out = await service.dispatchWorkGeneration({
                workId: 'w1',
                userId: 'u1',
                mode: 'full',
            } as any);

            expect(out).toBeNull();
        });
    });

    describe('cancelWorkGeneration', () => {
        it('returns false when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.cancelWorkGeneration('run_x');
            expect(out).toBe(false);
            expect(runsCancelMock).not.toHaveBeenCalled();
        });

        it('returns true when runs.cancel resolves', async () => {
            runsCancelMock.mockResolvedValue(undefined);
            const out = await service.cancelWorkGeneration('run_x');
            expect(out).toBe(true);
            expect(runsCancelMock).toHaveBeenCalledWith('run_x');
        });

        it('returns false when runs.cancel throws', async () => {
            runsCancelMock.mockRejectedValue(new Error('not found'));
            const out = await service.cancelWorkGeneration('run_missing');
            expect(out).toBe(false);
        });
    });

    describe('dispatchWorkImport', () => {
        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchWorkImport({
                workId: 'w1',
                userId: 'u1',
                sourceType: 'github',
            } as any);

            expect(out).toBeNull();
            expect(workImportTriggerMock).not.toHaveBeenCalled();
        });

        it('returns the run id and tags by sourceType + workId on success', async () => {
            workImportTriggerMock.mockResolvedValue({ id: 'imp_42' });

            const out = await service.dispatchWorkImport({
                workId: 'w1',
                userId: 'u1',
                sourceType: 'github',
            } as any);

            expect(out).toBe('imp_42');
            expect(workImportTriggerMock).toHaveBeenCalledWith(
                expect.objectContaining({ workId: 'w1', sourceType: 'github' }),
                expect.objectContaining({
                    tags: ['work-import', 'github', 'w1'],
                    machine: 'small-1x',
                }),
            );
        });

        it('returns null when import trigger() throws', async () => {
            workImportTriggerMock.mockRejectedValue(new Error('boom'));

            const out = await service.dispatchWorkImport({
                workId: 'w1',
                userId: 'u1',
                sourceType: 'github',
            } as any);

            expect(out).toBeNull();
        });
    });

    describe('machine selection', () => {
        it.each([
            'medium-1x',
            'micro',
            'small-1x',
            'small-2x',
            'medium-2x',
            'large-1x',
            'large-2x',
        ])('forwards %s as a supported machine', async (machine) => {
            triggerConfig.getMachine.mockReturnValue(machine);
            workGenTriggerMock.mockResolvedValue({ id: 'run' });

            await service.dispatchWorkGeneration({
                workId: 'w',
                userId: 'u',
                mode: 'full',
            } as any);

            expect(workGenTriggerMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ machine }),
            );
        });
    });
});
