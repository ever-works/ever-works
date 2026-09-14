import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ActivityLogService } from './activity-log.service';
import { FeedService } from './feed.service';

@Module({
    imports: [DatabaseModule],
    providers: [
        ActivityLogService,
        // Live Feed — the narrated read model over the same activity store:
        // one store, one module. AgentRepository is not in the DatabaseModule
        // inventory (AgentsModule owns it), so it is provided locally for the
        // read-only actor lookups, as SkillsModule and SubscriptionsModule do,
        // rather than importing the whole agent runtime.
        FeedService,
        AgentRepository,
    ],
    exports: [ActivityLogService, FeedService],
})
export class ActivityLogModule {}
