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
            });

            return res.data;
        } catch (err) {
            const msg = 'Failed to create empty repository on GitHub';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }

    async createFile(repo: string, filepath: string, content: string, message: string, owner: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: owner.apiKey });

        try {
            const { data } = await octokit.rest.repos.createOrUpdateFileContents({
                owner: owner.name,
                repo,
                content: Buffer.from(content).toString('base64'),
                message,
                path: filepath,
            });

            return data;
        } catch (err) {
            const msg = 'Failed to commit file to GitHub repository';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }

    /* should apply to both dirs and files */
    async getContent(repo: string, path: string, owner: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: owner.apiKey });
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: owner.name,
                repo: repo,
                path: path,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            return data;
        } catch (err) {
            const msg = 'Failed to read content from GitHub repository';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }

    async getUser(apiKey: string) {
        const octokit = new Octokit({ auth: apiKey });

        try {
            const { data: user } = await octokit.rest.users.getAuthenticated();
            return user;
        } catch (err) {
            const msg = 'Failed to fetch authenticated GitHub user';
            this.logger.error(msg, err.message);
            throw new Error(msg);
        }
    }
}
