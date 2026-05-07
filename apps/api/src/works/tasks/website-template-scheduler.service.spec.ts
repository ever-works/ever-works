jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        websiteTemplate: {
            autoUpdateEnabled: jest.fn(),
        },
    },
}));

import { config } from '@ever-works/agent/config';
import { WebsiteTemplateSchedulerService } from './website-template-scheduler.service';
import type { WorkRepository } from '@ever-works/agent/database';
import type { Work } from '@ever-works/agent/entities';
import type { WebsiteUpdateService } from '@ever-works/agent/generators';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

describe('WebsiteTemplateSchedulerService', () => {
    let workRepository: {
        findWithWebsiteAutoUpdateEnabled: jest.Mock;
        update: jest.Mock;
    };
    let websiteUpdateService: {
        checkForUpdate: jest.Mock;
        updateRepository: jest.Mock;
    };
    let taskLockService: { runExclusive: jest.Mock };
    let service: WebsiteTemplateSchedulerService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    const autoUpdateEnabled = (config as any).websiteTemplate.autoUpdateEnabled as jest.Mock;

    beforeEach(() => {
        workRepository = {
            findWithWebsiteAutoUpdateEnabled: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
        };
        websiteUpdateService = {
            checkForUpdate: jest.fn(),
            updateRepository: jest.fn(),
        };
        taskLockService = { runExclusive: jest.fn() };
        service = new WebsiteTemplateSchedulerService(
            workRepository as unknown as WorkRepository,
            websiteUpdateService as unknown as WebsiteUpdateService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        debugSpy = jest
            .spyOn((service as any).logger, 'debug')
            .mockImplementation(() => undefined);
        autoUpdateEnabled.mockReturnValue(true);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('runExclusive uses works:website-template-scheduler key, 1h ttl, debug onLocked', async () => {
        // override default
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.handleScheduledTemplateUpdates();
        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:website-template-scheduler');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping website template scheduler because another instance holds the task lock',
        );
    });

    it('returns early when feature is disabled', async () => {
        autoUpdateEnabled.mockReturnValue(false);
        await service.handleScheduledTemplateUpdates();
        expect(workRepository.findWithWebsiteAutoUpdateEnabled).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('returns early when no eligible works are found', async () => {
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([]);
        await service.handleScheduledTemplateUpdates();
        expect(websiteUpdateService.checkForUpdate).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('logs the count then performs an update for each work and logs completion', async () => {
        const work1 = {
            id: 'w1',
            slug: 's1',
            user: { id: 'u1' },
        } as unknown as Work;
        const work2 = {
            id: 'w2',
            slug: 's2',
            user: { id: 'u2' },
        } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work1, work2]);

        websiteUpdateService.checkForUpdate
            .mockResolvedValueOnce({
                error: null,
                updateAvailable: true,
                branch: 'main',
                currentCommit: 'abc',
                latestCommit: 'def',
            })
            .mockResolvedValueOnce({
                error: null,
                updateAvailable: false,
                branch: 'main',
            });

        websiteUpdateService.updateRepository.mockResolvedValueOnce({
            commitSha: 'def',
            method: 'merge',
        });

        await service.handleScheduledTemplateUpdates();

        expect(logSpy).toHaveBeenCalledWith('Checking 2 works for website template updates');
        expect(logSpy).toHaveBeenCalledWith('Update available for s1: abc -> def');
        expect(logSpy).toHaveBeenCalledWith('Successfully updated s1 using merge method');
        expect(debugSpy).toHaveBeenCalledWith(
            'No update available for work s2 (branch: main)',
        );
        expect(logSpy).toHaveBeenCalledWith('Website template update check completed');

        // Update calls: lastChecked for both, success-update for w1
        const updateCalls = workRepository.update.mock.calls;
        // w1 lastChecked
        expect(updateCalls[0][0]).toBe('w1');
        expect(updateCalls[0][1]).toEqual({ websiteTemplateLastCheckedAt: expect.any(Date) });
        // w1 success
        expect(workRepository.update).toHaveBeenCalledWith('w1', {
            websiteTemplateLastCommit: 'def',
            websiteTemplateLastUpdatedAt: expect.any(Date),
            websiteTemplateLastError: null,
        });
        // w2 lastChecked only
        expect(workRepository.update).toHaveBeenCalledWith('w2', {
            websiteTemplateLastCheckedAt: expect.any(Date),
        });

        expect(websiteUpdateService.updateRepository).toHaveBeenCalledTimes(1);
        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(
            work1,
            work1.user,
            { branch: 'main' },
        );
    });

    it('falls back to updateCheck.latestCommit when result.commitSha is missing', async () => {
        const work = {
            id: 'w1',
            slug: 's1',
            user: { id: 'u1' },
        } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work]);
        websiteUpdateService.checkForUpdate.mockResolvedValue({
            updateAvailable: true,
            branch: 'main',
            currentCommit: null,
            latestCommit: 'fallback-sha',
        });
        websiteUpdateService.updateRepository.mockResolvedValue({ method: 'rebase' });

        await service.handleScheduledTemplateUpdates();

        expect(workRepository.update).toHaveBeenCalledWith('w1', {
            websiteTemplateLastCommit: 'fallback-sha',
            websiteTemplateLastUpdatedAt: expect.any(Date),
            websiteTemplateLastError: null,
        });
        expect(logSpy).toHaveBeenCalledWith('Update available for s1: none -> fallback-sha');
    });

    it('records updateCheck.error and skips update when checkForUpdate reports error', async () => {
        const work = {
            id: 'w1',
            slug: 's1',
            user: { id: 'u1' },
        } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work]);
        websiteUpdateService.checkForUpdate.mockResolvedValue({
            error: 'token expired',
            updateAvailable: false,
        });

        await service.handleScheduledTemplateUpdates();

        expect(workRepository.update).toHaveBeenCalledWith('w1', {
            websiteTemplateLastError: 'token expired',
        });
        expect(warnSpy).toHaveBeenCalledWith('Cannot check updates for s1: token expired');
        expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
    });

    it('skips update when workOwner (work.user) is not loaded', async () => {
        const work = { id: 'w1', slug: 's1', user: null } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work]);
        websiteUpdateService.checkForUpdate.mockResolvedValue({
            updateAvailable: true,
            branch: 'main',
            currentCommit: 'a',
            latestCommit: 'b',
        });

        await service.handleScheduledTemplateUpdates();

        expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('Work s1 has no user loaded, skipping update');
    });

    it('records error message when updateRepository throws Error', async () => {
        const work = {
            id: 'w1',
            slug: 's1',
            user: { id: 'u1' },
        } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work]);
        websiteUpdateService.checkForUpdate.mockResolvedValue({
            updateAvailable: true,
            branch: 'main',
            currentCommit: 'a',
            latestCommit: 'b',
        });
        websiteUpdateService.updateRepository.mockRejectedValue(new Error('git push failed'));

        await service.handleScheduledTemplateUpdates();

        expect(workRepository.update).toHaveBeenCalledWith('w1', {
            websiteTemplateLastError: 'git push failed',
        });
        expect(errorSpy).toHaveBeenCalledWith('Failed to update template for work s1: git push failed');
    });

    it('records "Unknown error during template update" when non-Error is thrown', async () => {
        const work = {
            id: 'w1',
            slug: 's1',
            user: { id: 'u1' },
        } as unknown as Work;
        workRepository.findWithWebsiteAutoUpdateEnabled.mockResolvedValue([work]);
        websiteUpdateService.checkForUpdate.mockResolvedValue({
            updateAvailable: true,
            branch: 'main',
            currentCommit: 'a',
            latestCommit: 'b',
        });
        websiteUpdateService.updateRepository.mockRejectedValue('weird');

        await service.handleScheduledTemplateUpdates();

        expect(workRepository.update).toHaveBeenCalledWith('w1', {
            websiteTemplateLastError: 'Unknown error during template update',
        });
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to update template for work s1: Unknown error during template update',
        );
    });

    it('logs the outer error stack when findWithWebsiteAutoUpdateEnabled throws', async () => {
        const boom = new Error('repo down');
        workRepository.findWithWebsiteAutoUpdateEnabled.mockRejectedValue(boom);

        await service.handleScheduledTemplateUpdates();
        expect(errorSpy).toHaveBeenCalledWith(
            'Error during scheduled template update check',
            boom.stack,
        );
    });
});
