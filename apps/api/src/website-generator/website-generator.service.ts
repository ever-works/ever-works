import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import * as fs from 'fs/promises';

@Injectable()
export class WebsiteGeneratorService {
  constructor(
    private readonly githubService: GithubService,
  ) { }

  async duplicate(directory: Directory, user: User) {
    const template = {
      owner: 'ever-co',
      repo: 'ever-works-website-template',
    };

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

  async initialize(directory: Directory, user: User) {
    let path: string;
    try {
      path = await this.duplicate(directory, user);
    } finally {
      if (path) {
        await fs.rm(path, { recursive: true, force: true });
      }
    }
  }
}
