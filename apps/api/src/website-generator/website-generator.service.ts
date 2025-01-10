import { Injectable } from '@nestjs/common';
import { GithubService } from '../git/github.service';

@Injectable()
export class WebsiteGeneratorService {
    constructor(
        private readonly githubService: GithubService,
      ) {}
    
      initialize() {
        return this.githubService.fork('ever-co', 'ever-works-website', process.env.GITHUB_APIKEY);
      }
}
