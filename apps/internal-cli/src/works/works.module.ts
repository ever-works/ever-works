import { Module } from '@nestjs/common';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { WorkModule } from '@ever-works/agent/services';
import { WorksController } from './works.controller';

@Module({
    imports: [WorkModule, ActivityLogModule],
    controllers: [WorksController],
})
export class WorksModule {}
