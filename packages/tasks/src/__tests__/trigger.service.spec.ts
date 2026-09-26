import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
    configureMock,
    runsCancelMock,
    workGenTriggerMock,
    workImportTriggerMock,
    templateCustomizationTriggerMock,
    kbOrgOverlayFanoutTriggerMock,
    appSpecEvaluateTriggerMock,
    tasksTriggerMock,
    triggerConfig,
    subscriptionsConfig,
} = vi.hoisted(() => {
    return {
        configureMock: vi.fn(),
        runsCancelMock: vi.fn(),
        workGenTriggerMock: vi.fn(),
        workImportTriggerMock: vi.fn(),
        templateCustomizationTriggerMock: vi.fn(),
        kbOrgOverlayFanoutTriggerMock: vi.fn(),
        // APW-02 T28 wired `TriggerService.dispatchAppSpecEvaluate`, which imports
        // APW-03 T13's task module — mocked here for the same reason its four
        // siblings are: this spec asserts the SERVICE, not the task graph.
        appSpecEvaluateTriggerMock: vi.fn(),
        // APW-05 T18 — both Build dispatchers reach their job through the SDK's
        // id-based `tasks.trigger(id, payload, options)` form (the watch task module
        // is T20's and does not exist yet), so ONE mock covers the pair and the
        // assertions below pin the task id as the first argument.
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
    runs: { cancel: runsCancelMock },
    // APW-05 T18 — the id-based dispatch form both Build dispatchers use. Added
    // rather than replaced: `task` / `schedules` / `logger` stay exactly as they are,
    // so no other suite in this file changes behaviour.
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
    // APW-05 T18 — the two runtime-neutral job ids `dispatchAppBuildPrepare` /
    // `dispatchAppBuildWatch` enqueue under. Real string literals on purpose: the
    // assertions below pin the exact id on the wire, so a mock that echoed a made-up
    // value would hide a drift between this service and the task modules.
    APP_BUILD_PREPARE_TASK_ID: 'app-build-prepare',
    APP_BUILD_WATCH_TASK_ID: 'app-build-watch',
    // The worker graph imports CredentialVersionService (an @Optional() dep
    // on TenantRuntimeBindingResolverService). The full-module mock must
    // provide it or vitest 400s the whole file on the missing export.
    CredentialVersionService: class {},
}));

