import { Module } from '@nestjs/common';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { ActivityFeedController } from './activity-feed.controller';
import { ActivityFeedService } from './activity-feed.service';

@Module({
    imports: [ActivityLogModule, WorkModule, DatabaseModule, AuthModule],
    controllers: [ActivityFeedController],
    providers: [ActivityFeedService],
    exports: [ActivityFeedService],
})
export class ActivityFeedModule {}
