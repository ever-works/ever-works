import git from 'isomorphic-git';
import * as http from 'isomorphic-git/http/node';
import * as fs from 'fs';
import { Injectable } from "@nestjs/common";

@Injectable()
export class GitService {
    clone(url: string, dir: string, token: string) {
        return git.clone({
            onAuth: () => ({ username: 'x-access-token', password: token }),
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

    push(dir: string, token: string) {
        return git.push({
            onAuth: () => ({ username: 'x-access-token', password: token }), 
            fs,
            http,
            dir,
        });
    }
}
