import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DeployFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import { DirectoryRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Directory, User } from '@ever-works/agent/entities';
import { WebsiteUpdateService, WEBSITE_TEMPLATE_CONFIG } from '@ever-works/agent/generators';
import type { BatchDeployItemDto, BatchDeployItemResultDto } from './dto/batch-deploy.dto';

interface RepoContext {
    owner: string;
    repo: string;
    token: string;
    publicKey: { key_id: string; key: string };
}

/**
 * DeployService handles deployment operations using the plugin system.
 *
 * It coordinates with:
 * - DeployFacade: For provider resolution and token management
 * - GitFacade: For repository operations and secrets
 * - WebsiteUpdateService: For repository updates
 */
@Injectable()
export class DeployService {
    private readonly logger = new Logger(DeployService.name);
    private readonly CRON_SECRET_LENGTH = 32;

    constructor(
        private readonly deployFacade: DeployFacadeService,
        private readonly gitFacade: GitFacadeService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly websiteUpdateService: WebsiteUpdateService,
    ) {}

    /**
     * Deploy a directory using its configured deployment provider
     */
    async deploy(
        directoryId: string,
        userId: string,
        options: { teamScope?: string },
    ): Promise<boolean> {
        const { plugin, token, directory } = await this.deployFacade.getPluginAndToken({
            userId,
            directoryId,
        });

        const user = directory.user as User;
        const gitToken = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: directory.gitProvider,
        });

        if (!gitToken) {
            throw new Error('Git provider token not available');
        }

        const ctx = await this.createRepoContext(
            directory.getRepoOwner(),
            directory.getWebsiteRepo(),
            gitToken,
        );

        await this.enableWorkflows({
            owner: ctx.owner,
            repo: ctx.repo,
            token: ctx.token,
            withDelay: false,
        });

        await this.setRequiredSecrets(ctx, token, directory);
        await this.setOptionalSecrets(ctx, options.teamScope, gitToken);
        await this.ensureCronSecret(ctx);

        return this.dispatchWithRetry(directory, user, gitToken);
    }

    /**
     * Batch deploy multiple directories
     */
    async deployBatch(
        directories: BatchDeployItemDto[],
        userId: string,
        defaultTeamScope?: string,
    ): Promise<{
        totalRequested: number;
        successfullyStarted: number;
        failed: number;
        results: BatchDeployItemResultDto[];
    }> {
        const results: BatchDeployItemResultDto[] = [];
        let successCount = 0;
        let failCount = 0;

        const MAX_CONCURRENT = 5;

        for (let i = 0; i < directories.length; i += MAX_CONCURRENT) {
            const batch = directories.slice(i, i + MAX_CONCURRENT);

            const batchResults = await Promise.allSettled(
                batch.map((item) =>
                    this.deploySingle(item.directoryId, userId, item.teamScope || defaultTeamScope),
                ),
            );

            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                const item = batch[j];

                if (result.status === 'fulfilled') {
                    results.push(result.value);
                    if (result.value.status === 'pending') {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } else {
                    failCount++;
                    results.push({
                        directoryId: item.directoryId,
                        slug: 'unknown',
                        status: 'error',
                        message: result.reason?.message || 'Unknown error',
                    });
                }
            }

            if (i + MAX_CONCURRENT < directories.length) {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        return {
            totalRequested: directories.length,
            successfullyStarted: successCount,
            failed: failCount,
            results,
        };
    }

    private async deploySingle(
        directoryId: string,
        userId: string,
        teamScope?: string,
    ): Promise<BatchDeployItemResultDto> {
        try {
            const directory = await this.directoryRepository.findById(directoryId);
            if (!directory) {
                return {
                    directoryId,
                    slug: 'unknown',
                    status: 'error',
                    message: 'Directory not found',
                };
            }

            const success = await this.deploy(directoryId, userId, { teamScope });

            return {
                directoryId,
                slug: directory.slug,
                status: success ? 'pending' : 'error',
                message: success ? 'Deployment started' : 'Failed to initiate deployment',
                owner: directory.getRepoOwner(),
                repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            };
        } catch (error) {
            return {
                directoryId,
                slug: 'unknown',
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    private async createRepoContext(
        owner: string,
        repo: string,
        token: string,
    ): Promise<RepoContext> {
        const publicKey = await this.getRepositoryPublicKey(owner, repo, token);
        return { owner, repo, token, publicKey };
    }

    private async setSecret(ctx: RepoContext, key: string, value: string) {
        return this.setActionSecret(
            { key, value, owner: ctx.owner, repo: ctx.repo },
            ctx.publicKey,
            ctx.token,
        );
    }

    private async setVariable(ctx: RepoContext, key: string, value: string) {
        return this.setActionVariable({ key, value, owner: ctx.owner, repo: ctx.repo }, ctx.token);
    }

    private async setRequiredSecrets(ctx: RepoContext, deployToken: string, directory: Directory) {
        const provider = directory.deployProvider || 'vercel';
        try {
            await this.setVariable(ctx, 'DEPLOY_PROVIDER', provider);
        } catch (error) {
            this.logger.error(
                `Failed to set DEPLOY_PROVIDER variable for ${ctx.owner}/${ctx.repo}: ${error.message}`,
            );
        }

        await Promise.all([
            this.setSecret(ctx, 'TENANT_ID', directory.id),
            this.setSecret(ctx, 'DATA_REPOSITORY', `${directory.slug}-data`),
            this.setSecret(ctx, `${provider.toUpperCase()}_TOKEN`, deployToken),
            this.setSecret(ctx, 'DEPLOY_TOKEN', deployToken),
        ]);
    }

    private async setOptionalSecrets(ctx: RepoContext, teamScope?: string, gitToken?: string) {
        const promises: Promise<void>[] = [];

        if (teamScope) {
            promises.push(this.setSecret(ctx, 'DEPLOY_TEAM_SCOPE', teamScope));
        }

        if (gitToken) {
            promises.push(this.setSecret(ctx, 'GH_TOKEN', gitToken));
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    private async ensureCronSecret(ctx: RepoContext) {
        // Always set a cron secret for new deployments
        const cronSecret = this.generateSecureToken();
        await this.setSecret(ctx, 'CRON_SECRET', cronSecret);
    }

    private generateSecureToken(): string {
        return randomBytes(this.CRON_SECRET_LENGTH).toString('hex');
    }

    private async dispatchWithRetry(
        directory: Directory,
        user: User,
        gitToken: string,
    ): Promise<boolean> {
        const workflowFilesToTry = ['deploy_vercel.yaml', 'deploy_prod.yaml'];
        const owner = directory.getRepoOwner();
        const repo = directory.getWebsiteRepo();

        const tryDispatch = async (): Promise<boolean> => {
            for (const workflowFile of workflowFilesToTry) {
                try {
                    this.logger.log(
                        `Attempting to dispatch workflow "${workflowFile}" for ${owner}/${repo}`,
                    );

                    await this.dispatchWorkflow(
                        {
                            workflow: workflowFile,
                            inputs: { environment: 'production' },
                            branch: WEBSITE_TEMPLATE_CONFIG.branch,
                            owner,
                            repo,
                        },
                        gitToken,
                    );

                    this.logger.log(
                        `Successfully dispatched workflow "${workflowFile}" for ${owner}/${repo}`,
                    );
                    return true;
                } catch (error) {
                    this.logger.warn(
                        `Failed to dispatch workflow "${workflowFile}" for ${owner}/${repo}: ${error.message}`,
                    );
                }
            }
            return false;
        };

        // First attempt
        const firstAttemptSuccess = await tryDispatch();
        if (firstAttemptSuccess) {
            return true;
        }

        // If dispatch fails, update the repository
        try {
            this.logger.log(`Workflow dispatch failed. Updating repository for ${owner}/${repo}`);
            await this.websiteUpdateService.updateRepository(directory, user);
            await this.createTriggerCommit(directory, user);
            await this.delay(3000);

            const retrySuccess = await tryDispatch();
            if (retrySuccess) {
                return true;
            }

            this.logger.log(
                `Manual dispatch failed, but push to main completed for ${owner}/${repo}`,
            );
            return true;
        } catch (error) {
            this.logger.error(`Failed to update repository for ${owner}/${repo}: ${error.message}`);
            return false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async createTriggerCommit(directory: Directory, user: User): Promise<void> {
        const directoryOwner = directory.user as User;

        try {
            const repoDir = await this.gitFacade.cloneOrPull(
                {
                    owner: directory.getRepoOwner(),
                    repo: directory.getWebsiteRepo(),
                    branch: WEBSITE_TEMPLATE_CONFIG.branch,
                    committer: directory.resolveCommitter(user),
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            const triggerFile = `${repoDir}/.deployment-trigger`;
            const fs = await import('node:fs/promises');
            await fs.writeFile(
                triggerFile,
                `Deployment triggered at ${new Date().toISOString()}\n`,
            );

            await this.gitFacade.add(directory.gitProvider, repoDir, '.deployment-trigger');
            await this.gitFacade.commit(
                directory.gitProvider,
                repoDir,
                `chore: trigger deployment\n\nTriggered by Ever Works platform`,
                directory.resolveCommitter(user),
            );
            await this.gitFacade.push(
                { dir: repoDir },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            this.logger.log(
                `Created trigger commit for ${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to create trigger commit for ${directory.getRepoOwner()}/${directory.getWebsiteRepo()}: ${error.message}`,
            );
        }
    }

    // GitHub Actions operations via plugin

    private getGitHubPlugin(): any {
        const registered = this.pluginRegistry.get('github');
        if (!registered || registered.state !== 'loaded') {
            throw new Error('GitHub plugin not available for CI/CD operations');
        }
        return registered.plugin;
    }

    private async getRepositoryPublicKey(
        owner: string,
        repo: string,
        token: string,
    ): Promise<{ key_id: string; key: string }> {
        const plugin = this.getGitHubPlugin();
        return plugin.getRepositoryPublicKey(owner, repo, token);
    }

    private async setActionSecret(
        data: { key: string; value: string; owner: string; repo: string },
        publicKey: { key_id: string; key: string },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.setActionSecret(data, publicKey, token);
    }

    private async setActionVariable(
        data: { key: string; value: string; owner: string; repo: string },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.setActionVariable(data, token);
    }

    private async enableWorkflows(params: {
        owner: string;
        repo: string;
        token: string;
        withDelay?: boolean;
    }): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.enableDeploymentWorkflows(
            params.owner,
            params.repo,
            params.token,
            params.withDelay,
        );
    }

    private async dispatchWorkflow(
        data: {
            workflow: string;
            inputs?: Record<string, unknown>;
            branch: string;
            owner: string;
            repo: string;
        },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.dispatchWorkflow(data, token);
    }
}
