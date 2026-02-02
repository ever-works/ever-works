import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DeployProvider, VercelInput } from './deploy.types';
import { GitFacadeService } from '../facades/git.facade';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WebsiteUpdateService } from '../generators/website-generator/website-update.service';
import { WEBSITE_TEMPLATE_CONFIG } from '../generators/website-generator';

interface RepoContext {
    owner: string;
    repo: string;
    token: string;
    publicKey: { key_id: string; key: string };
}

export type { Vercel } from '@vercel/sdk';

@Injectable()
export class VercelService {
    private readonly logger = new Logger(VercelService.name);
    private readonly PROVIDER_ID: DeployProvider = 'vercel';
    private readonly CRON_SECRET_LENGTH = 32;

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
    ) {}

    async deploy(vercelInput: VercelInput, directory: Directory, user: User) {
        const token = await this.getGitToken(user.id, directory.repoProvider);
        if (!token) {
            throw new Error('Git provider token not available');
        }

        const ctx = await this.createRepoContext(vercelInput.owner, vercelInput.repo, token);

        await this.enableWorkflows({
            owner: ctx.owner,
            repo: ctx.repo,
            token: ctx.token,
            withDelay: false,
        });

        await this.setRequiredSecrets(ctx, vercelInput, directory);
        await this.setOptionalSecrets(ctx, vercelInput);
        await this.ensureCronSecret(ctx);

        return this.dispatchWithRetry(vercelInput, directory, user, token);
    }

    async getAccountTeams(vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);
        const response = await vercel.teams.getTeams({});
        return response.teams;
    }

    async validateToken(vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);
        try {
            return await vercel.user.getAuthUser();
        } catch {
            return false;
        }
    }

    public async createVercelSDK(token: string) {
        const { Vercel } = await import('@vercel/sdk');
        return new Vercel({ bearerToken: token });
    }

    private async getGitToken(userId: string, providerId: string): Promise<string | null> {
        if (!providerId) return null;

        const provider = this.gitFacade.getAvailableProviders().find((p) => p.id === providerId);
        if (!provider) return null;

        const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
            userId,
            provider.id,
        );
        return oauthToken?.accessToken || null;
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

    private async setRequiredSecrets(
        ctx: RepoContext,
        vercelInput: VercelInput,
        directory: Directory,
    ) {
        try {
            await this.setVariable(ctx, 'DEPLOY_PROVIDER', this.PROVIDER_ID);
            this.logger.log(
                `Set DEPLOY_PROVIDER variable to "${this.PROVIDER_ID}" for ${ctx.owner}/${ctx.repo}`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to set DEPLOY_PROVIDER variable for ${ctx.owner}/${ctx.repo}: ${error.message}`,
            );
        }

        await Promise.all([
            this.setSecret(ctx, 'DATA_REPOSITORY', `${directory.slug}-data`),
            this.setSecret(ctx, 'VERCEL_TOKEN', vercelInput.data.vercelToken),
        ]);
    }

    private async setOptionalSecrets(ctx: RepoContext, vercelInput: VercelInput) {
        const promises: Promise<void>[] = [];

        if (vercelInput.data.vercelTeamScope) {
            promises.push(
                this.setSecret(ctx, 'VERCEL_TEAM_SCOPE', vercelInput.data.vercelTeamScope),
            );
        }

        if (vercelInput.data.ghToken) {
            promises.push(this.setSecret(ctx, 'GH_TOKEN', vercelInput.data.ghToken));
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    private async ensureCronSecret(ctx: RepoContext) {
        const existingSecret = await this.getActionSecret(
            ctx.owner,
            ctx.repo,
            'CRON_SECRET',
            ctx.token,
        );

        if (!existingSecret) {
            const cronSecret = this.generateSecureToken();
            await this.setSecret(ctx, 'CRON_SECRET', cronSecret);
        }
    }

    private generateSecureToken(): string {
        return randomBytes(this.CRON_SECRET_LENGTH).toString('hex');
    }

    private async dispatchWithRetry(
        vercelInput: VercelInput,
        directory: Directory,
        user: User,
        token: string,
    ): Promise<boolean> {
        // Workflow files to try, in order of preference:
        // 1. deploy_vercel.yaml - Has workflow_dispatch trigger (preferred)
        // 2. deploy_prod.yaml - May or may not have workflow_dispatch depending on template version
        const workflowFilesToTry = ['deploy_vercel.yaml', 'deploy_prod.yaml'];

        const tryDispatch = async (): Promise<boolean> => {
            // Try dispatching each workflow file by filename
            for (const workflowFile of workflowFilesToTry) {
                try {
                    this.logger.log(
                        `Attempting to dispatch workflow "${workflowFile}" for ${vercelInput.owner}/${vercelInput.repo}`,
                    );

                    await this.dispatchWorkflow(
                        {
                            workflow: workflowFile,
                            inputs: { environment: 'production' },
                            branch: WEBSITE_TEMPLATE_CONFIG.branch,
                            owner: vercelInput.owner,
                            repo: vercelInput.repo,
                        },
                        token,
                    );

                    this.logger.log(
                        `Successfully dispatched workflow "${workflowFile}" for ${vercelInput.owner}/${vercelInput.repo}`,
                    );
                    return true;
                } catch (error) {
                    this.logger.warn(
                        `Failed to dispatch workflow "${workflowFile}" for ${vercelInput.owner}/${vercelInput.repo}: ${error.message}`,
                    );
                    // Continue to try the next workflow file
                }
            }
            return false;
        };

        // First attempt
        const firstAttemptSuccess = await tryDispatch();
        if (firstAttemptSuccess) {
            return true;
        }

        // If dispatch fails, update the repository (push to main).
        // The workflow has a 'push' trigger on main, so pushing will trigger deployment automatically.
        try {
            this.logger.log(
                `Workflow dispatch failed. Updating repository for ${vercelInput.owner}/${vercelInput.repo} (push to main will trigger deployment via push trigger)`,
            );
            await this.websiteUpdateService.updateRepository(directory, user);

            // Create a trigger commit to ensure a new workflow run is triggered
            // (force pushing the same commits won't trigger a new workflow run)
            await this.createTriggerCommit(vercelInput, directory, user);

            // Give the provider a moment to register the push
            await this.delay(3000);

            // Try dispatch one more time in case the workflow was just indexed
            const retrySuccess = await tryDispatch();
            if (retrySuccess) {
                return true;
            }

            // Even if dispatch failed, the push to main should have triggered the workflow
            // via its 'push' trigger (on: push: branches: [main])
            this.logger.log(
                `Manual dispatch failed, but push to main completed. ` +
                    `Deployment should start via workflow push trigger for ${vercelInput.owner}/${vercelInput.repo}`,
            );
            return true; // Return true because push trigger should handle deployment
        } catch (error) {
            this.logger.error(
                `Failed to update repository for ${vercelInput.owner}/${vercelInput.repo}: ${error.message}`,
            );
            return false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Creates a small trigger commit to ensure the provider triggers a new workflow run.
     * This is needed because force-pushing the same commits won't trigger workflows.
     */
    private async createTriggerCommit(
        vercelInput: VercelInput,
        directory: Directory,
        user: User,
    ): Promise<void> {
        const directoryOwner = directory.user as User;

        try {
            const repoDir = await this.gitFacade.cloneOrPull(
                {
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                    branch: WEBSITE_TEMPLATE_CONFIG.branch,
                    committer: user.asCommitter(),
                },
                { userId: directoryOwner.id, providerId: directory.repoProvider },
            );

            // Create/update a deployment trigger file
            const triggerFile = `${repoDir}/.deployment-trigger`;
            const fs = await import('node:fs/promises');
            await fs.writeFile(
                triggerFile,
                `Deployment triggered at ${new Date().toISOString()}\n`,
            );

            await this.gitFacade.add(directory.repoProvider, repoDir, '.deployment-trigger');
            await this.gitFacade.commit(
                directory.repoProvider,
                repoDir,
                `chore: trigger deployment\n\nTriggered by Ever Works platform`,
                user.asCommitter(),
            );
            await this.gitFacade.push(
                { dir: repoDir },
                { userId: directoryOwner.id, providerId: directory.repoProvider },
            );

            this.logger.log(
                `Created trigger commit for ${vercelInput.owner}/${vercelInput.repo} to initiate workflow`,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to create trigger commit for ${vercelInput.owner}/${vercelInput.repo}: ${error.message}`,
            );
            // Don't throw - the main push might have triggered the workflow already
        }
    }

    // GitHub Actions operations - these are provider-specific
    // In the future, this could be abstracted to support GitLab CI, etc.

    private getGitHubPlugin(): any {
        const registered = this.pluginRegistry.get('github');
        if (!registered || registered.state !== 'enabled') {
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

    private async getActionSecret(
        _owner: string,
        _repo: string,
        _secretName: string,
        _token: string,
    ): Promise<any> {
        // GitHub doesn't expose getActionSecret in the plugin yet
        return null;
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
