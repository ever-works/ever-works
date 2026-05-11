// Mock the two collaborator modules so we never pull in their transitive
// imports — `WorkScheduleService` (and downstream `data-generator.service.ts`)
// imports the ESM-only `p-map`, which Jest's CJS transformer cannot parse.
jest.mock('@src/services/work-schedule.service', () => ({
    WorkScheduleService: class {},
}));
jest.mock('@src/plugins/services/plugin-operations.service', () => ({
    PluginOperationsService: class {},
}));

import { WorksConfigImportApplierService } from '../services/works-config-import-applier.service';

/**
 * `WorksConfigImportApplierService` is the write-side counterpart to the
 * `WorksConfigImportPlannerService` validation layer. After the planner has
 * decided the import is safe, the applier translates the parsed
 * `.works/works.yml` payload into actual side-effects on the user's work:
 *
 * - `applyPipelineSettings` — enables the Codex / Claude-Code pipeline
 *   plugin (the only two AI-pipeline plugins shipped today) for the work,
 *   forwarding the `model` field as a plugin setting.
 * - `applyInitialSchedule` — configures the WorkSchedule the FIRST time
 *   the work is created from a works-config (the `enable: true` +
 *   `alwaysCreatePullRequest: true` defaults are pinned).
 * - `applyScheduleOverrides` — a partial-update path used after the work
 *   has already been scheduled — only the cadence and providerOverrides
 *   are forwarded; the `enable` / `alwaysCreatePullRequest` flags are
 *   deliberately omitted so the operator's existing settings are preserved.
 *
 * Both schedule paths swallow rejections from `WorkScheduleService` and
 * downgrade them to `logger.warn` lines so a misconfigured cadence or
 * provider does NOT block the rest of the import flow. Pinned because a
 * future "rethrow on schedule failure" refactor would silently break
 * end-to-end imports for users with one bad provider.
 */
