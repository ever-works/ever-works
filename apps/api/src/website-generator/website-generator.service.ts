import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';

@Injectable()
export class WebsiteGeneratorService {
    constructor(
        private readonly githubService: GithubService,
      ) {}
    
      initialize(name: string) {
        return this.githubService.duplicate(
          'ever-co',
          'ever-works-website-template',
          `${name}-website`,
          process.env.GITHUB_APIKEY
        );
      }
}
