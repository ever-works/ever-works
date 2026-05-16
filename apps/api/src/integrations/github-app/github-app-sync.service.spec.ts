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
        const workImportService = {
            onboardLinkedRepository: jest.fn(),
        };

        const service = new GitHubAppSyncService(
            gitHubAppService as any,
            gitHubAppInstallationRepository as any,
            gitHubAppInstallationRepoRepository as any,
            sourceRepoAnalyzerService as any,
            workImportService as any,
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

    it('does not onboard repositories for deleted installations', async () => {
        const { service, gitHubAppInstallationRepository } = createService();
        gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            createdByUserId: 'user-1',
            deletedAt: new Date('2026-05-01T00:00:00.000Z'),
        });

        const result = await service.onboardInstallationRepository('12345', 'repo-1', {
            id: 'user-1',
        } as any);

        expect(result).toBeNull();
    });

    it('does not sync suspended installations', async () => {
        const { service, gitHubAppInstallationRepository } = createService();
        gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            createdByUserId: 'user-1',
            suspendedAt: new Date('2026-05-01T00:00:00.000Z'),
        });

        const result = await service.syncInstallation('12345', 'user-1');

        expect(result).toBeNull();
    });

    it('does not onboard repositories for suspended installations', async () => {
        const { service, gitHubAppInstallationRepository } = createService();
        gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
            id: 'installation-row-1',
            installationId: '12345',
            createdByUserId: 'user-1',
            suspendedAt: new Date('2026-05-01T00:00:00.000Z'),
        });

        const result = await service.onboardInstallationRepository('12345', 'repo-1', {
            id: 'user-1',
        } as any);

        expect(result).toBeNull();
    });

    // EW-628 Phase 5 — pin the `push` event branch added to handleWebhook so
    // future event-name additions / refactors don't accidentally regress it.
    // The handler body is currently a structured TODO (Work resolve + UPDATE
    // arrives in the Phase 5 follow-up alongside the webhookEnabled flag);
    // these tests pin the routing and early-exit shape.
    describe('handleWebhook — push event (EW-628 Phase 5)', () => {
        it('accepts a `push` event with repository.full_name without throwing', async () => {
            const { service, gitHubAppInstallationRepository } = createService();

            await expect(
                service.handleWebhook('push', {
                    repository: { full_name: 'octocat/awesome-time-tracking-data' },
                } as any),
            ).resolves.toBeUndefined();

            // Push branch must NOT touch the installation upsert path that
            // the installation/installation_repositories branches own.
            expect(gitHubAppInstallationRepository.upsertFromGithub).not.toHaveBeenCalled();
            expect(gitHubAppInstallationRepository.markDeleted).not.toHaveBeenCalled();
        });

        it('drops a `push` event whose payload has no repository.full_name (timing-safe early return)', async () => {
            const { service, gitHubAppInstallationRepository } = createService();

            await expect(service.handleWebhook('push', {} as any)).resolves.toBeUndefined();
            await expect(
                service.handleWebhook('push', { repository: {} } as any),
            ).resolves.toBeUndefined();

            expect(gitHubAppInstallationRepository.upsertFromGithub).not.toHaveBeenCalled();
        });

        it('ignores unknown event names (regression guard for the if/if/if dispatch chain)', async () => {
            const { service, gitHubAppInstallationRepository } = createService();

            await expect(
                service.handleWebhook('ping', { zen: 'Speak like a human.' } as any),
            ).resolves.toBeUndefined();

            expect(gitHubAppInstallationRepository.upsertFromGithub).not.toHaveBeenCalled();
            expect(gitHubAppInstallationRepository.markDeleted).not.toHaveBeenCalled();
        });
    });
});
