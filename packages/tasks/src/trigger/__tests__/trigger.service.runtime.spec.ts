import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * EW-686 P1 — smoke tests for the `IJobRuntimeProvider` structural
 * conformance surface added to {@link TriggerService}.
 *
 * Scope: the 6 new fields/methods (`runtimeId`, `dispatchers`,
 * `isEnabled`, `cancel`, `getRunStatus`, `registerSchedules`,
 * `startWorkerHost`). Existing dispatch + per-job cancel coverage lives
 * in `packages/tasks/src/__tests__/trigger.service.spec.ts` and is
 * unchanged by this PR.
 *
 * The Trigger.dev SDK and `@ever-works/agent/config` are mocked so the
 * tests never touch the network and never need real env vars.
 */

const {
    configureMock,
    runsCancelMock,
    runsRetrieveMock,
    tasksTriggerMock,
    triggerConfig,
    subscriptionsConfig,
} = vi.hoisted(() => {
    return {
        configureMock: vi.fn(),
        runsCancelMock: vi.fn(),
        runsRetrieveMock: vi.fn(),
        tasksTriggerMock: vi.fn(),
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
    runs: { cancel: runsCancelMock, retrieve: runsRetrieveMock },
    tasks: { trigger: tasksTriggerMock },
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
    TEMPLATE_CUSTOMIZATION_DISPATCHER: Symbol('TEMPLATE_CUSTOMIZATION_DISPATCHER'),
    KB_ORG_OVERLAY_FANOUT_DISPATCHER: Symbol('KB_ORG_OVERLAY_FANOUT_DISPATCHER'),
    // APW-03 T13's worker graph imports `app-spec-evaluate.task`, which reads
    // this constant at module scope — a full-module mock must carry every
    // runtime export the graph touches, not only the ones an assertion uses.
    APP_SPEC_EVALUATE_JOB_ID: 'app-spec-evaluate',
    // The worker graph imports CredentialVersionService (an @Optional() dep
    // on TenantRuntimeBindingResolverService). The full-module mock must
    // provide it or vitest 400s the whole file on the missing export.
    CredentialVersionService: class {},
    // EW-693 / T27 — the long-running plugin operation job id.
    PLUGIN_OPERATION_TASK_ID: 'run-plugin-operation',
    PLUGIN_OPERATION_QUEUE_TTL_SECONDS: 15 * 60,
}));

// Per-task module mocks — the service imports these eagerly; the runtime
// surface methods don't call any of them, but the imports must resolve
// for the service module to load.
vi.mock('../../tasks/trigger/work-generation.task', () => ({
    workGenerationTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/work-import.task', () => ({
    workImportTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/template-customization.task', () => ({
    templateCustomizationTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/webhook-delivery.task', () => ({
    webhookDeliveryTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-mirror-document.task', () => ({
    kbMirrorDocumentTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-backfill-skeleton.task', () => ({
    kbBackfillSkeletonTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-embed-document.task', () => ({
    kbEmbedDocumentTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-org-overlay-fanout.task', () => ({
    kbOrgOverlayFanoutTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-normalize-video.task', () => ({
    kbNormalizeVideoTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-normalize-audio.task', () => ({
    kbNormalizeAudioTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/kb-transcribe.task', () => ({
    kbTranscribeTask: { trigger: vi.fn() },
}));
vi.mock('../../tasks/trigger/notification-channel-delivery.task', () => ({
    notificationChannelDeliveryTask: { trigger: vi.fn() },
}));

import { TriggerService } from '../trigger.service';

