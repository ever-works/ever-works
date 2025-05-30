import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import * as fs from 'node:fs/promises';

const template = {
    owner: 'ever-co',
    repo: 'ever-works-website-template',
} as const;

@Injectable()
export class WebsiteGeneratorService {
    constructor(private readonly githubService: GithubService) {}

    private async duplicate(directory: Directory, user: User) {
        const token = user.getGitToken();

        return this.githubService.fork(
            {
                owner: template.owner,
                repo: template.repo,
                name: directory.getWebsiteRepo(),
                isOrganization: directory.organization,
            },
            token,
        );
    }

    async initialize(
        directory: Directory,
        user: User,
        operation: 'fork' | 'clone' | 'create-using-template' = 'fork',
    ) {
        let path: any;
        try {
            path = await this.duplicate(directory, user);
        } finally {
            if (path && typeof path === 'string') {
                // cleanup
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }
}
