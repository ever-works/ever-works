// EW-628 G6 — the `agentConfig` import below is the live agent-side
// config object that reads `process.env.DATA_SYNC_WEBHOOK_ENABLED`. We
// stub it so tests can flip the flag without touching env vars.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/import', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
// A DI token only — the refresh itself is pinned in app-spec.service.spec.ts.
jest.mock('@ever-works/agent/app-spec', () => ({ AppSpecService: class AppSpecService {} }));
// Only a DI token here — the claim rules are pinned in its own spec.
jest.mock('./github-app-onboarding.service', () => ({
    GitHubAppOnboardingService: class {},
}));
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
        const onboardingService = {
            claimForRecordedInstaller: jest.fn().mockResolvedValue(null),
        };

        const service = new GitHubAppSyncService(
            gitHubAppService as any,
            gitHubAppInstallationRepository as any,
            gitHubAppInstallationRepoRepository as any,
            sourceRepoAnalyzerService as any,
            workImportService as any,
            workRepository as any,
            onboardingService as any,
        );

        return {
            service,
            gitHubAppService,
            gitHubAppInstallationRepository,
            gitHubAppInstallationRepoRepository,
            workRepository,
            onboardingService,
        };
    };

    // Security (EW-722 info-leak): `rawPayload` is the verbatim GitHub
    // webhook payload persisted for auditing. It must never be returned
    // to API clients — both read paths strip it before responding.
    describe('rawPayload is stripped from API responses', () => {
        it('listInstallationsForUser omits rawPayload', async () => {
            const {
                service,
                gitHubAppInstallationRepository,
                gitHubAppInstallationRepoRepository,
            } = createService();
            gitHubAppInstallationRepository.listByCreatedByUserId.mockResolvedValue([
                {
                    id: 'installation-row-1',
                    installationId: '12345',
                    accountLogin: 'acme',
                    rawPayload: { secret: 'do-not-leak' },
                },
            ]);
            gitHubAppInstallationRepoRepository.listForInstallation.mockResolvedValue([]);

            const result = await service.listInstallationsForUser('user-1');

            expect(result).toHaveLength(1);
            expect(result[0]).not.toHaveProperty('rawPayload');
            expect(result[0]).toMatchObject({
                id: 'installation-row-1',
                installationId: '12345',
                accountLogin: 'acme',
                repositories: [],
            });
        });

        it('syncInstallation omits rawPayload', async () => {
            const {
                service,
                gitHubAppService,
                gitHubAppInstallationRepository,
                gitHubAppInstallationRepoRepository,
            } = createService();
            gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
                id: 'installation-row-1',
                installationId: '12345',
                createdByUserId: 'user-1',
                accountLogin: 'acme',
                rawPayload: { secret: 'do-not-leak' },
            });
            gitHubAppService.listInstallationRepositories.mockResolvedValue([]);
            gitHubAppInstallationRepoRepository.replaceForInstallation.mockResolvedValue([]);

            const result = await service.syncInstallation('12345', 'user-1');

            expect(result).not.toBeNull();
            expect(result).not.toHaveProperty('rawPayload');
            expect(result).toMatchObject({
                id: 'installation-row-1',
                installationId: '12345',
                repositories: [],
            });
        });
    });

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

    // Prod 2026-10-17 — the App was made public and installed on four more
    // orgs straight from github.com. The verified `installation.created`
    // webhook recorded each row with `createdByGithubUserId` (the sender) but
    // `createdByUserId` stayed NULL, because only the setup-URL redirect ever
    // claimed one. A verified delivery now claims it for the recorded
    // installer; the claim rules themselves live in the onboarding spec.
    describe('handleWebhook — installer auto-claim (verified deliveries only)', () => {
        const CREATED = {
            action: 'created',
            installation: {
                id: 12345,
                app_slug: 'ever-works',
                account: { login: 'ever-co', type: 'Organization' },
                target_type: 'Organization',
            },
            sender: { id: 7001 },
        };
        const recordedRow = {
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'ever-co',
            createdByUserId: null,
            createdByGithubUserId: '7001',
        };

        it('claims the recorded row for an App-secret-verified installation.created, before syncing', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue(recordedRow);
            const claimedRow = { ...recordedRow, createdByUserId: 'user-owner' };
            onboardingService.claimForRecordedInstaller.mockResolvedValue(claimedRow);
            const syncSpy = jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            const result = await service.handleWebhook('installation', CREATED, {
                appSecretVerified: true,
            });

            expect(gitHubAppInstallationRepository.upsertFromGithub).toHaveBeenCalledWith(
                expect.objectContaining({ createdByGithubUserId: '7001' }),
            );
            expect(onboardingService.claimForRecordedInstaller).toHaveBeenCalledWith(recordedRow);
            expect(syncSpy).toHaveBeenCalledWith('12345');
            expect(result).toEqual(claimedRow);
        });

        it.each([
            ['no context (a caller that did not verify)', undefined],
            ['appSecretVerified: false (per-install secret)', { appSecretVerified: false }],
        ])('never claims for %s', async (_label, context) => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue(recordedRow);
            const syncSpy = jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            const result = await service.handleWebhook('installation', CREATED, context);

            expect(onboardingService.claimForRecordedInstaller).not.toHaveBeenCalled();
            expect(syncSpy).toHaveBeenCalledWith('12345');
            expect(result).toEqual(recordedRow);
        });

        it('leaves an already-claimed row untouched (no claim attempt)', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            const owned = { ...recordedRow, createdByUserId: 'user-someone' };
            gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue(owned);
            jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            const result = await service.handleWebhook('installation', CREATED, {
                appSecretVerified: true,
            });

            expect(onboardingService.claimForRecordedInstaller).not.toHaveBeenCalled();
            expect(result).toEqual(owned);
        });

        it('never fails installation sync when the claim throws', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            gitHubAppInstallationRepository.upsertFromGithub.mockResolvedValue(recordedRow);
            onboardingService.claimForRecordedInstaller.mockRejectedValue(new Error('DB down'));
            const syncSpy = jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            await expect(
                service.handleWebhook('installation', CREATED, { appSecretVerified: true }),
            ).resolves.toEqual(recordedRow);
            expect(syncSpy).toHaveBeenCalledWith('12345');
        });

        it('does not claim on installation.deleted', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();

            await service.handleWebhook(
                'installation',
                { ...CREATED, action: 'deleted' },
                { appSecretVerified: true },
            );

            expect(gitHubAppInstallationRepository.markDeleted).toHaveBeenCalledWith(
                '12345',
                expect.any(Date),
            );
            expect(onboardingService.claimForRecordedInstaller).not.toHaveBeenCalled();
        });

        it('retries the claim on a verified installation_repositories delivery', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue(recordedRow);
            const syncSpy = jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            await service.handleWebhook(
                'installation_repositories',
                { installation: { id: 12345 } },
                { appSecretVerified: true },
            );

            expect(onboardingService.claimForRecordedInstaller).toHaveBeenCalledWith(recordedRow);
            expect(syncSpy).toHaveBeenCalledWith('12345');
        });

        it('does not look the row up or claim on an unverified installation_repositories delivery', async () => {
            const { service, gitHubAppInstallationRepository, onboardingService } = createService();
            jest.spyOn(service, 'syncInstallation').mockResolvedValue(null as any);

            await service.handleWebhook('installation_repositories', {
                installation: { id: 12345 },
            });

            expect(gitHubAppInstallationRepository.findByInstallationId).not.toHaveBeenCalled();
            expect(onboardingService.claimForRecordedInstaller).not.toHaveBeenCalled();
        });
    });

    // EW-628 G6 — `push` handler now resolves the data-repo full_name to
    // matching Works and stamps `pendingSyncRequestedAt` on each one.
    // The dispatcher's debounce window collapses bursts into a single sync.
    describe('handleWebhook — push to an App Work refreshes its App spec (live e2e 2026-10-18)', () => {
        const { AppSpecService } = jest.requireMock('@ever-works/agent/app-spec') as {
            AppSpecService: new () => unknown;
        };
        const flush = () => new Promise((resolve) => setImmediate(resolve));

        function withSpecs(refreshIfHeadMoved: jest.Mock) {
            const built = createService();
            const moduleRef = {
                get: jest.fn((token: unknown) => {
                    if (token === AppSpecService) return { refreshIfHeadMoved };
                    throw new Error('unknown');
                }),
            };
            const service = new GitHubAppSyncService(
                built.gitHubAppService as any,
                built.gitHubAppInstallationRepository as any,
                built.gitHubAppInstallationRepoRepository as any,
                {} as any,
                {} as any,
                built.workRepository as any,
                built.onboardingService as any,
                moduleRef as any,
            );
            (built.workRepository as any).findAppWorksByDataRepoFullName = jest
                .fn()
                .mockResolvedValue([{ id: 'app-1' }]);
            built.gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
                installationId: '77',
                organizationId: 'org-1',
                createdByUserId: 'user-1',
            });
            return { ...built, service };
        }

        it('re-evaluates each App Work of the pushed repository, scoped by the installation', async () => {
            const refresh = jest.fn().mockResolvedValue({ refreshed: true, headCommitSha: 'f9f' });
            const { service, workRepository } = withSpecs(refresh);

            await service.handleWebhook(
                'push',
                { repository: { full_name: 'ever-works/app' }, installation: { id: 77 } } as any,
                { appSecretVerified: true },
            );
            await flush();

            expect((workRepository as any).findAppWorksByDataRepoFullName).toHaveBeenCalledWith(
                'ever-works/app',
                { organizationId: 'org-1' },
            );
            expect(refresh).toHaveBeenCalledWith('app-1');
        });

        it('does nothing for a delivery whose HMAC did not verify against the App secret', async () => {
            const refresh = jest.fn();
            const { service, workRepository } = withSpecs(refresh);

            await service.handleWebhook('push', {
                repository: { full_name: 'ever-works/app' },
                installation: { id: 77 },
            } as any);
            await flush();

            expect((workRepository as any).findAppWorksByDataRepoFullName).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
        });
    });

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