describe('TriggerService — IJobRuntimeProvider structural conformance (EW-686 P1)', () => {
    let service: TriggerService;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.shouldUseTrigger.mockReturnValue(true);
        triggerConfig.getSecretKey.mockReturnValue('tr_test_secret');
        triggerConfig.getApiUrl.mockReturnValue('https://api.trigger.test');
        triggerConfig.getMachine.mockReturnValue('small-1x');
        service = new TriggerService();
        // Silence Nest Logger noise from intentional error paths.
        vi.spyOn((service as any).logger, 'error').mockImplementation(() => {});
        vi.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
        vi.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('runtimeId / dispatchers', () => {
        it('exposes runtimeId === "trigger" to match the EVER_WORKS_JOB_RUNTIME selector', () => {
            expect(service.runtimeId).toBe('trigger');
        });

        it('dispatchers is the service instance itself (the dispatcher bag)', () => {
            // TriggerService already implements every `*Dispatcher`
            // interface; the binding factory consumes this same instance.
            expect(service.dispatchers).toBe(service);
        });
    });

    describe('isEnabled()', () => {
        it('returns true when shouldUseTrigger() is true and a secret key is set', () => {
            expect(service.isEnabled()).toBe(true);
            expect(configureMock).toHaveBeenCalledTimes(1);
        });

        it('returns false when shouldUseTrigger() is false', () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            expect(service.isEnabled()).toBe(false);
            expect(configureMock).not.toHaveBeenCalled();
        });

        it('returns false when the secret key is missing', () => {
            triggerConfig.getSecretKey.mockReturnValue('');
            expect(service.isEnabled()).toBe(false);
            expect(configureMock).not.toHaveBeenCalled();
        });
    });

    describe('cancel()', () => {
        it('returns false when the runtime is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            await expect(service.cancel('run_x')).resolves.toBe(false);
            expect(runsCancelMock).not.toHaveBeenCalled();
        });

        it('returns true and forwards the run id when runs.cancel resolves', async () => {
            runsCancelMock.mockResolvedValue(undefined);
            await expect(service.cancel('run_x')).resolves.toBe(true);
            expect(runsCancelMock).toHaveBeenCalledWith('run_x');
        });

        it('returns false when runs.cancel throws (unknown / already-terminal run ids)', async () => {
            runsCancelMock.mockRejectedValue(new Error('not found'));
            await expect(service.cancel('run_missing')).resolves.toBe(false);
        });
    });

    describe('getRunStatus()', () => {
        it("returns 'unknown' when the runtime is disabled", async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            await expect(service.getRunStatus('run_x')).resolves.toBe('unknown');
            expect(runsRetrieveMock).not.toHaveBeenCalled();
        });

        it("returns 'unknown' when runs.retrieve throws", async () => {
            runsRetrieveMock.mockRejectedValue(new Error('network'));
            await expect(service.getRunStatus('run_x')).resolves.toBe('unknown');
        });

        it.each([
            ['PENDING_VERSION', 'queued'],
            ['QUEUED', 'queued'],
            ['DEQUEUED', 'queued'],
            ['WAITING', 'queued'],
            ['DELAYED', 'queued'],
            ['EXECUTING', 'running'],
            ['COMPLETED', 'completed'],
            ['CANCELED', 'cancelled'],
            ['FAILED', 'failed'],
            ['CRASHED', 'failed'],
            ['SYSTEM_FAILURE', 'failed'],
            ['TIMED_OUT', 'failed'],
            ['EXPIRED', 'failed'],
            ['SOMETHING_NEW_FROM_SDK_V5', 'unknown'],
        ])('maps Trigger.dev status %s -> JobRunStatus %s', async (triggerStatus, expected) => {
            runsRetrieveMock.mockResolvedValue({ status: triggerStatus });
            await expect(service.getRunStatus('run_x')).resolves.toBe(expected);
            expect(runsRetrieveMock).toHaveBeenCalledWith('run_x');
        });
    });

    /**
     * EW-693 / T27 — the contract's optional `getRunResult`: status AND output,
     * the one request/response read `PluginExecutionRouterService` makes to
     * wait for a long-running plugin operation.
     */
    describe('getRunResult()', () => {
        it("answers { status: 'unknown' } when the runtime is disabled, without a call", async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            await expect(service.getRunResult('run_x')).resolves.toEqual({ status: 'unknown' });
            expect(runsRetrieveMock).not.toHaveBeenCalled();
        });

        it('answers the output of a COMPLETED run', async () => {
            runsRetrieveMock.mockResolvedValue({
                status: 'COMPLETED',
                output: { ok: true, result: { n: 1 } },
            });
            await expect(service.getRunResult('run_x')).resolves.toEqual({
                status: 'completed',
                output: { ok: true, result: { n: 1 } },
            });
            expect(runsRetrieveMock).toHaveBeenCalledWith('run_x');
        });

        it('carries no output until the run completes', async () => {
            runsRetrieveMock.mockResolvedValue({ status: 'EXECUTING', output: 'partial' });
            await expect(service.getRunResult('run_x')).resolves.toEqual({ status: 'running' });
        });

        it('answers the error message of a FAILED run', async () => {
            runsRetrieveMock.mockResolvedValue({
                status: 'CRASHED',
                error: { message: 'worker OOM', name: 'Error' },
            });
            await expect(service.getRunResult('run_x')).resolves.toEqual({
                status: 'failed',
                error: { message: 'worker OOM' },
            });
        });

        it("answers { status: 'unknown' } when runs.retrieve throws", async () => {
            runsRetrieveMock.mockRejectedValue(new Error('network'));
            await expect(service.getRunResult('run_x')).resolves.toEqual({ status: 'unknown' });
        });

        /**
         * An output over the SDK's inline limit sits behind `outputPresignedUrl`;
         * `runs.retrieve` downloads it but SWALLOWS a failed download, leaving
         * `output` undefined. Answered as completed, the router reported a run
         * that succeeded — side effects done — as failed.
         */
        it("answers { status: 'unknown' } — read it again — for a COMPLETED run whose offloaded output did not download", async () => {
            runsRetrieveMock.mockResolvedValue({
                status: 'COMPLETED',
                output: undefined,
                outputPresignedUrl: 'https://packets.example/out.json',
            });
            await expect(service.getRunResult('run_x')).resolves.toEqual({ status: 'unknown' });
        });

        it('keeps a downloaded offloaded output', async () => {
            runsRetrieveMock.mockResolvedValue({
                status: 'COMPLETED',
                output: { ok: true, result: 'big' },
                outputPresignedUrl: 'https://packets.example/out.json',
            });
            await expect(service.getRunResult('run_x')).resolves.toEqual({
                status: 'completed',
                output: { ok: true, result: 'big' },
            });
        });
    });

    describe('dispatchPluginOperation()', () => {
        const payload = { pluginId: 'acme-gen', operation: 'generate', args: { n: 1 } };

        it('answers null when the runtime is disabled, without a call', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            await expect(service.dispatchPluginOperation(payload)).resolves.toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('triggers run-plugin-operation with the payload, tags and a queue ttl, and answers the run id', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_42' });

            await expect(service.dispatchPluginOperation(payload)).resolves.toBe('run_42');
            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'run-plugin-operation',
                { pluginId: 'acme-gen', operation: 'generate', args: { n: 1 } },
                expect.objectContaining({
                    tags: ['plugin-operation', 'plugin:acme-gen'],
                    // maxDuration does not count queue time; the ttl bounds it.
                    ttl: '15m',
                }),
            );
        });

        it('answers null when the enqueue fails', async () => {
            tasksTriggerMock.mockRejectedValue(new Error('rate limited'));
            await expect(service.dispatchPluginOperation(payload)).resolves.toBeNull();
        });

        it('is reachable through the dispatchers bag, by the name the router looks up', () => {
            expect(
                typeof (service.dispatchers as unknown as Record<string, unknown>)
                    .dispatchPluginOperation,
            ).toBe('function');
        });
    });

    describe('registerSchedules()', () => {
        it('is a no-op for the empty list (does not log)', async () => {
            const debugSpy = vi.spyOn((service as any).logger, 'debug');
            await expect(service.registerSchedules([])).resolves.toBeUndefined();
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('logs a debug stub line when given a non-empty list (per-task files own real cron)', async () => {
            const debugSpy = vi.spyOn((service as any).logger, 'debug');
            await expect(
                service.registerSchedules([{ id: 'work-schedule', cron: '*/5 * * * *' }]),
            ).resolves.toBeUndefined();
            expect(debugSpy).toHaveBeenCalledTimes(1);
            expect(debugSpy.mock.calls[0][0]).toContain('EW-686 P1');
        });
    });

    describe('startWorkerHost()', () => {
        it('returns a no-op handle with an idempotent stop() (push-model runtime)', async () => {
            const handle = await service.startWorkerHost({});
            expect(handle).toBeDefined();
            expect(typeof handle.stop).toBe('function');
            // stop() resolves and is safe to call repeatedly.
            await expect(handle.stop()).resolves.toBeUndefined();
            await expect(handle.stop()).resolves.toBeUndefined();
        });
    });
});
