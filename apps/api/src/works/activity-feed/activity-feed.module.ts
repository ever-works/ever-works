import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { ActivityFeedController } from './activity-feed.controller';
import { ActivityFeedService } from './activity-feed.service';
import { DirectoryWebsiteClient } from './directory-website-client.service';

/**
 * Module for the EW-120 Activity Feed aggregator. Composes the
 * platform's existing `activity-log`, per-Work generation history
 * (via `DatabaseModule`/`WorkGenerationHistoryRepository`), and the
 * deployed directory site's `/api/platform/activity-feed` endpoint.
 *
 * Spec: docs/specs/features/activity-feed-per-directory/spec.md
 * Plan: docs/specs/features/activity-feed-per-directory/plan.md
 */
@Module({
    imports: [
        HttpModule.register({
            timeout: 5000,
            maxRedirects: 0,
        }),
        ActivityLogModule,
        WorkModule,
        DatabaseModule,
        AuthModule,
    ],
    controllers: [ActivityFeedController],
    providers: [ActivityFeedService, DirectoryWebsiteClient],
    exports: [ActivityFeedService],
})
export class ActivityFeedModule {}
