import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { ImportModule } from '@ever-works/agent/import';
import { AuthModule } from '@src/auth';
import { UsersModule } from '@src/users/users.module';
import { GitHubAppController } from './github-app.controller';
import { GitHubAppService } from './github-app.service';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppSyncService } from './github-app-sync.service';

/**
 * GitHub App integration — OAuth setup/callback, installation listing and
 * the installation-sync service.
 *
 * The App's WEBHOOK route (`POST /api/github-app/webhooks`) used to be a
 * controller here with its own signature check and `GitHubAppSyncService`
 * as its only consumer. It is now a thin forwarder onto the single
 * consolidated GitHub receiver and lives in `ingest/github/`, registered
 * by `IngestModule`. The route and its response are unchanged; the module
 * edge points ONE way (`IngestModule` → `GitHubAppModule`) so the two
 * never form a cycle. `GitHubAppSyncService` stays exported because the
 * consolidated receiver fans out to it.
 */
@Module({
    imports: [DatabaseModule, HttpModule, AuthModule, WorkModule, ImportModule, UsersModule],
    providers: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
    controllers: [GitHubAppController],
    exports: [GitHubAppService, GitHubAppOnboardingService, GitHubAppSyncService],
})
export class GitHubAppModule {}
