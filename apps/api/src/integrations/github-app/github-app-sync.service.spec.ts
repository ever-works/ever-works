import { GitHubAppSyncService } from './github-app-sync.service';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/import', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));

describe('GitHubAppSyncService', () => {
    const createService = () => {
        const gitHubAppService = {
            listInstallationRepositories: jest.fn(),
            createInstallationAccessToken: jest.fn(),
        };
        const gitHubAppInstallationRepository = {
            listByCreatedByUserId: jest.fn(),
            findByInstallationId: jest.fn(),
            upsertFromGithub: jest.fn(),
            markDeleted: jest.fn(),
        };
        const gitHubAppInstallationRepoRepository = {
            listForInstallation: jest.fn(),
            replaceForInstallation: jest.fn(),
            findById: jest.fn(),
        };
        const sourceRepoAnalyzerService = {
            analyzeRepository: jest.fn(),
        };
        const directoryImportService = {
            onboardLinkedRepository: jest.fn(),
        };

        const service = new GitHubAppSyncService(
            gitHubAppService as any,
            gitHubAppInstallationRepository as any,
            gitHubAppInstallationRepoRepository as any,
            sourceRepoAnalyzerService as any,
            directoryImportService as any,
        );

        return {
            service,
            gitHubAppInstallationRepository,
        };
    };

    it('only sets createdByGithubUserId on installation.created', async () => {
        const { service, gitHubAppInstallationRepository } = createService();
        gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue({
            installationId: '12345',
        });
        const syncSpy = jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

        await service.handleWebhook('installation', {
            action: 'new_permissions_accepted',
            installation: {
                id: 12345,
                app_slug: 'ever-works',
                account: {
                    login: 'acme',
                    type: 'Organization',
                },
                target_type: 'Organization',
            },
            sender: {
                id: 999,
            },
        });

        expect(gitHubAppInstallationRepository.upsertFromGithub).toHaveBeenCalledWith(
            expect.objectContaining({
                installationId: '12345',
                createdByGithubUserId: undefined,
            }),
        );
        expect(syncSpy).toHaveBeenCalledWith('12345');
    });

    it('clears suspendedAt explicitly on installation.unsuspend', async () => {
        const { service, gitHubAppInstallationRepository } = createService();
        gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue({
            installationId: '12345',
        });
        jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

        await service.handleWebhook('installation', {
            action: 'unsuspend',
            installation: {
                id: 12345,
                app_slug: 'ever-works',
                account: {
                    login: 'acme',
                    type: 'Organization',
                },
                target_type: 'Organization',
                suspended_at: '2026-05-01T00:00:00.000Z',
            },
        });

        expect(gitHubAppInstallationRepository.upsertFromGithub).toHaveBeenCalledWith(
            expect.objectContaining({
                installationId: '12345',
                deletedAt: undefined,
                suspendedAt: null,
            }),
        );
    });
});
