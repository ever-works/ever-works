import { Injectable, Logger } from '@nestjs/common';
import { Octokit, RequestError } from 'octokit';
import { GitService, IGitAuth } from './git.service';
import { GitProvider } from './git.provider';
import * as sodium from 'libsodium-wrappers';

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

    async fork(owner: string, repo: string, name: string, token: string) {
        const octokit = new Octokit({ auth: token });
        try {
            const { data } = await octokit.rest.repos.createFork({
                owner,
                repo,
                name,
            });
            return data;
        } catch (err) {
            this.logger.error('Failed to fork GitHub repository', err.message);
            throw err;
        }
    }

    async duplicate(owner: string, repo: string, name: string, token: string) {
        const duplicated = await this.createEmptyRepository(name, '', token);
        const origin = duplicated.clone_url;

        const originalDir = await this.clone(owner, repo, token);
        await this.gitService.remoteRemove(originalDir, 'origin');
        await this.gitService.remoteAdd(originalDir, 'origin', origin);
        await this.push(originalDir, token);
    }

    async repositoryPublickey(owner: string, repo: string, token: string) {
        const octokit = new Octokit({
            auth: token,
        });

        const result = await octokit.rest.actions.getRepoPublicKey({
            owner,
            repo
        });

        return result.data;
    }

    async setActionSecret(
        data: { key: string, value: string, repo: string, owner: string },
        publicKey: { key_id: string, key: string },
        token: string
    ) {
        const octokit = new Octokit({
            auth: token,
        });

        await sodium.ready
        const binkey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)
        const binsec = sodium.from_string(data.value);
        const encryptedBytes = sodium.crypto_box_seal(
            binsec,
            binkey,
        );

        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner: data.owner,
            repo: data.repo,
            secret_name: data.key,
            encrypted_value: sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL),
            key_id: publicKey.key_id,
        });
    }

    async setActionVariable(
        data: { key: string, value: string, repo: string, owner: string },
        token: string
    ) {
        const octokit = new Octokit({
            auth: token,
        });

        try {
            await octokit.rest.actions.updateRepoVariable({
                owner: data.owner,
                repo: data.repo,
                name: data.key,
                value: data.value,
            });
        } catch (err) {
            if (err instanceof RequestError && err.status === 404) {
                await octokit.rest.actions.createRepoVariable({
                    owner: data.owner,
                    repo: data.repo,
                    name: data.key,
                    value: data.value,
                });
            } else {
                throw err;
            }
        }
    }

    async dispatchAction(
        data: {  workflow: string, inputs?: { [x: string]: unknown }, branch: string, owner: string, repo: string, },
        token: string
    ) {
        const octokit = new Octokit({
            auth: token,
        });

        await octokit.rest.actions.createWorkflowDispatch({
            workflow_id: data.workflow,
            inputs: data.inputs,
            ref: data.branch,
            owner: data.owner,
            repo: data.repo,
        });
    }
}
