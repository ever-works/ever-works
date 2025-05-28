import { Injectable, Logger } from '@nestjs/common';
import { Octokit, RequestError } from 'octokit';
import { GitProvider, IGitAuth } from './git.provider';
import * as sodium from 'libsodium-wrappers';

@Injectable()
export class GithubService extends GitProvider {
    protected readonly logger = new Logger(GithubService.name);

    getAuth(token: string): IGitAuth {
        return { username: 'x-access-token', password: token };
    }

    getURL(owner: string, repo: string) {
        return `https://github.com/${owner}/${repo}`;
    }

    private async getRepository(owner: string, repo: string, token: string) {
        const octokit = new Octokit({ auth: token });
        try {
            const data = await octokit.rest.repos.get({
                owner,
                repo,
            });
            return data;
        } catch (err) {
            if (err instanceof RequestError && err.status === 404) {
                return undefined;
            }
            throw err;
        }
    }

    async createEmptyRepoAsOrg(org: string, repo: string, description: string, token: string) {
        const octokit = new Octokit({ auth: token });

        // Check if repository already exists
        const existingRepository = await this.getRepository(org, repo, token);
        if (existingRepository) {
            return existingRepository.data;
        }

        const res = await octokit.rest.repos.createInOrg({
            org,
            name: repo,
            description,
            private: true, // for now
        });

        return res.data;
    }

    async createEmptyRepo(repo: string, description: string, token: string) {
        const octokit = new Octokit({ auth: token });

        // Get authenticated user to check repository existence
        const { data: user } = await octokit.rest.users.getAuthenticated();

        // Check if repository already exists
        const existingRepository = await this.getRepository(user.login, repo, token);
        if (existingRepository) {
            return existingRepository.data;
        }

        const res = await octokit.rest.repos.createForAuthenticatedUser({
            name: repo,
            description,
            private: true, // for now
        });

        return res.data;
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
        const duplicated = await this.createEmptyRepo(name, '', token);
        const origin = duplicated.clone_url;

        const originalDir = await this.cloneOrPull(owner, repo, token);
        await this.remoteRemove(originalDir, 'origin');
        await this.remoteAdd(originalDir, 'origin', origin);
        await this.push(originalDir, token);

        return originalDir;
    }

    async duplicateAsOrg(owner: string, repo: string, org: string, name: string, token: string) {
        const duplicated = await this.createEmptyRepoAsOrg(org, name, '', token);
        const origin = duplicated.clone_url;

        const originalDir = await this.cloneOrPull(owner, repo, token);
        await this.remoteRemove(originalDir, 'origin');
        await this.remoteAdd(originalDir, 'origin', origin);
        await this.push(originalDir, token);

        return originalDir;
    }

    async repositoryPublickey(owner: string, repo: string, token: string) {
        const octokit = new Octokit({
            auth: token,
        });

        const result = await octokit.rest.actions.getRepoPublicKey({
            owner,
            repo,
        });

        return result.data;
    }

    async setActionSecret(
        data: { key: string; value: string; repo: string; owner: string },
        publicKey: { key_id: string; key: string },
        token: string,
    ) {
        const octokit = new Octokit({
            auth: token,
        });

        await sodium.ready;
        const binkey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
        const binsec = sodium.from_string(data.value);
        const encryptedBytes = sodium.crypto_box_seal(binsec, binkey);

        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner: data.owner,
            repo: data.repo,
            secret_name: data.key,
            encrypted_value: sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL),
            key_id: publicKey.key_id,
        });
    }

    async setActionVariable(
        data: { key: string; value: string; repo: string; owner: string },
        token: string,
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

    async getActionWorkflows(owner: string, repo: string, token: string) {
        const octokit = new Octokit({ auth: token });

        const { data } = await octokit.rest.actions.listRepoWorkflows({
            owner,
            repo,
        });

        return data;
    }

    async dispatchAction(
        data: {
            workflow: string;
            inputs?: { [x: string]: unknown };
            branch: string;
            owner: string;
            repo: string;
        },
        token: string,
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

    /**
     * Creates a pull request from source branch to target branch
     */
    async createPR(
        params: {
            owner: string;
            repo: string;
            head: string;
            base: string;
            title: string;
            body?: string;
            draft?: boolean;
        },
        token: string,
    ) {
        const octokit = new Octokit({ auth: token });

        try {
            const { data } = await octokit.rest.pulls.create({
                owner: params.owner,
                repo: params.repo,
                title: params.title,
                head: params.head,
                base: params.base,
                body: params.body || `Automated pull request from ${params.head} to ${params.base}`,
                draft: params.draft || false,
            });

            return data;
        } catch (err) {
            this.logger.error(
                `Failed to create PR from ${params.head} to ${params.base}`,
                err.message,
            );
            throw err;
        }
    }
}
