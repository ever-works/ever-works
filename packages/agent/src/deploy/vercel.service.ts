import { Injectable } from '@nestjs/common';
import { DeployProvider, IDeployService, VercelInput } from './deploy.types';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { WebsiteUpdateService } from '../website-generator/website-update.service';

@Injectable()
export class VercelService implements IDeployService {
    private readonly PROVIDER_ID: DeployProvider = 'vercel';

    constructor(
        private readonly githubService: GithubService,
        private readonly websiteUpdateService: WebsiteUpdateService,
    ) {}

    async deploy({ data, owner, repo }: VercelInput, directory: Directory, user: User) {
        const token = user.getGitToken();
        const publicKey = await this.githubService.repositoryPublickey(owner, repo, token);

        const promises = [
            this.githubService.setActionVariable(
                {
                    key: 'DEPLOY_PROVIDER',
                    value: this.PROVIDER_ID,
                    owner,
                    repo,
                },
                token,
            ),
            this.githubService.setActionSecret(
                {
                    key: 'DATA_REPOSITORY',
                    value: `${directory.slug}-data`,
                    owner,
                    repo,
                },
                publicKey,
                token,
            ),
            this.githubService.setActionSecret(
                {
                    key: 'VERCEL_TOKEN',
                    value: data.vercelToken,
                    owner,
                    repo,
                },
                publicKey,
                token,
            ),
        ];

        if (data.ghToken) {
            promises.push(
                this.githubService.setActionSecret(
                    {
                        key: 'GH_TOKEN',
                        value: data.ghToken,
                        owner,
                        repo,
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
                    owner,
                    repo,
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
                return;
            } catch (error) {
                console.warn('Failed to deploy:', error);
            }
        }
    }
}
