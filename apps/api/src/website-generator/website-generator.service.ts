import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { WebsiteRepositoryCreationMethod } from '../items-generator/dto/create-items-generator.dto';
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

        if (directory.organization) {
            return this.githubService.duplicateAsOrg(
                template.owner,
                template.repo,
                directory.owner,
                directory.getWebsiteRepo(),
                token,
            );
        }

        return this.githubService.duplicate(
            template.owner,
            template.repo,
            directory.getWebsiteRepo(),
            token,
        );
    }

    private async fork(directory: Directory, user: User) {
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

    private async createUsingTemplate(directory: Directory, user: User) {
        const token = user.getGitToken();

        return this.githubService.createRepoFromTemplate(
            template.owner,
            template.repo,
            directory.owner,
            directory.getWebsiteRepo(),
            token,
        );
    }

    async initialize(
        directory: Directory,
        user: User,
        operation: WebsiteRepositoryCreationMethod = WebsiteRepositoryCreationMethod.DUPLICATE,
    ) {
        let path: any;
        try {
            if (operation === WebsiteRepositoryCreationMethod.DUPLICATE) {
                path = await this.duplicate(directory, user);
            } else if (operation === WebsiteRepositoryCreationMethod.FORK) {
                path = await this.fork(directory, user);
            } else if (operation === WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE) {
                path = await this.createUsingTemplate(directory, user);
            } else {
                // Default to duplicate if an unknown operation is somehow passed
                path = await this.duplicate(directory, user);
            }
        } finally {
            if (path && typeof path === 'string') {
                // cleanup
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    }
}
