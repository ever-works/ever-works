import { WorksConfigRepositorySyncService } from '../services/works-config-repository-sync.service';
import { WorksConfigSyncFailedEvent } from '@src/events';

jest.mock('@src/generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn().mockResolvedValue({ dir: '/tmp/data-repo' }) },
}));

describe('WorksConfigRepositorySyncService', () => {
    const directory = {
        id: 'dir-1',
        gitProvider: 'github',
        user: { id: 'owner-1' },
        getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        getDataRepo: jest.fn().mockReturnValue('compare-cloud-pricing-data'),
        resolveCommitter: jest.fn().mockReturnValue({
            name: 'User One',
            email: 'user@example.com',
        }),
    };

    const createService = (changes: Array<{ path: string; status: string }> = []) => {
        const directoryRepository = { findById: jest.fn().mockResolvedValue(directory) };
        const gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/data-repo'),
            getStatus: jest.fn().mockResolvedValue(changes),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue('commit-sha'),
            push: jest.fn().mockResolvedValue(undefined),
        };
        const projection = {
            buildWriteRequest: jest.fn().mockResolvedValue({
                name: 'Compare Cloud Pricing',
                providers: { ai: 'openai' },
            }),
        };
        const writer = { writeToDataRepository: jest.fn().mockResolvedValue(undefined) };
        const eventEmitter = { emit: jest.fn() };

        return {
            service: new WorksConfigRepositorySyncService(
                directoryRepository as any,
                gitFacade as any,
                projection as any,
                writer as any,
                eventEmitter as any,
            ),
            gitFacade,
            projection,
            writer,
            eventEmitter,
        };
    };

    it('writes projected works.yaml and skips commit when the repo is unchanged', async () => {
        const { service, gitFacade, projection, writer } = createService();

        await service.syncDirectory({
            directoryId: 'dir-1',
            userId: 'user-1',
            reason: 'schedule_updated',
        });

        expect(projection.buildWriteRequest).toHaveBeenCalledWith(directory);
        expect(writer.writeToDataRepository).toHaveBeenCalledWith({
            directory,
            dataRepository: { dir: '/tmp/data-repo' },
            request: {
                name: 'Compare Cloud Pricing',
                providers: { ai: 'openai' },
            },
        });
        expect(gitFacade.addAll).not.toHaveBeenCalled();
        expect(gitFacade.commit).not.toHaveBeenCalled();
        expect(gitFacade.push).not.toHaveBeenCalled();
    });

    it('commits and pushes when projected works.yaml changes the data repo', async () => {
        const { service, gitFacade } = createService([{ path: 'works.yaml', status: 'modified' }]);

        await service.syncDirectory({
            directoryId: 'dir-1',
            userId: 'user-1',
            reason: 'provider_changed',
        });

        expect(gitFacade.addAll).toHaveBeenCalledWith('github', '/tmp/data-repo');
        expect(gitFacade.commit).toHaveBeenCalledWith(
            'github',
            '/tmp/data-repo',
            'sync works.yaml after provider_changed',
            { name: 'User One', email: 'user@example.com' },
        );
        expect(gitFacade.push).toHaveBeenCalledWith(
            { dir: '/tmp/data-repo' },
            { userId: 'user-1', providerId: 'github' },
        );
    });

    it('emits a failure event when the non-blocking sync fails', async () => {
        const { service, gitFacade, eventEmitter } = createService([
            { path: 'works.yaml', status: 'modified' },
        ]);
        gitFacade.push.mockRejectedValue(new Error('permission denied'));

        await service.syncDirectory({
            directoryId: 'dir-1',
            userId: 'user-1',
            reason: 'provider_changed',
        });

        expect(eventEmitter.emit).toHaveBeenCalledWith(
            WorksConfigSyncFailedEvent.EVENT_NAME,
            expect.objectContaining({
                directoryId: 'dir-1',
                userId: 'user-1',
                reason: 'provider_changed',
                repository: 'ever-works/compare-cloud-pricing-data',
                errorMessage: 'permission denied',
            }),
        );
    });
});
