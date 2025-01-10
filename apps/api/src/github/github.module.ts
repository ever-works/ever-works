import { Module } from '@nestjs/common';
import { GithubService } from './github.service';
import { GitService } from './git.service';

@Module({
  providers: [GithubService, GitService],
  exports: [GithubService, GitService],
})
export class GithubModule {}
