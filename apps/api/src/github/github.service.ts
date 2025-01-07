import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from 'octokit';

@Injectable()
export class GithubService {
    private readonly logger = new Logger('GithubService');

    async createEmptyRepository(repo: string, description: string, owner: { apiKey: string }) {
        const octokit = new Octokit({ auth: owner.apiKey });
        
        try {
            const res = await octokit.rest.repos.createForAuthenticatedUser({
                name: repo,
                description,
                private: true, // for now, I think it can be configurable
            });

            return res.data;
        } catch (err) {
            const msg = 'Failed to create empty repository on GitHub';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }

    async commitFile(repo: string, filename: string, content: string, message: string, owner: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: owner.apiKey });

        try {
            const { data } = await octokit.rest.repos.createOrUpdateFileContents({
                owner: owner.name,
                repo,
                content: Buffer.from(content).toString('base64'),
                message,
                path: filename,
            });

            return data;
        } catch (err) {
            const msg = 'Failed to commit file to GitHub repository';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }
}
