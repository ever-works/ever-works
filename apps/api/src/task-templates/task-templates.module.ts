import { Module } from '@nestjs/common';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { TaskTemplatesController } from './task-templates.controller';

/**
 * Tasks upgrades — API module for workflow Task Templates.
 * TaskTemplatesService is provided + exported by TasksDomainModule.
 */
@Module({
    imports: [TasksDomainModule],
    controllers: [TaskTemplatesController],
})
export class TaskTemplatesModule {}
