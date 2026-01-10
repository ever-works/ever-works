import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { DirectoryOperationsModule } from '@packages/agent/directory-operations';
import { DirectoryModule } from '@packages/agent/services';
import { NotificationsModule } from '@packages/agent/notifications';

@Module({
    imports: [DirectoryOperationsModule, DirectoryModule, NotificationsModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
