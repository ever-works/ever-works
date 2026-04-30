import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '@ever-works/agent/database';
import { DirectoryModule } from '@ever-works/agent/services';
import { ImportModule } from '@ever-works/agent/import';
import { AuthModule } from '@src/auth';
import { GitHubAppController } from './github-app.controller';
import { GitHubAppWebhookController } from './github-app-webhook.controller';
import { GitHubAppService } from './github-app.service';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppSyncService } from './github-app-sync.service';

@Module({
    imports: [DatabaseModule, HttpModule, AuthModule, DirectoryModule, ImportModule],
    providers: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
    controllers: [GitHubAppController, GitHubAppWebhookController],
    exports: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
})
export class GitHubAppModule {}
