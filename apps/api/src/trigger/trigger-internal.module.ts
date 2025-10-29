import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { DatabaseModule } from '@packages/agent/database';
import { DirectoryOperationsModule } from '@packages/agent/directory';

@Module({
    imports: [DatabaseModule, DirectoryOperationsModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
