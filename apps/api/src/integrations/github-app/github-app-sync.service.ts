import {
    GitHubAppInstallationRepoRepository,
    GitHubAppInstallationRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { User } from '@ever-works/agent/entities';
import { SourceRepoAnalyzerService } from '@ever-works/agent/import';
import { WorkImportService } from '@ever-works/agent/services';
import { Injectable, Logger } from '@nestjs/common';
import { config } from '@src/config/constants';
import { config as agentConfig } from '@ever-works/agent/config';
import { GitHubAppService } from './github-app.service';

type InstallationWebhookPayload = {
    action?: string;
    installation?: {
        id?: number;
        app_slug?: string;
        target_type?: string;
        suspended_at?: string | null;
        account?: {
            login?: string;
            type?: string;
        };
    };
    sender?: {
        id?: number;
    };
};

type InstallationRepositoriesWebhookPayload = {
    installation?: {
        id?: number;
    };
};

@Injectable()
export class GitHubAppSyncService {
    private readonly logger = new Logger(GitHubAppSyncService.name);

    constructor(
        private readonly gitHubAppService: GitHubAppService,
        private readonly gitHubAppInstallationRepository: GitHubAppInstallationRepository,
        private readonly gitHubAppInstallationRepoRepository: GitHubAppInstallationRepoRepository,
        private readonly sourceRepoAnalyzerService: SourceRepoAnalyzerService,
        private readonly workImportService: WorkImportService,
        // EW-628 G6 — webhook `push` handler resolves the Work by data-repo
        // full-name and stamps `pendingSyncRequestedAt` so the dispatcher
        // picks the row up on the next tick.
        private readonly workRepository: WorkRepository,
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

        if (installation.deletedAt) {
            return null;
        }

        if (installation.suspendedAt) {
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

    async onboardInstallationRepository(installationId: string, repositoryId: string, user: User) {
        const installation =
            await this.gitHubAppInstallationRepository.findByInstallationId(installationId);
        if (!installation || installation.createdByUserId !== user.id) {
            return null;
        }

        if (installation.deletedAt) {
            return null;
        }

        if (installation.suspendedAt) {
            return null;
        }

        const repository = await this.gitHubAppInstallationRepoRepository.findById(repositoryId);
        if (!repository || repository.installationEntityId !== installation.id) {
            return null;
        }

        const installationToken =
            await this.gitHubAppService.createInstallationAccessToken(installationId);
        const sourceUrl = `https://github.com/${repository.fullName}`;
        const analysis = await this.sourceRepoAnalyzerService.analyzeRepository(
            sourceUrl,
            installationToken,
        );

        if (analysis.error) {
            return {
                status: 'error' as const,
                message: analysis.error,
            };
        }

        if (analysis.detectedType !== 'data_repo') {
            return {
                status: 'error' as const,
                message:
                    'Only existing data repositories can be onboarded from GitHub App installations right now',
            };
        }

        return this.workImportService.onboardLinkedRepository(
            {
                sourceUrl,
                sourceOwner: repository.owner,
                sourceRepo: repository.repo,
                name: analysis.worksConfig?.name || repository.repo,
                gitProvider: 'github',
                organization: installation.targetType === 'Organization',
                auth: {
                    mode: 'github_app_installation',
                    providerId: 'github',
                    installationId,
                    installationRepositoryId: repository.id,
                    repoFullName: repository.fullName,
                },
            },
            user,
        );
    }

    async handleWebhook(
        eventName: string,
        payload: InstallationWebhookPayload | InstallationRepositoriesWebhookPayload,
    ) {
        if (eventName === 'installation') {
            const installationPayloadWrapper = payload as InstallationWebhookPayload;
            const action = installationPayloadWrapper.action;
            const installationPayload = installationPayloadWrapper.installation;
            if (!installationPayload?.id) {
                return;
            }

            if (action === 'deleted') {
                await this.gitHubAppInstallationRepository.markDeleted(
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
                createdByGithubUserId:
                    action === 'created' && installationPayloadWrapper.sender?.id
                        ? String(installationPayloadWrapper.sender.id)
                        : undefined,
                deletedAt: undefined,
                suspendedAt:
                    action === 'suspend'
                        ? new Date()
                        : action === 'unsuspend'
                          ? null
                          : installationPayload.suspended_at
                            ? new Date(installationPayload.suspended_at)
                            : undefined,
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
            const installationId = (payload as InstallationRepositoriesWebhookPayload)?.installation
                ?.id;
            if (!installationId) {
                return;
            }

            return this.syncInstallation(String(installationId));
        }

        // EW-628 Phase 5 — GitHub App `push` events on a Work's data repo
        // surface here. Spec: docs/specs/features/data-repo-instant-sync/
        // spec.md §5.1. The handler must:
        //   1. Resolve repository.full_name to a Work via the work
        //      repository (look up by `Work.dataRepo.fullName`).
        //   2. UPDATE work SET pending_sync_requested_at = now() WHERE id = :id.
        //      Multiple commits within the dispatcher's 30s quiet-period
        //      naturally collapse to one column update — no debounce queue
        //      needed.
        //   3. Stay inert when subscriptions.dataSync.webhookEnabled is
        //      false (default — flag lands in Phase 8). Push payload is
        //      acknowledged with 200 OK regardless so GitHub doesn't retry.
        //
        // Phase 5 (this commit) lands the event-name branch + the
        // structured handler stub. The body — Work resolution + UPDATE —
        // arrives in the Phase 5 follow-up alongside the flag wiring.
        if (eventName === 'push') {
            return this.handlePushEvent(payload as PushWebhookPayload);
        }
    }

    /**
     * EW-628 G6 — handler invoked when the GitHub App receives a
     * `push` event on a repo (typically a Work's data repo). Sets
     * `Work.pendingSyncRequestedAt = now()` on every matching Work so
     * the dispatcher's next tick picks them up after the 30 s
     * quiet-period debounce.
     *
     * Behaviour:
     *   - No `repository.full_name` → silent return (timing-safe).
     *   - `subscriptions.dataSync.webhookEnabled === false` → silent
     *     return AFTER the resolve step, so the flag flip ramps the
     *     feature on without any deploy churn.
     *   - Lookup misses (no Work has this data repo, or none has the
     *     App installed) → silent return so an unmanaged push can't
     *     leak installation → Work mapping via response timing.
     *   - One or more Works matched → UPDATE each row's
     *     `pendingSyncRequestedAt`. Multiple commits within the
     *     dispatcher's 30 s quiet-period naturally collapse to one
     *     column update because the dispatcher only flushes once per
     *     debounce window.
     *
     * Errors are caught — webhook ACKs must stay timing-stable and
     * GitHub retries flooding on 5xx would not help. The activity feed
     * still surfaces the missed sync via the dispatcher's `no-changes`
     * row once the data repo is queried directly.
     */
    private async handlePushEvent(payload: PushWebhookPayload): Promise<void> {
        const repoFullName = payload?.repository?.full_name;
        if (!repoFullName) {
            return;
        }

        if (!agentConfig.subscriptions.dataSync.webhookEnabled()) {
            // Flag off — accept the delivery (200 OK to GitHub via the
            // controller) and drop the body. The resolve/UPDATE only
            // happens once the flag is on, so the soak window is opt-in.
            return;
        }

        try {
            const works = await this.workRepository.findByDataRepoFullName(repoFullName);
            if (works.length === 0) {
                return;
            }

            const now = new Date();
            await Promise.all(
                works.map((work) =>
                    this.workRepository.update(work.id, {
                        pendingSyncRequestedAt: now,
                    }),
                ),
            );
            this.logger.debug(
                `EW-628 push: stamped pendingSyncRequestedAt on ${works.length} Work(s) for ${repoFullName}`,
            );
        } catch (err) {
            this.logger.warn(
                `EW-628 push handler failed for ${repoFullName}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
}

/**
 * Minimal subset of the GitHub `push` webhook payload that EW-628 cares
 * about. We only need the repository full_name to resolve the Work; the
 * rest of the payload (commits, pusher, ref, etc.) is irrelevant for
 * the render-only sync that the dispatcher kicks off.
 */
interface PushWebhookPayload {
    repository?: {
        full_name?: string;
    };
}
