import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { TriggerAiModule } from './trigger-ai.module';

/**
 * Module for Trigger.dev items generator jobs.
 * Step services have been moved to plugins (default-pipeline-plugin).
 */
@Module({
    imports: [TriggerAiModule, FacadesModule],
    providers: [],
    exports: [],
})
export class TriggerItemsGeneratorModule {}
