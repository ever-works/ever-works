import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { ActivityFeedController } from './activity-feed.controller';
import { ActivityFeedService } from './activity-feed.service';
import { DirectoryWebsiteClient } from './directory-website-client.service';

@Module({
    imports: [
        // Pull-transport HTTP client (EW-120). 5s timeout matches the
        // hardcoded `REQUEST_TIMEOUT_MS` in `DirectoryWebsiteClient`;
        // no redirects so we don't follow the deployed site to an
        // attacker-controlled URL if a Work's `website` is later
        // proxied.
        HttpModule.register({ timeout: 5000, maxRedirects: 0 }),
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
