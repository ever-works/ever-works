import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from 'octokit';

@Injectable()
export class GithubService {
    private readonly logger = new Logger('GithubService');

    async createEmptyRepository(repo: string, description: string, user: { apiKey: string }) {
        const octokit = new Octokit({ auth: user.apiKey });
        try {
            const res = await octokit.rest.repos.createForAuthenticatedUser({
                name: repo,
                description,
                private: true,
            });

            return res.data;
        } catch (err) {
            const msg = 'Failed to create empty repository on GitHub';
            this.logger.error(msg, err.message);
            throw err;
        }
    }

    async createFile(repo: string, filepath: string, content: string, message: string, user: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: user.apiKey });
        try {
            const { data } = await octokit.rest.repos.createOrUpdateFileContents({
                owner: user.name,
                repo,
                content: Buffer.from(content).toString('base64'),
                message,
                path: filepath,
            });

            return data;
        } catch (err) {
            const msg = 'Failed to commit file to GitHub repository';
            this.logger.error(msg, err.message);
            throw err;
        }
    }

    async updateFile(repo: string, filepath: string, content: string, message: string, user: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: user.apiKey });
        try {
            const { data: meta } = await octokit.rest.repos.getContent({
                owner: user.name,
                repo,
                path: filepath,
            });

            if (Array.isArray(meta)) {
                throw new Error('Unexpected list of files');
            }

            const { data } = await octokit.rest.repos.createOrUpdateFileContents({
                owner: user.name,
                repo,
                content: Buffer.from(content).toString('base64'),
                message,
                path: filepath,
                sha: meta.sha,
            });

            return data;
        } catch (err) {
            const msg = 'Failed to commit file to GitHub repository';
            this.logger.error(msg, err.message);
            throw err;
        }
    }

    /* should apply to both dirs and files */
    async getContent(repo: string, path: string, user: { name: string, apiKey: string }) {
        const octokit = new Octokit({ auth: user.apiKey });
        try {
            const { data } = await octokit.rest.repos.getContent({
                owner: user.name,
                repo,
                path,
            });

            return data;
        } catch (err) {
            const msg = 'Failed to read content from GitHub repository';
            this.logger.error(msg, err.message);
            throw err;
        }
    }

    async getUser(apiKey: string) {
        const octokit = new Octokit({ auth: apiKey });

        try {
            const { data: user } = await octokit.rest.users.getAuthenticated();
            return user;
        } catch (err) {
            this.logger.error('Failed to fetch authenticated GitHub user', err.message);
            throw err;
        }
    }

    async forkRepo(owner: string, repo: string, user: { apiKey: string }) {
        const octokit = new Octokit({ auth: user.apiKey });
        try {
            const { data } = await octokit.rest.repos.createFork({
                owner,
                repo,
            });
            return data;
        } catch (err) {
            this.logger.error('Failed to fork GitHub repository', err.message);
            throw err;
        }
    }
}
