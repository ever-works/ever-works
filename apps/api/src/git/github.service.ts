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

    async fork(
        {
            owner,
            repo,
            name,
            isOrganization,
        }: {
            owner: string;
            repo: string;
            name: string;
            isOrganization?: boolean;
        },
        token: string,
    ) {
        const octokit = new Octokit({ auth: token });
        let forkDetails;

        // Check if repository with the target name already exists for the target owner
        const existingRepository = await this.getRepository(owner, name, token);
        if (existingRepository) {
            return existingRepository.data;
        }

        try {
            const response = await octokit.rest.repos.createFork({
                owner,
                repo,
                name,
                organization: isOrganization ? name : undefined,
            });

            forkDetails = response.data;

            this.logger.log(
                `Fork initiated for ${owner}/${repo} as ${forkDetails.owner.login}/${forkDetails.name}. URL: ${forkDetails.html_url}. Waiting for availability.`,
            );
        } catch (err) {
            if (err instanceof RequestError) {
                this.logger.error(
                    `Failed to initiate fork of ${owner}/${repo} to ${name}. Status: ${err.status}`,
                    err.message,
                );
            } else {
                this.logger.error(
                    `Failed to initiate fork of ${owner}/${repo} to ${name}.`,
                    err.message,
                );
            }
            throw err;
        }

        const newRepoOwner = forkDetails.owner.login;
        const newRepoName = forkDetails.name;

        const REPO_CHECK_INTERVAL_MS = 5000;
        const MAX_REPO_CHECK_ATTEMPTS = 24;

        for (let attempt = 1; attempt <= MAX_REPO_CHECK_ATTEMPTS; attempt++) {
            this.logger.log(
                `Checking fork status for ${newRepoOwner}/${newRepoName}, attempt ${attempt}/${MAX_REPO_CHECK_ATTEMPTS}`,
            );
            try {
                // Attempt to get the repository details
                // A successful call means the repository is now available
                await octokit.rest.repos.get({
                    owner: newRepoOwner,
                    repo: newRepoName,
                });

                this.logger.log(`Fork ${newRepoOwner}/${newRepoName} is available.`);

                return null;
            } catch (err) {
                if (err instanceof RequestError && err.status === 404) {
                    if (attempt < MAX_REPO_CHECK_ATTEMPTS) {
                        await new Promise((resolve) => setTimeout(resolve, REPO_CHECK_INTERVAL_MS));
                    } else {
                        throw new Error(
                            `Fork ${newRepoOwner}/${newRepoName} did not become available after ${MAX_REPO_CHECK_ATTEMPTS} attempts (${(MAX_REPO_CHECK_ATTEMPTS * REPO_CHECK_INTERVAL_MS) / 1000}s).`,
                        );
                    }
                } else {
                    this.logger.error(
                        `Error checking fork status for ${newRepoOwner}/${newRepoName}: ${err.message}`,
                        err.stack,
                    );

                    throw err;
                }
            }
        }

        throw new Error(`Fork ${newRepoOwner}/${newRepoName} timed out after maximum attempts.`);
    }

    async duplicate(owner: string, repo: string, name: string, token: string) {
        const duplicated = await this.createEmptyRepo(name, '', token);
        const origin = duplicated.clone_url;

        this.logger.log(`Duplicated ${owner}/${repo} to ${duplicated.owner.login}/${name}`);

        const originalDir = await this.cloneOrPull(owner, repo, token);
        await this.remoteRemove(originalDir, 'origin');
        await this.remoteAdd(originalDir, 'origin', origin);
        await this.push(originalDir, token);

        return originalDir;
    }

    async duplicateAsOrg(owner: string, repo: string, org: string, name: string, token: string) {
        const duplicated = await this.createEmptyRepoAsOrg(org, name, '', token);
        const origin = duplicated.clone_url;

        this.logger.log(`Duplicated ${owner}/${repo} to ${duplicated.owner.login}/${name}`);

        const originalDir = await this.cloneOrPull(owner, repo, token);
        await this.remoteRemove(originalDir, 'origin');
        await this.remoteAdd(originalDir, 'origin', origin);
        await this.push(originalDir, token);

        return originalDir;
    }

    async createRepoFromTemplate(
        templateOwner: string,
        templateRepo: string,
        targetOwner: string,
        newName: string,
        token: string,
        description?: string,
        isPrivate: boolean = true,
    ) {
        const octokit = new Octokit({ auth: token });
        try {
            // Check if the target repository already exists
            const existingRepository = await this.getRepository(targetOwner, newName, token);
            if (existingRepository) {
                return existingRepository.data;
            }

            this.logger.log(
                `Creating repository ${targetOwner}/${newName} from template ${templateOwner}/${templateRepo}...`,
            );

            await octokit.rest.repos.createUsingTemplate({
                template_owner: templateOwner,
                template_repo: templateRepo,
                owner: targetOwner,
                name: newName,
                description:
                    description ||
                    `Repository created from template ${templateOwner}/${templateRepo}`,
                private: isPrivate,
            });
        } catch (err) {
            this.logger.error(
                `Failed to create repository ${targetOwner}/${newName} from template ${templateOwner}/${templateRepo}.`,
                err.message,
            );
            throw err;
        }

        return null;
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