vi.mock('../tasks/trigger/work-generation.task', () => ({
    workGenerationTask: { trigger: workGenTriggerMock },
}));
vi.mock('../tasks/trigger/work-import.task', () => ({
    workImportTask: { trigger: workImportTriggerMock },
}));
vi.mock('../tasks/trigger/template-customization.task', () => ({
    templateCustomizationTask: { trigger: templateCustomizationTriggerMock },
}));
vi.mock('../tasks/trigger/kb-org-overlay-fanout.task', () => ({
    kbOrgOverlayFanoutTask: { trigger: kbOrgOverlayFanoutTriggerMock },
}));
// APW-03 T13's job — the module APW-02 T28's `dispatchAppSpecEvaluate` triggers.
// Mocked rather than loaded: the real module pulls `TriggerWorkerModule`, the whole
// worker graph and `@ever-works/agent/app-spec` into a spec about this service.
vi.mock('../tasks/trigger/app-spec-evaluate.task', () => ({
    appSpecEvaluateTask: { trigger: appSpecEvaluateTriggerMock },
}));
// C10 — the `app-fork-readiness` job, reached by id (its own module declares both the
// id and the task handle, so ONE mock covers the pair and the id is pinned as a real
// literal here — a mock that echoed a made-up value would hide a drift between this
// service and the task module).
vi.mock('../tasks/trigger/app-fork-readiness.task', () => ({
    APP_FORK_READINESS_TASK_ID: 'app-fork-readiness',
    appForkReadinessTask: { id: 'app-fork-readiness' },
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

    describe('dispatchTemplateCustomization', () => {
        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchTemplateCustomization({ customizationId: 'c1' });
            expect(out).toBeNull();
            expect(templateCustomizationTriggerMock).not.toHaveBeenCalled();
        });

        it('returns the run id and tags the customization id', async () => {
            templateCustomizationTriggerMock.mockResolvedValue({ id: 'run-tpl-1' });

            const out = await service.dispatchTemplateCustomization({ customizationId: 'c1' });

            expect(out).toBe('run-tpl-1');
            expect(templateCustomizationTriggerMock).toHaveBeenCalledWith(
                { customizationId: 'c1' },
                expect.objectContaining({
                    tags: ['template-customization', 'c1'],
                    machine: 'small-1x',
                }),
            );
        });

        it('returns null when the SDK throws', async () => {
            templateCustomizationTriggerMock.mockRejectedValue(new Error('boom'));
            const out = await service.dispatchTemplateCustomization({ customizationId: 'c1' });
            expect(out).toBeNull();
        });
    });

    // EW-641 Phase 2/e row 37b — TriggerService dispatch path for the
    // org-overlay fanout task. The KnowledgeBaseService side of the wire
    // lands in a follow-up row (needs `Work.organizationId` first — the
    // entity doesn't carry that column on develop today, so the resolver
    // can't be built yet). This test covers the dispatcher half so the
    // wiring is exercised end-to-end on the producer side.
    describe('dispatchKbOrgOverlayFanout', () => {
        const samplePayload = {
            organizationId: 'org-1',
            documentId: 'doc-1',
            workIds: ['w-a', 'w-b'],
            operation: 'upsert' as const,
            path: 'legal/privacy.md',
            class: 'legal',
        };

        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchKbOrgOverlayFanout(samplePayload);
            expect(out).toBeNull();
            expect(kbOrgOverlayFanoutTriggerMock).not.toHaveBeenCalled();
        });

        it('triggers the kbOrgOverlayFanoutTask with correct tags + concurrency key', async () => {
            kbOrgOverlayFanoutTriggerMock.mockResolvedValue({ id: 'run_fanout_1' });

            const out = await service.dispatchKbOrgOverlayFanout(samplePayload);

            expect(out).toBe('run_fanout_1');
            expect(kbOrgOverlayFanoutTriggerMock).toHaveBeenCalledWith(
                samplePayload,
                expect.objectContaining({
                    tags: expect.arrayContaining([
                        'kb-org-overlay-fanout',
                        'op:upsert',
                        'org:org-1',
                        'doc:doc-1',
                        'targets:2',
                    ]),
                    machine: 'small-1x',
                    // Serializes per-org so two rapid mutations against
                    // the same org don't race on writes to overlapping
                    // target Works.
                    concurrencyKey: 'kb-org-overlay:org-1',
                }),
            );
        });

        it('reports correct target count + op tag on delete operations', async () => {
            kbOrgOverlayFanoutTriggerMock.mockResolvedValue({ id: 'run_fanout_del' });

            await service.dispatchKbOrgOverlayFanout({
                ...samplePayload,
                operation: 'delete',
                workIds: ['w-a', 'w-b', 'w-c', 'w-d'],
            });

            expect(kbOrgOverlayFanoutTriggerMock).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'delete' }),
                expect.objectContaining({
                    tags: expect.arrayContaining(['op:delete', 'targets:4']),
                }),
            );
        });

        it('returns null when trigger() throws (caller treats as deferred sync)', async () => {
            kbOrgOverlayFanoutTriggerMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
            const out = await service.dispatchKbOrgOverlayFanout(samplePayload);
            expect(out).toBeNull();
        });
    });

    // APW-05 T18 — the two Build dispatchers (plan §7.1:1312-1319). Both take
    // `dispatchWorkspaceBackup`'s shape, and here the `null` is a documented
    // DEFERRAL rather than a failure: `AppBuildsService.dispatchPrepare` /
    // `dispatchWatch` answer it by running the matching runner in process
    // (§7.1:1321-1331, APW05-G20). So both methods must resolve `null` — never
    // throw — when the runtime is unconfigured or the SDK rejects.
    describe('dispatchAppBuildPrepare', () => {
        const payload = { workId: 'w1', buildId: 'b1', reason: 'rebuild' };

        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchAppBuildPrepare(payload);

            expect(out).toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('returns null when the secret key is missing (nothing is enqueued)', async () => {
            triggerConfig.getSecretKey.mockReturnValue('');
            const out = await service.dispatchAppBuildPrepare(payload);

            expect(out).toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('enqueues app-build-prepare with the work + build tags and the per-Work key', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_prepare_1' });

            const out = await service.dispatchAppBuildPrepare(payload);

            expect(out).toBe('run_prepare_1');
            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'app-build-prepare',
                payload,
                expect.objectContaining({
                    tags: expect.arrayContaining(['app-build-prepare', 'work:w1', 'build:b1']),
                    machine: 'small-1x',
                    // §7.2's `app-build-prepare:<workId>` key — the queue-side half of
                    // the job's own lock.
                    concurrencyKey: 'app-build-prepare:w1',
                }),
            );
        });

        it('adds no build tag when a coalesced dispatch carries no buildId', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_prepare_2' });

            await service.dispatchAppBuildPrepare({ workId: 'w1', reason: 'coalesced' });

            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'app-build-prepare',
                { workId: 'w1', reason: 'coalesced' },
                expect.objectContaining({ tags: ['app-build-prepare', 'work:w1'] }),
            );
        });

        it('returns null when the SDK throws (caller falls back in process)', async () => {
            tasksTriggerMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

            const out = await service.dispatchAppBuildPrepare(payload);

            expect(out).toBeNull();
        });
    });

    describe('dispatchAppBuildWatch', () => {
        const payload = { buildId: 'b1', reason: 'event' } as const;

        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchAppBuildWatch(payload);

            expect(out).toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('enqueues app-build-watch with the build tag and the per-Build key', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_watch_1' });

            const out = await service.dispatchAppBuildWatch(payload);

            expect(out).toBe('run_watch_1');
            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'app-build-watch',
                payload,
                expect.objectContaining({
                    tags: ['app-build-watch', 'build:b1'],
                    machine: 'small-1x',
                    // Two observations of one Build never queue at once; the
                    // `watchLeaseUntil` claim of §7.3:1386-1388 is the real guard.
                    concurrencyKey: 'app-build-watch:b1',
                }),
            );
        });

        it('returns null when the SDK throws (caller falls back in process)', async () => {
            tasksTriggerMock.mockRejectedValue(new Error('fetch failed'));

            const out = await service.dispatchAppBuildWatch(payload);

            expect(out).toBeNull();
        });
    });

    describe('dispatchAppForkReadiness', () => {
        // C10 — the enqueue half of the readiness chain. `AppWorkCreateService` and
        // `AppUpstreamStateService` reach this method through the
        // `APP_FORK_READINESS_DISPATCHER` binding, and `null` is their documented
        // fail-closed answer (the row keeps `dispatch_unavailable` and APW-02's sweeper
        // re-dispatches) — so this method must resolve `null`, never throw.
        const payload = {
            workId: 'w1',
            attempt: 1,
            reason: 'initial' as const,
            providerId: 'github',
        };

        it('returns null when trigger is disabled', async () => {
            triggerConfig.shouldUseTrigger.mockReturnValue(false);
            const out = await service.dispatchAppForkReadiness(payload);

            expect(out).toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('returns null when the secret key is missing (nothing is enqueued)', async () => {
            triggerConfig.getSecretKey.mockReturnValue('');
            const out = await service.dispatchAppForkReadiness(payload);

            expect(out).toBeNull();
            expect(tasksTriggerMock).not.toHaveBeenCalled();
        });

        it('enqueues app-fork-readiness with the work + reason tags and the per-Work key', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_readiness_1' });

            const out = await service.dispatchAppForkReadiness(payload);

            expect(out).toBe('run_readiness_1');
            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'app-fork-readiness',
                payload,
                expect.objectContaining({
                    tags: ['app-fork-readiness', 'work:w1', 'trigger:initial'],
                    machine: 'small-1x',
                    // §6.2's per-Work key: two readiness runs for one Work would race
                    // over the same row; the queue side is serialised, and the run's own
                    // `beginAttempt` claim is the real guard.
                    concurrencyKey: 'app-fork-readiness:w1',
                }),
            );
        });

        it('tags an untagged payload as `trigger:initial` and returns null when the SDK throws', async () => {
            tasksTriggerMock.mockResolvedValue({ id: 'run_readiness_2' });

            await expect(service.dispatchAppForkReadiness({ workId: 'w1' })).resolves.toBe(
                'run_readiness_2',
            );
            expect(tasksTriggerMock).toHaveBeenCalledWith(
                'app-fork-readiness',
                { workId: 'w1' },
                expect.objectContaining({
                    tags: expect.arrayContaining(['app-fork-readiness', 'trigger:initial']),
                }),
            );

            tasksTriggerMock.mockRejectedValue(new Error('fetch failed'));
            await expect(service.dispatchAppForkReadiness(payload)).resolves.toBeNull();
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
