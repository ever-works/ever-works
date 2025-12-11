import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { DirectoryOperationsModule } from '@packages/agent/directory-operations';
import { DirectoryModule } from '@packages/agent/services';

@Module({
    imports: [DirectoryOperationsModule, DirectoryModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
