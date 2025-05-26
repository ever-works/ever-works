import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';
import { slugifyText } from '../items-generator/utils/text.utils';

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

export abstract class GitProvider {
    abstract getAuth(token: string): IGitAuth;

    abstract getURL(owner: string, repo: string): string;

    /**
     *  Clones or pulls repository to/from a persistent location using slugified name
     */
    async cloneOrPull(owner: string, repo: string, token: string): Promise<string> {
        const slugifiedName = slugifyText(`${owner}-${repo}`);
        const dir = path.join(os.tmpdir(), 'ever-works-repos', slugifiedName);
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);

        // Check if directory already exists
        if (await this.directoryExists(dir)) {
            try {
                // Try to pull latest changes
                await this.pull(dir, token);
                return dir;
            } catch (error) {
                // If pull fails, remove directory and clone fresh
                await fs.promises.rm(dir, { recursive: true, force: true });
            }
        }

        // Ensure parent directory exists
        await fs.promises.mkdir(path.dirname(dir), { recursive: true });

        // Clone repository
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
    async pull(dir: string, token: string): Promise<void> {
        const auth = this.getAuth(token);
        await git.pull({
            onAuth: () => auth,
            fs,
            http,
            dir,
            singleBranch: true,
        });
    }

    add(dir: string, paths: string | string[]) {
        return git.add({
            fs,
            filepath: paths,
            dir,
        });
    }

    commit(dir: string, message: string, committer: ICommitter = {}) {
        committer.email = committer.email || process.env.GIT_EMAIL;
        committer.name = committer.name || process.env.GIT_NAME;

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
}
