import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { DirectoryOperationsModule } from '@packages/agent/directory';

@Module({
    imports: [DirectoryOperationsModule],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
