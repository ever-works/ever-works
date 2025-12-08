import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DeployProvider, VercelInput } from './deploy.types';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WebsiteUpdateService } from '../website-generator/website-update.service';

interface RepoContext {
    owner: string;
    repo: string;
    token: string;
    publicKey: { key_id: string; key: string };
}

@Injectable()
export class VercelService {
    private readonly PROVIDER_ID: DeployProvider = 'vercel';
    private readonly CRON_SECRET_LENGTH = 32;

    constructor(
        private readonly githubService: GithubService,
        private readonly websiteUpdateService: WebsiteUpdateService,
    ) {}

    async deploy(vercelInput: VercelInput, directory: Directory, user: User) {
        const token = user.getGitToken();
        const ctx = await this.createRepoContext(vercelInput.owner, vercelInput.repo, token);

        await this.githubService.enableWorkflows({
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

    private async createRepoContext(
        owner: string,
        repo: string,
        token: string,
    ): Promise<RepoContext> {
        const publicKey = await this.githubService.repositoryPublickey(owner, repo, token);
        return { owner, repo, token, publicKey };
    }

    private setSecret(ctx: RepoContext, key: string, value: string) {
        return this.githubService.setActionSecret(
            { key, value, owner: ctx.owner, repo: ctx.repo },
            ctx.publicKey,
            ctx.token,
        );
    }

    private setVariable(ctx: RepoContext, key: string, value: string) {
        return this.githubService.setActionVariable(
            { key, value, owner: ctx.owner, repo: ctx.repo },
            ctx.token,
        );
    }

    private async setRequiredSecrets(
        ctx: RepoContext,
        vercelInput: VercelInput,
        directory: Directory,
    ) {
        await Promise.all([
            this.setVariable(ctx, 'DEPLOY_PROVIDER', this.PROVIDER_ID),
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
        const existingSecret = await this.githubService.getActionSecret(
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
        const dispatchAction = () =>
            this.githubService.dispatchAction(
                {
                    workflow: 'deploy_vercel.yaml',
                    inputs: { environment: 'production' },
                    branch: 'main',
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                },
                token,
            );

        try {
            await dispatchAction();
            return true;
        } catch {
            try {
                await this.websiteUpdateService.updateRepository(directory, user);
                await this.delay(5000);
                await dispatchAction();
                return true;
            } catch {
                return false;
            }
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
