import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { GitHubAppService } from './github-app.service';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppSyncService } from './github-app-sync.service';

@Module({
    imports: [DatabaseModule],
    providers: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
    exports: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
})
export class GitHubAppModule {}
