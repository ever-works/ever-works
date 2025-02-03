import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';

@Injectable()
export class WebsiteGeneratorService {
    constructor(
        private readonly githubService: GithubService,
      ) {}
    
      initialize(directory: Directory, user: User) {
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
}
