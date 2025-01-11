import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { IGitAuth, GitService } from './git.service';

export abstract class GitProvider {
    constructor(protected readonly gitService: GitService) { }

    abstract getAuth(token: string): IGitAuth;

    abstract getURL(owner: string, repo: string): string;

    /* Clones remote repository to temporary location and returns absolute path */
    async clone(owner: string, repo: string, token: string) {
        const dir = path.join(os.tmpdir(), randomUUID());
        const url = this.getURL(owner, repo);
        const auth = this.getAuth(token);
        await this.gitService.clone(url, dir, auth);

        return dir;
    }

    push(dir: string, token: string) {
        const auth = this.getAuth(token);
        return this.gitService.push(dir, auth);
    }
}
