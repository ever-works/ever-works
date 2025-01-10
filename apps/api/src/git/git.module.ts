import { Module } from '@nestjs/common';
import { GithubService } from './github.service';
import { GitService } from './git.service';

@Module({
  providers: [GitService, GithubService],
  exports: [GitService, GithubService],
})
export class GitModule {}
