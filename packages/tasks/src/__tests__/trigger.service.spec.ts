import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
    configureMock,
    runsCancelMock,
    workGenTriggerMock,
    workImportTriggerMock,
    templateCustomizationTriggerMock,
    kbOrgOverlayFanoutTriggerMock,
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
    TEMPLATE_CUSTOMIZATION_DISPATCHER: Symbol('TEMPLATE_CUSTOMIZATION_DISPATCHER'),
    KB_ORG_OVERLAY_FANOUT_DISPATCHER: Symbol('KB_ORG_OVERLAY_FANOUT_DISPATCHER'),
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
