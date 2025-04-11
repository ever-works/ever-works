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

    /*  We duplicate because fork is async as GitHub API docs states: 
     *  https://docs.github.com/en/rest/repos/forks?apiVersion=2022-11-28#create-a-fork
     *  But you can try to fork it if you want and check if it's really an issue for us.
     *  I think having workflows inside repo available from the beginning is main reason why I decided to duplicate repo.
     */
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
        // cleanup
        await fs.rm(path, { recursive: true, force: true });
      }
    }
  }
}
