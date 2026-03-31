import { Module } from '@nestjs/common';
import { ActivityLogModule as AgentActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';
import { ActivityLogController } from './activity-log.controller';
import { ActivityLogListener } from './activity-log.listener';

@Module({
	imports: [AgentActivityLogModule, DatabaseModule],
	controllers: [ActivityLogController],
	providers: [ActivityLogListener],
	exports: [AgentActivityLogModule],
})
export class ActivityLogModule {}