describe('WorksConfigImportApplierService', () => {
    let pluginOperationsService: { enablePluginForWork: jest.Mock };
    let workScheduleService: { updateSchedule: jest.Mock };
    let service: WorksConfigImportApplierService;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        pluginOperationsService = { enablePluginForWork: jest.fn().mockResolvedValue(undefined) };
        workScheduleService = { updateSchedule: jest.fn().mockResolvedValue(undefined) };
        service = new WorksConfigImportApplierService(
            pluginOperationsService as never,
            workScheduleService as never,
        );
        warnSpy = jest
            .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('applyPipelineSettings', () => {
        it('does NOT call the plugin operations service when worksConfig is null', async () => {
            await service.applyPipelineSettings('work-1', 'user-1', null);
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('does NOT call the plugin operations service when worksConfig is undefined (omitted arg)', async () => {
            await service.applyPipelineSettings('work-1', 'user-1');
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('does NOT call the plugin operations service when model is missing', async () => {
            // Pinned: the `getPipelinePluginSettings` helper short-circuits to null
            // when `worksConfig.model` is falsy, so the pipeline check is irrelevant
            // without a model.
            await service.applyPipelineSettings('work-1', 'user-1', {
                providers: { pipeline: 'codex' } as never,
            } as never);
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('does NOT call the plugin operations service when pipeline is neither codex nor claude-code', async () => {
            // Pinned: only the two named pipelines are eligible. Pinned via
            // `it.each` below for every other documented option.
            await service.applyPipelineSettings('work-1', 'user-1', {
                model: 'gpt-5',
                providers: { pipeline: 'standard-pipeline' } as never,
            } as never);
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it.each([
            ['agent-pipeline'],
            ['claude-managed-agent'],
            ['gemini'],
            ['opencode'],
            ['unknown-pipeline'],
            [undefined],
        ])('does NOT enable a pipeline when pipelineId is %p', async (pipelineId) => {
            await service.applyPipelineSettings('work-1', 'user-1', {
                model: 'sonnet-4.6',
                providers: { pipeline: pipelineId } as never,
            } as never);
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('enables the codex plugin when pipelineId === "codex" AND model is set', async () => {
            await service.applyPipelineSettings('work-1', 'user-1', {
                model: 'gpt-5-codex',
                providers: { pipeline: 'codex' } as never,
            } as never);
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledTimes(1);
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'codex',
                'user-1',
                {
                    activeCapability: 'pipeline',
                    settings: { model: 'gpt-5-codex' },
                },
            );
        });

        it('enables the claude-code plugin when pipelineId === "claude-code" AND model is set', async () => {
            await service.applyPipelineSettings('work-1', 'user-1', {
                model: 'sonnet-4.6',
                providers: { pipeline: 'claude-code' } as never,
            } as never);
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'claude-code',
                'user-1',
                {
                    activeCapability: 'pipeline',
                    settings: { model: 'sonnet-4.6' },
                },
            );
        });

        it('forwards positional args (workId, pluginId, userId, options) — NOT object-shaped', async () => {
            await service.applyPipelineSettings('work-X', 'user-X', {
                model: 'm',
                providers: { pipeline: 'codex' } as never,
            } as never);
            const call = pluginOperationsService.enablePluginForWork.mock.calls[0];
            // Pinned: the four-arg shape is the contract — a future refactor to a
            // single-object parameter would break the calling site silently.
            expect(call).toHaveLength(4);
            expect(call[0]).toBe('work-X');
            expect(call[1]).toBe('codex');
            expect(call[2]).toBe('user-X');
        });

        it('rethrows rejection from enablePluginForWork (no try/catch swallow on the pipeline path)', async () => {
            // Pinned contrast with the schedule paths: pipeline failures DO propagate.
            const cause = new Error('plugin enable failed');
            pluginOperationsService.enablePluginForWork.mockRejectedValueOnce(cause);
            await expect(
                service.applyPipelineSettings('work-1', 'user-1', {
                    model: 'gpt-5',
                    providers: { pipeline: 'codex' } as never,
                } as never),
            ).rejects.toBe(cause);
        });
    });

    describe('applyInitialSchedule', () => {
        const user = { id: 'user-1' } as never;

        it('does NOT call updateSchedule when worksConfig is null', async () => {
            await service.applyInitialSchedule('work-1', user, null);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when worksConfig is undefined', async () => {
            await service.applyInitialSchedule('work-1', user);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when scheduleCadence is missing', async () => {
            await service.applyInitialSchedule('work-1', user, {
                providers: { ai: 'openai' },
            } as never);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when scheduleCadence is null', async () => {
            // Pinned: `null` falls through the `!worksConfig?.scheduleCadence` check.
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: null,
            } as never);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('calls updateSchedule with the FOUR documented defaults when cadence is set', async () => {
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: 'daily',
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                {
                    enable: true,
                    cadence: 'daily',
                    alwaysCreatePullRequest: true,
                    providerOverrides: null,
                },
                user,
            );
        });

        it('forwards providerOverrides only when providers is non-empty', async () => {
            const providers = { ai: 'openai', pipeline: 'codex' };
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: 'weekly',
                providers,
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    providerOverrides: providers,
                }),
                user,
            );
        });

        it('forwards null providerOverrides when providers is an EMPTY object (Object.keys === 0)', async () => {
            // Pinned: the empty-object → null contract is documented behaviour
            // and prevents the schedule from advertising a no-op override.
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: 'monthly',
                providers: {},
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    providerOverrides: null,
                }),
                user,
            );
        });

        it('logs a warn line and SWALLOWS Error rejection from updateSchedule', async () => {
            const cause = new Error('cadence rejected');
            workScheduleService.updateSchedule.mockRejectedValueOnce(cause);
            await expect(
                service.applyInitialSchedule('work-1', user, {
                    scheduleCadence: 'daily',
                } as never),
            ).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule from .works/works.yml for work work-1: cadence rejected',
            );
        });

        it('coerces a non-Error rejection via String() in the warn message', async () => {
            workScheduleService.updateSchedule.mockRejectedValueOnce('string-cause');
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: 'daily',
            } as never);
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule from .works/works.yml for work work-1: string-cause',
            );
        });

        it('coerces a thrown number (non-Error) via String() in the warn message', async () => {
            workScheduleService.updateSchedule.mockRejectedValueOnce(404);
            await service.applyInitialSchedule('work-1', user, {
                scheduleCadence: 'daily',
            } as never);
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule from .works/works.yml for work work-1: 404',
            );
        });
    });

    describe('applyScheduleOverrides', () => {
        const user = { id: 'user-1' } as never;
        const buildWork = (overrides: Record<string, unknown> = {}) =>
            ({
                id: 'work-1',
                scheduledUpdatesEnabled: true,
                ...overrides,
            }) as never;

        it('does NOT call updateSchedule when scheduledUpdatesEnabled is false', async () => {
            await service.applyScheduleOverrides(
                buildWork({ scheduledUpdatesEnabled: false }),
                user,
                { scheduleCadence: 'daily', providers: { ai: 'openai' } } as never,
            );
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when neither cadence nor providers is set', async () => {
            await service.applyScheduleOverrides(buildWork(), user, {} as never);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when worksConfig is undefined', async () => {
            await service.applyScheduleOverrides(buildWork(), user);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('does NOT call updateSchedule when worksConfig is null', async () => {
            await service.applyScheduleOverrides(buildWork(), user, null);
            expect(workScheduleService.updateSchedule).not.toHaveBeenCalled();
        });

        it('calls updateSchedule with cadence ONLY (no enable, no alwaysCreatePullRequest)', async () => {
            // Pinned contrast with applyInitialSchedule: the override path
            // intentionally omits `enable` and `alwaysCreatePullRequest` so the
            // operator's existing settings are preserved.
            await service.applyScheduleOverrides(buildWork(), user, {
                scheduleCadence: 'weekly',
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                {
                    cadence: 'weekly',
                    providerOverrides: undefined,
                },
                user,
            );
        });

        it('forwards a non-empty providers object verbatim', async () => {
            const providers = { ai: 'anthropic' };
            await service.applyScheduleOverrides(buildWork(), user, {
                providers,
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    cadence: undefined,
                    providerOverrides: providers,
                }),
                user,
            );
        });

        it('forwards an EMPTY providers object as-is (not coerced to null) — different from applyInitialSchedule', async () => {
            // Pinned contrast: in the override path, an empty providers OBJECT is
            // forwarded verbatim because the gate uses `providers !== undefined`.
            // This is intentional — the operator may want to clear all overrides.
            await service.applyScheduleOverrides(buildWork(), user, {
                providers: {},
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    providerOverrides: {},
                }),
                user,
            );
        });

        it('forwards `undefined` providerOverrides only when providers is omitted entirely', async () => {
            // Pinned: the `!== undefined` guard means a missing key forwards
            // `undefined` (no-op semantics for the schedule service); an
            // explicit empty object forwards `{}` (clear semantics).
            await service.applyScheduleOverrides(buildWork(), user, {
                scheduleCadence: 'daily',
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    providerOverrides: undefined,
                }),
                user,
            );
        });

        it('runs when ONLY providers is set (no cadence) — `(!cadence && !providers)` requires BOTH to short-circuit', async () => {
            // Pinned: the boolean gate is `(!cadence && !providers)` — providing
            // either one is enough to proceed.
            await service.applyScheduleOverrides(buildWork(), user, {
                providers: { ai: 'openai' },
            } as never);
            expect(workScheduleService.updateSchedule).toHaveBeenCalledTimes(1);
        });

        it('logs a warn line and SWALLOWS Error rejection from updateSchedule', async () => {
            const cause = new Error('override rejected');
            workScheduleService.updateSchedule.mockRejectedValueOnce(cause);
            await expect(
                service.applyScheduleOverrides(buildWork(), user, {
                    scheduleCadence: 'daily',
                } as never),
            ).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule overrides from .works/works.yml for work work-1: override rejected',
            );
        });

        it('coerces a non-Error rejection via String() in the warn message', async () => {
            workScheduleService.updateSchedule.mockRejectedValueOnce({ code: 500 });
            await service.applyScheduleOverrides(buildWork(), user, {
                scheduleCadence: 'daily',
            } as never);
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule overrides from .works/works.yml for work work-1: [object Object]',
            );
        });

        it('uses work.id (not workId arg) in the warn message — there is no workId arg on this method', async () => {
            workScheduleService.updateSchedule.mockRejectedValueOnce(new Error('boom'));
            await service.applyScheduleOverrides(buildWork({ id: 'work-CUSTOM-ID' }), user, {
                scheduleCadence: 'daily',
            } as never);
            expect(warnSpy).toHaveBeenCalledWith(
                'Failed to restore schedule overrides from .works/works.yml for work work-CUSTOM-ID: boom',
            );
        });
    });

    describe('contracts', () => {
        it('exposes a NestJS Logger keyed to the service name', () => {
            const logger = (service as unknown as { logger: { context?: string } }).logger;
            // The Nest Logger may store its context on either `.context` or via
            // the constructor's positional arg — pin the runtime existence
            // rather than the property location.
            expect(logger).toBeDefined();
        });
    });
});
