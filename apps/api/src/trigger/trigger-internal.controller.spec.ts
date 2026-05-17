jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class WorkRepository {},
    AuthAccountRepository: class AuthAccountRepository {},
    TemplateRepository: class TemplateRepository {},
    UserTemplatePreferenceRepository: class UserTemplatePreferenceRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
}));
jest.mock('@ever-works/agent/work-operations', () => ({
    WorkOperationsService: class WorkOperationsService {},
}));
jest.mock('@ever-works/agent/tasks', () => ({}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
    WorkScheduleDispatcherService: class WorkScheduleDispatcherService {},
    WorkScheduleService: class WorkScheduleService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    NotificationService: class NotificationService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class GitFacadeService {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRepository: class PluginRepository {},
    UserPluginRepository: class UserPluginRepository {},
    WorkPluginRepository: class WorkPluginRepository {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
}));
jest.mock('../data-sync/data-sync-dispatcher.service', () => ({
    DataSyncDispatcherService: class DataSyncDispatcherService {},
}));
jest.mock('../work-proposals/work-proposals.service', () => ({
    WorkProposalsApiService: class WorkProposalsApiService {},
}));

const getInternalSecretMock = jest.fn<string | undefined, []>();
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            getInternalSecret: () => getInternalSecretMock(),
        },
    },
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import superjson from 'superjson';
import { TriggerInternalController } from './trigger-internal.controller';

