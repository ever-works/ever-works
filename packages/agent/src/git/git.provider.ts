import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';
import { slugifyText } from '../items-generator/utils/text.utils';
import { Logger } from '@nestjs/common';
import { config } from '@src/config';

/*
    'oauth2'         - GitLab
    'x-access-token' - GitHub
*/
export interface IGitAuth {
    username: 'x-access-token' | 'oauth2';
    password: string;
}

export interface ICommitter {
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
    async cloneOrPull({
        owner,
        repo,
        token,
        committer,
        autoSwitchToMainBranch = true,
        branch,
    }: {
        owner: string;
        repo: string;
        token: string;
        committer: ICommitter;
        autoSwitchToMainBranch?: boolean;
        branch?: string;
    }): Promise<string> {
        const dir = this.getDir(owner, repo);
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);

        if (autoSwitchToMainBranch) {
            // Switch to main branch if we're on a different branch
            await this.switchToMainBranch(dir).catch(() => null);
        }

        if (await this.directoryExists(dir)) {
            try {
                await this.pull(dir, token, committer);
                return dir;
            } catch (error) {
                this.logger?.warn(
                    `Failed to pull ${dir}, removing directory and cloning again – ${error.message}`,
                );
                await this.removeDirSafe(dir);
            }
        }

        await fs.promises.mkdir(dir, { recursive: true });

        await git.clone({
            onAuth: () => auth,
            fs,
            http,
            dir,
            url,
            ref: branch,
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
        committer.name = committer.name || config.git.getName();
        committer.email = committer.email || config.git.getEmail();

        return committer;
    }

    /**
     * Add files to the git index (except removed files)
     *
     * @param dir
     * @param paths
     */
    add(dir: string, paths: string | string[]) {
        return git.add({
            fs,
            filepath: paths,
            dir,
        });
    }

    /**
     * Add all files to the git index, including removed files
     *
     * @param dir
     */
    async addAll(dir: string) {
        // Get the status of all files
        const statusMatrix = await git.statusMatrix({
            fs,
            dir,
        });

        for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
            // File was deleted (exists in HEAD but not in workdir)
            if (headStatus === 1 && workdirStatus === 0) {
                await git.remove({
                    fs,
                    dir,
                    filepath,
                });
            }
            // File was added or modified
            else if (
                workdirStatus !== 0 &&
                (headStatus !== workdirStatus || stageStatus !== workdirStatus)
            ) {
                await git.add({
                    fs,
                    dir,
                    filepath,
                });
            }
        }
    }

    removeDir(owner: string, repo: string) {
        return this.removeDirSafe(this.getDir(owner, repo));
    }

    private async removeDirSafe(dir: string) {
        const attempts = 3;
        for (let i = 0; i < attempts; i++) {
            try {
                await fs.promises.rm(dir, { recursive: true, force: true });
                return;
            } catch (error: any) {
                if (error?.code === 'ENOTEMPTY') {
                    // Attempt to remove .git first, then retry
                    await fs.promises
                        .rm(path.join(dir, '.git'), { recursive: true, force: true })
                        .catch(() => null);
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    continue;
                }
                throw error;
            }
        }
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

    status(dir: string) {
        return git.statusMatrix({ fs, dir });
    }

    async push(dir: string, token: string, force: boolean = false, maxRetries: number = 3) {
        if (!token) {
            throw new Error('Git token is required for push operation');
        }

        const auth = this.getAuth(token);
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await git.push({
                    onAuth: () => auth,
                    fs,
                    http,
                    dir,
                    force,
                });
            } catch (error: any) {
                lastError = error;
                const errorMessage = error?.message || '';

                // Check if this is a retryable error (ref lock, network issues)
                const isRetryable =
                    errorMessage.includes('cannot lock ref') ||
                    errorMessage.includes('failed to lock') ||
                    errorMessage.includes('ETIMEDOUT') ||
                    errorMessage.includes('ECONNRESET');

                if (!isRetryable || attempt === maxRetries) {
                    throw error;
                }

                this.logger?.warn(
                    `Push attempt ${attempt}/${maxRetries} failed: ${errorMessage}. Retrying...`,
                );

                // Exponential backoff: 1s, 2s, 4s
                await new Promise((resolve) =>
                    setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
                );
            }
        }

        throw lastError;
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
     * Renames a local branch from oldName to newName
     * Creates a new branch with the new name at the same commit, switches to it, and deletes the old branch
     */
    async renameBranch(dir: string, oldName: string, newName: string): Promise<void> {
        try {
            const branches = await git.listBranches({ fs, dir });

            if (!branches.includes(oldName)) {
                throw new Error(`Branch '${oldName}' does not exist`);
            }

            if (branches.includes(newName)) {
                // If newName already exists, just checkout to it and delete oldName if different
                if (oldName !== newName) {
                    await git.checkout({ fs, dir, ref: newName });
                    await git.deleteBranch({ fs, dir, ref: oldName });
                }
                return;
            }

            // Get the commit SHA of the old branch
            const commitSha = await git.resolveRef({ fs, dir, ref: oldName });

            // Create new branch at the same commit
            await git.branch({ fs, dir, ref: newName, object: commitSha });

            // Switch to the new branch
            await git.checkout({ fs, dir, ref: newName });

            // Delete the old branch
            await git.deleteBranch({ fs, dir, ref: oldName });
        } catch (error) {
            throw new Error(
                `Failed to rename branch from '${oldName}' to '${newName}': ${error.message}`,
            );
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

    /** Clone a specific branch to a unique temp directory */
    async cloneBranch(params: {
        owner: string;
        repo: string;
        branch: string;
        token: string;
    }): Promise<string> {
        const { owner, repo, branch, token } = params;
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);

        const uniqueName = `${repo}-${branch}-${Date.now()}`;
        const dir = path.join(os.tmpdir(), 'ever-works-repos', uniqueName);

        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.mkdir(dir, { recursive: true });

        await git.clone({
            fs,
            http,
            dir,
            url,
            ref: branch,
            singleBranch: true,
            onAuth: () => auth,
        });

        return dir;
    }
}
