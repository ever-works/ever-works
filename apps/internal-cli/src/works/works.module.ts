import { Module } from '@nestjs/common';
import { WorkModule } from '@ever-works/agent/services';
import { WorksController } from './works.controller';

@Module({
    imports: [WorkModule],
    controllers: [WorksController],
})
export class WorksModule {}