describe('TriggerInternalController', () => {
    const VALID_SECRET = 'super-secret-token';

    let workRepository: any;
    let ownershipService: any;
    let workOperationsService: any;
    let cacheManager: any;
    let scheduleDispatcher: any;
    let workScheduleService: any;
    let notificationService: any;
    let gitFacade: any;
    let pluginRepository: any;
    let userPluginRepository: any;
    let workPluginRepository: any;
    let authAccountRepository: any;
    let templateRepository: any;
    let userTemplatePreferenceRepository: any;
    let controller: TriggerInternalController;

    const buildController = () => {
        const c = new TriggerInternalController(
            workRepository,
            ownershipService,
            workOperationsService,
            cacheManager,
            scheduleDispatcher,
            workScheduleService,
            notificationService,
            gitFacade,
            pluginRepository,
            userPluginRepository,
            workPluginRepository,
            authAccountRepository,
            templateRepository,
            userTemplatePreferenceRepository,
            undefined,
        );
        c.onModuleInit();
        return c;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        getInternalSecretMock.mockReturnValue(VALID_SECRET);

        workRepository = { name: 'WorkRepository' };
        ownershipService = { ensureAccess: jest.fn() };
        workOperationsService = { name: 'WorkOperationsService' };
        cacheManager = { name: 'CacheManager' };
        scheduleDispatcher = { name: 'WorkScheduleDispatcherService' };
        workScheduleService = { name: 'WorkScheduleService' };
        notificationService = { name: 'NotificationService' };
        gitFacade = { getAccessToken: jest.fn() };
        pluginRepository = { name: 'PluginRepository', echo: jest.fn((v: string) => `echo:${v}`) };
        userPluginRepository = { name: 'UserPluginRepository' };
        workPluginRepository = { name: 'WorkPluginRepository' };
        authAccountRepository = { name: 'AuthAccountRepository' };
        templateRepository = { name: 'TemplateRepository' };
        userTemplatePreferenceRepository = { name: 'UserTemplatePreferenceRepository' };

        controller = buildController();
    });

    describe('getWorkContext', () => {
        const baseUser = { id: 'user-1', password: 'hashed-secret', email: 'u@e.test' };
        const baseWork = {
            id: 'work-1',
            gitProvider: 'github',
            user: baseUser,
            description: 'A work',
        };

        it('returns context with stripped relations and stripped user password + git token', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue('gh-token');

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect(ownershipService.ensureAccess).toHaveBeenCalledWith('work-1', 'user-1');
            expect(gitFacade.getAccessToken).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
                workId: 'work-1',
            });
            // user relation stripped from work
            expect((result.work as any).user).toBeUndefined();
            expect((result.work as any).id).toBe('work-1');
            // password stripped from user
            expect((result.user as any).password).toBeUndefined();
            expect((result.user as any).id).toBe('user-1');
            expect(result.gitToken).toBe('gh-token');
        });

        it('returns gitToken=undefined when GitFacade returns null', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue(null);

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect(result.gitToken).toBeUndefined();
        });

        it('throws BadRequestException when userId is missing', async () => {
            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', undefined as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.getWorkContext(VALID_SECRET, 'work-1', '')).rejects.toThrow(
                'Missing userId',
            );
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('throws ForbiddenException when secret is missing or wrong', async () => {
            await expect(controller.getWorkContext('', 'work-1', 'user-1')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(controller.getWorkContext('wrong', 'work-1', 'user-1')).rejects.toThrow(
                'Invalid trigger secret',
            );
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('throws ForbiddenException when no internal secret is configured', async () => {
            getInternalSecretMock.mockReturnValue(undefined);

            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1'),
            ).rejects.toThrow('Trigger internal secret is not configured');
        });

        it('does not strip non-user relations', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork, items: [{ id: 'i1' }] },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue(undefined);

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect((result.work as any).items).toEqual([{ id: 'i1' }]);
            expect(result.gitToken).toBeUndefined();
        });
    });

    describe('callRemote', () => {
        const buildBody = (
            overrides: Partial<{
                name: string;
                method: string;
                args: unknown[];
            }> = {},
        ) => {
            const args = overrides.args ?? [];
            return {
                name: overrides.name ?? 'PluginRepository',
                method: overrides.method ?? 'echo',
                args: superjson.serialize(args) as any,
            };
        };

        it('dispatches to the registered remote target/method and returns superjson-serialized result', async () => {
            const echoSpy = jest.spyOn(pluginRepository, 'echo');

            const out = await controller.callRemote(VALID_SECRET, buildBody({ args: ['hello'] }));

            expect(echoSpy).toHaveBeenCalledWith('hello');
            const deserialized = superjson.deserialize(out.result as any);
            expect(deserialized).toBe('echo:hello');
        });

        it('preserves rich types via superjson (Date round-trip)', async () => {
            const fixedDate = new Date('2026-05-07T12:00:00.000Z');
            (pluginRepository as any).withDate = jest.fn(async (d: Date) => {
                expect(d).toBeInstanceOf(Date);
                expect(d.toISOString()).toBe(fixedDate.toISOString());
                return d;
            });
            // C-05: the per-service allow-list is built in onModuleInit by
            // walking the instance's prototype chain. We added `withDate` to
            // the stub instance AFTER the beforeEach-built controller, so we
            // need a fresh controller instance for the allow-list to include it.
            controller = buildController();

            const out = await controller.callRemote(VALID_SECRET, {
                name: 'PluginRepository',
                method: 'withDate',
                args: superjson.serialize([fixedDate]) as any,
            });

            const deserialized = superjson.deserialize(out.result as any) as Date;
            expect(deserialized).toBeInstanceOf(Date);
            expect(deserialized.toISOString()).toBe(fixedDate.toISOString());
        });

        it('throws BadRequestException for unknown remote target', async () => {
            await expect(
                controller.callRemote(VALID_SECRET, buildBody({ name: 'NotARealTarget' })),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.callRemote(VALID_SECRET, buildBody({ name: 'NotARealTarget' })),
            ).rejects.toThrow('Unknown remote target: NotARealTarget');
        });

        // C-05: unknown methods are now rejected by the per-service allow-list
        // (built at onModuleInit from the instance's own prototype chain) BEFORE
        // we reach the `typeof fn !== 'function'` check. The allow-list error
        // names the service so an operator can see which target rejected the
        // call.
        it('throws BadRequestException for unknown method on a known target (allow-list)', async () => {
            await expect(
                controller.callRemote(
                    VALID_SECRET,
                    buildBody({ name: 'PluginRepository', method: 'doesNotExist' }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.callRemote(
                    VALID_SECRET,
                    buildBody({ name: 'PluginRepository', method: 'doesNotExist' }),
                ),
            ).rejects.toThrow('Method not in allow-list for PluginRepository: doesNotExist');
        });

        it('throws ForbiddenException with wrong secret (and never invokes the remote)', async () => {
            const echoSpy = jest.spyOn(pluginRepository, 'echo');

            await expect(
                controller.callRemote('wrong', buildBody({ args: ['x'] })),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(echoSpy).not.toHaveBeenCalled();
        });

        it('exposes all 10 expected remote targets after onModuleInit', async () => {
            const expectedTargets = [
                'AuthAccountRepository',
                'PluginRepository',
                'UserPluginRepository',
                'WorkPluginRepository',
                'WorkOperationsService',
                'NotificationService',
                'WorkRepository',
                'CacheManager',
                'WorkScheduleDispatcherService',
                'WorkScheduleService',
            ];

            for (const target of expectedTargets) {
                // C-05: each target's allow-list is built independently so the
                // service name is interpolated into the rejection.
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name: target,
                        method: 'doesNotExist',
                        args: superjson.serialize([]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for ${target}: doesNotExist`);
            }
        });

        it('builds remoteMap fresh on each onModuleInit (no shared state across instances)', async () => {
            const second = buildController();
            (second as any).pluginRepository = { name: 'second' };
            // each controller instance has its own remoteMap pointing at its own injections
            expect((controller as any).remoteMap).not.toBe((second as any).remoteMap);
            expect((controller as any).remoteMap.PluginRepository).toBe(pluginRepository);
        });
    });
});
