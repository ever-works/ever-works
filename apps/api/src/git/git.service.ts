import git from 'isomorphic-git';
import * as http from 'isomorphic-git/http/node';
import * as fs from 'fs';
import { Injectable } from "@nestjs/common";

/*
    'oauth2'         - GitLab
    'x-access-token' - GitHub
*/
export interface IGitAuth {
    username: 'x-access-token' | 'oauth2';
    password: string;
}

@Injectable()
export class GitService {
    clone(url: string, dir: string, auth: IGitAuth) {
        return git.clone({
            onAuth: () => auth,
            fs,
            http,
            dir,
            url,
            singleBranch: true,
        });
    }

    add(dir: string, paths: string | string[]) {
        return git.add({
            fs,
            filepath: paths,
            dir,
        })
    }

    commit(dir: string, message: string) {
        return git.commit({
            fs,
            message,
            committer: { name: process.env.GIT_NAME, email: process.env.GIT_EMAIL },
            author: { name: process.env.GIT_NAME, email: process.env.GIT_EMAIL },
            dir,
        });
    }

    remoteRemove(dir: string, remote: string) {
        return git.deleteRemote({ fs, dir, remote });
    }

    remoteAdd(dir: string, remote: string, url: string) {
        return git.addRemote({ fs, dir, remote, url });
    }

    push(dir: string, auth: IGitAuth) {
        return git.push({
            onAuth: () => auth, 
            fs,
            http,
            dir,
        });
    }
}
