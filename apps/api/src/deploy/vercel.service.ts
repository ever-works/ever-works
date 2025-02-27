import { Injectable } from "@nestjs/common";
import { DeployProvider, IDeployService, VercelInput } from "./deploy.types";
import { GithubService } from "../git/github.service";
import { Directory } from "../entities/directory.entity";
import { User } from "../entities/user.entity";

@Injectable()
export class VercelService implements IDeployService {
    private readonly PROVIDER_ID: DeployProvider = 'vercel';

    constructor(private readonly githubService: GithubService) {}

    async deploy({ data, owner, repo }: VercelInput, directory: Directory, user: User) {
        const token = user.getGitToken();
        const publicKey = await this.githubService.repositoryPublickey(owner, repo, token);

        const promises = [
            this.githubService.setActionVariable({
                key: 'DEPLOY_PROVIDER',
                value: this.PROVIDER_ID,
                owner,
                repo,
            }, token),
            this.githubService.setActionSecret({
                key: 'DATA_REPOSITORY',
                value: `${directory.slug}-data`,
                owner,
                repo,
            }, publicKey, token),
            this.githubService.setActionSecret({
                key: 'VERCEL_TOKEN',
                value: data.vercelToken,
                owner,
                repo,
            }, publicKey, token)
        ];

        if (data.ghToken) {
            promises.push(this.githubService.setActionSecret({
                key: 'GH_APIKEY',
                value: data.ghToken,
                owner,
                repo,
            }, publicKey, token));
        }

        await Promise.all(promises);

        await this.githubService.dispatchAction({
            workflow: 'deploy_vercel.yaml',
            inputs: {
                environment: 'production',
            },
            branch: 'develop',  // for now
            owner,
            repo,
        }, token);
    }
}
