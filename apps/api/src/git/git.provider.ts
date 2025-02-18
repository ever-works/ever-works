import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'isomorphic-git/http/node';
import { randomUUID } from 'crypto';
import git from 'isomorphic-git';

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

    /* Clones remote repository to temporary location and returns absolute path */
    async clone(owner: string, repo: string, token: string) {
        const dir = path.join(os.tmpdir(), randomUUID());
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);
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

    add(dir: string, paths: string | string[]) {
        return git.add({
            fs,
            filepath: paths,
            dir,
        })
    }

    commit(dir: string, message: string, committer: ICommitter = {}) {
        committer.email = committer.email || process.env.GIT_EMAIL;
        committer.name = committer.name || process.env.GIT_NAME

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
