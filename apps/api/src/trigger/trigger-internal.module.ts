import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { DirectoryOperationsModule } from '@ever-works/agent/directory-operations';
import { DirectoryModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';

@Module({
    imports: [DirectoryOperationsModule, DirectoryModule, NotificationsModule, FacadesModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
