// EW-628 G6 — the `agentConfig` import below is the live agent-side
// config object that reads `process.env.DATA_SYNC_WEBHOOK_ENABLED`. We
// stub it so tests can flip the flag without touching env vars.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/import', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            dataSync: {
                webhookEnabled: jest.fn().mockReturnValue(true),
            },
        },
    },
}));

import { GitHubAppSyncService } from './github-app-sync.service';
import { config as agentConfig } from '@ever-works/agent/config';

const webhookEnabledMock = agentConfig.subscriptions.dataSync.webhookEnabled as jest.Mock;

describe('GitHubAppSyncService', () => {
    beforeEach(() => {
        // Default the EW-628 webhook flag back to enabled before each
        // test so the legacy assertions keep observing the happy path.
        webhookEnabledMock.mockReturnValue(true);
    });

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
        const workRepository = {
            findByDataRepoFullName: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(null),
        };

        const service = new GitHubAppSyncService(
            gitHubAppService as any,
            gitHubAppInstallationRepository as any,
            gitHubAppInstallationRepoRepository as any,
            sourceRepoAnalyzerService as any,
            workImportService as any,
            workRepository as any,
        );

        return {
            service,
            gitHubAppInstallationRepository,
            workRepository,
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

    // EW-628 G6 — `push` handler now resolves the data-repo full_name to
    // matching Works and stamps `pendingSyncRequestedAt` on each one.
    // The dispatcher's debounce window collapses bursts into a single sync.
    describe('handleWebhook — push event (EW-628 G6)', () => {
        it('does NOT touch the installation upsert path on push (routing is isolated)', async () => {
            const { service, gitHubAppInstallationRepository, workRepository } = createService();

            await expect(
                service.handleWebhook('push', {
                    repository: { full_name: 'octocat/awesome-time-tracking-data' },
                } as any),
            ).resolves.toBeUndefined();

            expect(gitHubAppInstallationRepository.upsertFromGithub).not.toHaveBeenCalled();
            expect(gitHubAppInstallationRepository.markDeleted).not.toHaveBeenCalled();
            // The resolve-by-full-name lookup IS invoked even when zero
            // matches — that's how we keep response timing stable for
            // unmanaged repos pinging the App.
            expect(workRepository.findByDataRepoFullName).toHaveBeenCalledWith(
                'octocat/awesome-time-tracking-data',
            );
        });

        it('drops a push without repository.full_name without invoking the work lookup', async () => {
            const { service, workRepository } = createService();

            await expect(service.handleWebhook('push', {} as any)).resolves.toBeUndefined();
            await expect(
                service.handleWebhook('push', { repository: {} } as any),
            ).resolves.toBeUndefined();

            expect(workRepository.findByDataRepoFullName).not.toHaveBeenCalled();
        });

        it('ignores unknown event names (regression guard for the if/if/if dispatch chain)', async () => {
            const { service, gitHubAppInstallationRepository, workRepository } = createService();

            await expect(
                service.handleWebhook('ping', { zen: 'Speak like a human.' } as any),
            ).resolves.toBeUndefined();

            expect(gitHubAppInstallationRepository.upsertFromGithub).not.toHaveBeenCalled();
            expect(gitHubAppInstallationRepository.markDeleted).not.toHaveBeenCalled();
            expect(workRepository.findByDataRepoFullName).not.toHaveBeenCalled();
        });

        it('flag-gated: skips the lookup + UPDATE when subscriptions.dataSync.webhookEnabled is false', async () => {
            const { service, workRepository } = createService();
            webhookEnabledMock.mockReturnValue(false);

            await service.handleWebhook('push', {
                repository: { full_name: 'octocat/data' },
            } as any);

            expect(workRepository.findByDataRepoFullName).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('updates pendingSyncRequestedAt on every matching Work when the flag is on', async () => {
            const { service, workRepository } = createService();
            workRepository.findByDataRepoFullName.mockResolvedValue([
                { id: 'work-a' },
                { id: 'work-b' },
            ]);

            await service.handleWebhook('push', {
                repository: { full_name: 'octocat/data' },
            } as any);

            expect(workRepository.findByDataRepoFullName).toHaveBeenCalledWith('octocat/data');
            expect(workRepository.update).toHaveBeenCalledTimes(2);
            expect(workRepository.update).toHaveBeenCalledWith(
                'work-a',
                expect.objectContaining({ pendingSyncRequestedAt: expect.any(Date) }),
            );
            expect(workRepository.update).toHaveBeenCalledWith(
                'work-b',
                expect.objectContaining({ pendingSyncRequestedAt: expect.any(Date) }),
            );
        });

        it('zero matches → no UPDATEs (silent return; timing-safe for unmanaged repos)', async () => {
            const { service, workRepository } = createService();
            workRepository.findByDataRepoFullName.mockResolvedValue([]);

            await service.handleWebhook('push', {
                repository: { full_name: 'somebody-else/random' },
            } as any);

            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('swallows lookup errors so a webhook 5xx never blocks GitHub retries', async () => {
            const { service, workRepository } = createService();
            workRepository.findByDataRepoFullName.mockRejectedValue(new Error('DB down'));

            await expect(
                service.handleWebhook('push', {
                    repository: { full_name: 'octocat/data' },
                } as any),
            ).resolves.toBeUndefined();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('swallows UPDATE errors after a partial fan-out (one row failing does not throw the request)', async () => {
            const { service, workRepository } = createService();
            workRepository.findByDataRepoFullName.mockResolvedValue([
                { id: 'work-a' },
                { id: 'work-b' },
            ]);
            workRepository.update.mockImplementation(async (id: string) => {
                if (id === 'work-b') throw new Error('row locked');
                return null;
            });

            await expect(
                service.handleWebhook('push', {
                    repository: { full_name: 'octocat/data' },
                } as any),
            ).resolves.toBeUndefined();
        });
    });
});
