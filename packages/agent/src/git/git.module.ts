import { Module } from '@nestjs/common';
import { GithubService } from './github.service';
import { BranchSyncService } from './branch-sync.service';

@Module({
    providers: [GithubService, BranchSyncService],
    exports: [GithubService, BranchSyncService],
})
export class GitModule {}
