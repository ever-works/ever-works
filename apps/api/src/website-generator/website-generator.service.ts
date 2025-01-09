import { Injectable } from '@nestjs/common';
import { GithubService } from '../github/github.service';

@Injectable()
export class WebsiteGeneratorService {
    constructor(
        private readonly githubService: GithubService,
      ) {}
    
      initialize() {
        return this.githubService.forkRepo('ever-co', 'ever-works-website', { apiKey: process.env.GITHUB_APIKEY });
      }
}
