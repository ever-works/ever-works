import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';
import { slugifyText } from '../items-generator/utils/text.utils';
import { Logger } from '@nestjs/common';

/*
    'oauth2'         - GitLab
    'x-access-token' - GitHub
*/
export interface IGitAuth {
    username: 'x-access-token' | 'oauth2';
    password: string;
}

interface ICommitter {
    name?: string;
    email?: string;
}

const DEFAULT_BRANCHES = ['main', 'master'] as const;

export abstract class GitProvider {
    protected abstract readonly logger: Logger;

    abstract getAuth(token: string): IGitAuth;

    abstract getURL(owner: string, repo: string): string;

    /**
     *  Clones or pulls repository to/from a persistent location using slugified name
     */
    async cloneOrPull(
        owner: string,
        repo: string,
        token: string,
        committer: ICommitter = {},
    ): Promise<string> {
        const dir = this.getDir(owner, repo);
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);

        if (await this.directoryExists(dir)) {
            try {
                await this.pull(dir, token, committer);
                return dir;
            } catch (error) {
                this.logger?.warn(
                    `Failed to pull ${dir}, removing directory and cloning again – ${error.message}`,
                );
                await fs.promises.rm(dir, { recursive: true, force: true });
            }
        }

        await fs.promises.mkdir(path.dirname(dir), { recursive: true });

        await git.clone({
            onAuth: () => auth,
            fs,
            http,
            dir,
            url,
            singleBranch: true,
        });

        return dir;
    }

    /* Checks if a directory exists */
    async directoryExists(dir: string): Promise<boolean> {
        try {
            const stat = await fs.promises.stat(dir);
            return stat.isDirectory();
        } catch (error) {
            return false;
        }
    }

    /* Pulls latest changes from remote repository */
    async pull(dir: string, token: string, committer: ICommitter = {}): Promise<void> {
        const auth = this.getAuth(token);
        committer = this.getCommitter(committer);

        await git.pull({
            onAuth: () => auth,
            fs,
            http,
            dir,
            author: committer,
            singleBranch: true,
        });
    }

    getCommitter(committer: ICommitter = {}): ICommitter {
        committer.email = committer.email || process.env.GIT_EMAIL;
        committer.name = committer.name || process.env.GIT_NAME;

        return committer;
    }

    add(dir: string, paths: string | string[]) {
        return git.add({
            fs,
            filepath: paths,
            dir,
        });
    }

    commit(dir: string, message: string, committer: ICommitter = {}) {
        committer = this.getCommitter(committer);

        return git.commit({
            fs,
            message,
            committer,
            author: committer,
            dir,
        });
    }

    remoteRemove(dir: string, remote: string) {
        return git.deleteRemote({ fs, dir, remote });
    }

    remoteAdd(dir: string, remote: string, url: string) {
        return git.addRemote({ fs, dir, remote, url });
    }

    push(dir: string, token: string) {
        const auth = this.getAuth(token);

        return git.push({
            onAuth: () => auth,
            fs,
            http,
            dir,
        });
    }

    /**
     * Returns the name of the main branch if it exists, otherwise returns null
     * Checks for default branches in the order defined in DEFAULT_BRANCHES
     */
    async getMainBranch(dir: string): Promise<string | null> {
        try {
            const branches = await git.listBranches({ fs, dir });

            for (const defaultBranch of DEFAULT_BRANCHES) {
                if (branches.includes(defaultBranch)) {
                    return defaultBranch;
                }
            }

            return null;
        } catch (error) {
            throw new Error(`Failed to get main branch: ${error.message}`);
        }
    }

    // get active branch
    async getActiveBranch(dir: string) {
        try {
            return await git.currentBranch({ fs, dir });
        } catch (error) {
            throw new Error(`Failed to get active branch: ${error.message}`);
        }
    }

    /**
     * Switches to main branch if current branch is not one of the default branches
     * Checks local branches and switches to the first available default branch found
     */
    async switchToMainBranch(dir: string): Promise<string | null> {
        try {
            const currentBranch = await git.currentBranch({ fs, dir });

            if (currentBranch && DEFAULT_BRANCHES.includes(currentBranch as any)) {
                return currentBranch;
            }

            const branches = await git.listBranches({ fs, dir });

            for (const defaultBranch of DEFAULT_BRANCHES) {
                if (branches.includes(defaultBranch)) {
                    // Switch to the default branch
                    await git.checkout({ fs, dir, ref: defaultBranch });
                    return defaultBranch;
                }
            }

            return null;
        } catch (error) {
            throw new Error(`Failed to switch to main branch: ${error.message}`);
        }
    }

    /**
     * Switch to a branch or create it if it doesn't exist (if create is true)
     */
    async switchToBranch(dir: string, branch: string, create: boolean = false) {
        try {
            const branches = await git.listBranches({ fs, dir });

            if (branches.includes(branch)) {
                await git.checkout({ fs, dir, ref: branch });
                return branch;
            }

            if (create) {
                await git.branch({ fs, dir, ref: branch });
                await git.checkout({ fs, dir, ref: branch });
                return branch;
            }

            throw new Error(`Branch ${branch} doesn't exist`);
        } catch (error) {
            throw new Error(`Failed to switch to branch: ${error.message}`);
        }
    }

    /**
     * Generates a random unique branch name and switches to it
     * Ensures the branch name doesn't conflict with existing branches
     */
    async createAndSwitchToRandomBranch(dir: string, prefix: string = 'feature'): Promise<string> {
        try {
            const existingBranches = await git.listBranches({ fs, dir });

            let branchName: string;
            let attempts = 0;
            const maxAttempts = 10;

            // Generate unique branch name
            do {
                const timestamp = Date.now();
                const randomSuffix = Math.random().toString(36).substring(2, 8);
                branchName = `${prefix}-${timestamp}-${randomSuffix}`;
                attempts++;

                if (attempts >= maxAttempts) {
                    throw new Error(
                        `Failed to generate unique branch name after ${maxAttempts} attempts`,
                    );
                }
            } while (existingBranches.includes(branchName));

            // Create and switch to the new branch
            await git.branch({ fs, dir, ref: branchName });
            await git.checkout({ fs, dir, ref: branchName });

            return branchName;
        } catch (error) {
            throw new Error(`Failed to create and switch to random branch: ${error.message}`);
        }
    }

    getDir(owner: string, repo: string) {
        return path.join(os.tmpdir(), 'ever-works-repos', slugifyText(`${owner}-${repo}`));
    }
}
