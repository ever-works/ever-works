import {
    GitHubAppInstallationRepoRepository,
    GitHubAppInstallationRepository,
} from '@ever-works/agent/database';
import { Injectable } from '@nestjs/common';
import { config } from '@src/config/constants';
import { GitHubAppService } from './github-app.service';

@Injectable()
export class GitHubAppSyncService {
    constructor(
        private readonly gitHubAppService: GitHubAppService,
        private readonly gitHubAppInstallationRepository: GitHubAppInstallationRepository,
        private readonly gitHubAppInstallationRepoRepository: GitHubAppInstallationRepoRepository,
    ) {}

    async listInstallationsForUser(userId: string) {
        const installations =
            await this.gitHubAppInstallationRepository.listByCreatedByUserId(userId);

        return Promise.all(
            installations.map(async (installation) => ({
                ...installation,
                repositories: await this.gitHubAppInstallationRepoRepository.listForInstallation(
                    installation.id,
                ),
            })),
        );
    }

    async syncInstallation(installationId: string, userId?: string) {
        const installation =
            await this.gitHubAppInstallationRepository.findByInstallationId(installationId);
        if (!installation) {
            return null;
        }

        if (userId && installation.createdByUserId !== userId) {
            return null;
        }

        const repositories = await this.gitHubAppService.listInstallationRepositories(
            installation.installationId,
        );

        const persistedRepositories =
            await this.gitHubAppInstallationRepoRepository.replaceForInstallation(
                installation.id,
                repositories.map((repository) => ({
                    githubRepoId: String(repository.id),
                    owner: repository.owner?.login || installation.accountLogin,
                    repo: repository.name,
                    fullName:
                        repository.full_name ||
                        `${repository.owner?.login || installation.accountLogin}/${repository.name}`,
                    isPrivate: repository.private,
                    defaultBranch: repository.default_branch || null,
                    selected: true,
                })),
            );

        return {
            ...installation,
            repositories: persistedRepositories,
        };
    }

    async handleWebhook(eventName: string, payload: any) {
        if (eventName === 'installation') {
            const action = payload?.action;
            const installationPayload = payload?.installation;
            if (!installationPayload?.id) {
                return;
            }

            if (action === 'deleted') {
                await this.gitHubAppInstallationRepository.markSuspended(
                    String(installationPayload.id),
                    new Date(),
                );
                return;
            }

            const installation = await this.gitHubAppInstallationRepository.upsertFromGithub({
                installationId: String(installationPayload.id),
                appSlug: installationPayload.app_slug || config.githubApp.slug(),
                accountLogin: installationPayload.account?.login || '',
                accountType: installationPayload.account?.type || 'User',
                targetType: installationPayload.target_type || 'User',
                createdByGithubUserId: payload?.sender?.id ? String(payload.sender.id) : null,
                suspendedAt:
                    action === 'suspend'
                        ? new Date()
                        : installationPayload.suspended_at
                          ? new Date(installationPayload.suspended_at)
                          : null,
                rawPayload: installationPayload,
            });

            if (
                action === 'created' ||
                action === 'new_permissions_accepted' ||
                action === 'unsuspend'
            ) {
                await this.syncInstallation(installation.installationId);
            }

            return installation;
        }

        if (eventName === 'installation_repositories') {
            const installationId = payload?.installation?.id;
            if (!installationId) {
                return;
            }

            return this.syncInstallation(String(installationId));
        }
    }
}
