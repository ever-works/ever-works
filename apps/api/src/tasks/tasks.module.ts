import { Module } from '@nestjs/common';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { TasksController } from './tasks.controller';

/**
 * Tasks feature — Phase 12. API-side module. Imports the agent-side
 * data module (which carries TasksService + TaskTransitionService)
 * and mounts the controller. Chat + attachment routes land in
 * Phase 13.
 */
@Module({
	imports: [TasksDomainModule],
	controllers: [TasksController],
})
export class TasksModule {}
