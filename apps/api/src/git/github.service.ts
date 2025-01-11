import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from 'octokit';
import { GitService, IGitAuth } from './git.service';
import { GitProvider } from './git.provider';

@Injectable()
export class GithubService extends GitProvider {
    private readonly logger = new Logger('GithubService');

    constructor(gitService: GitService) {
        super(gitService);
    }

    getAuth(token: string): IGitAuth {
        return { username: 'x-access-token', password: token };
    }

    getURL(owner: string, repo: string) {
        return `https://github.com/${owner}/${repo}`;
    }

    async createEmptyRepository(repo: string, description: string, token: string) {
        const octokit = new Octokit({ auth: token });
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

    async getUser(token: string) {
        const octokit = new Octokit({ auth: token });

        try {
            const { data: user } = await octokit.rest.users.getAuthenticated();
            return user;
        } catch (err) {
            this.logger.error('Failed to fetch authenticated GitHub user', err.message);
            throw err;
        }
    }

    async fork(owner: string, repo: string, token: string) {
        const octokit = new Octokit({ auth: token });
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
