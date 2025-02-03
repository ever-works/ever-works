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
        await this.githubService.setActionVariable({
            key: 'DEPLOY_PROVIDER',
            value: this.PROVIDER_ID,
            owner,
            repo,
        }, token);

        const publicKey = await this.githubService.repositoryPublickey(owner, repo, token);
        await Promise.all([
            this.githubService.setActionSecret({
                key: 'DATA_REPOSITORY',
                value: `${directory.slug}-data`,
                owner,
                repo,
            }, publicKey, token),
            this.githubService.setActionSecret({
                key: 'VERCEL_TOKEN',
                value: data.token,
                owner,
                repo,
            }, publicKey, token)
        ]);

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
