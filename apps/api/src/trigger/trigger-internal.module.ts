import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { WorkModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';

@Module({
    imports: [WorkOperationsModule, WorkModule, NotificationsModule, FacadesModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
