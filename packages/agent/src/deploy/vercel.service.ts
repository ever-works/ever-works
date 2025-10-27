import { Injectable } from '@nestjs/common';
import { DeployProvider, VercelInput } from './deploy.types';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WebsiteUpdateService } from '../website-generator/website-update.service';

@Injectable()
export class VercelService {
    private readonly PROVIDER_ID: DeployProvider = 'vercel';

    constructor(
        private readonly githubService: GithubService,
        private readonly websiteUpdateService: WebsiteUpdateService,
    ) {}

    async deploy(vercelInput: VercelInput, directory: Directory, user: User) {
        const token = user.getGitToken();
        const publicKey = await this.githubService.repositoryPublickey(
            vercelInput.owner,
            vercelInput.repo,
            token,
        );

        await this.githubService.enableWorkflows({
            owner: vercelInput.owner,
            repo: vercelInput.repo,
            token,
            withDelay: false,
        });

        const promises = [
            this.githubService.setActionVariable(
                {
                    key: 'DEPLOY_PROVIDER',
                    value: this.PROVIDER_ID,
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                },
                token,
            ),
            this.githubService.setActionSecret(
                {
                    key: 'DATA_REPOSITORY',
                    value: `${directory.slug}-data`,
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                },
                publicKey,
                token,
            ),
            this.githubService.setActionSecret(
                {
                    key: 'VERCEL_TOKEN',
                    value: vercelInput.data.vercelToken,
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                },
                publicKey,
                token,
            ),
        ];

        if (vercelInput.data.vercelTeamId) {
            promises.push(
                this.githubService.setActionSecret(
                    {
                        key: 'VERCEL_ORG',
                        value: vercelInput.data.vercelTeamId,
                        owner: vercelInput.owner,
                        repo: vercelInput.repo,
                    },
                    publicKey,
                    token,
                ),
            );
        }

        if (vercelInput.data.ghToken) {
            promises.push(
                this.githubService.setActionSecret(
                    {
                        key: 'GH_TOKEN',
                        value: vercelInput.data.ghToken,
                        owner: vercelInput.owner,
                        repo: vercelInput.repo,
                    },
                    publicKey,
                    token,
                ),
            );
        }

        await Promise.all(promises);

        const dispatchDeployAction = () => {
            return this.githubService.dispatchAction(
                {
                    workflow: 'deploy_vercel.yaml',
                    inputs: {
                        environment: 'production',
                    },
                    branch: 'develop', // for now
                    owner: vercelInput.owner,
                    repo: vercelInput.repo,
                },
                token,
            );
        };

        const tries = [
            dispatchDeployAction,
            async () => {
                console.log('Trying to update repository instead');
                await this.websiteUpdateService.updateRepository(directory, user);
                // add delay to make sure the update is done
                await new Promise((resolve) => setTimeout(resolve, 5000));
                await dispatchDeployAction();
            },
        ];

        for (const tryFn of tries) {
            try {
                await tryFn();
                return true;
            } catch (error) {
                console.warn('Failed to deploy:', error);
            }
        }

        return false;
    }

    async getAccountTeams(vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);
        const teamsPromise = await vercel.teams.getTeams({});

        return teamsPromise.teams;
    }

    async validateToken(vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);
        try {
            return vercel.user.getAuthUser();
        } catch (error) {
            return false;
        }
    }

    async createVercelSDK(token: string) {
        const { Vercel } = await import('@vercel/sdk');
        return new Vercel({ bearerToken: token });
    }
}
