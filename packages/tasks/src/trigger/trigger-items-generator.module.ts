import { Module } from '@nestjs/common';
import { GitModule } from '@packages/agent/git';
import { TriggerAiModule } from './trigger-ai.module';

/**
 * Module for Trigger.dev items generator jobs.
 * Step services have been moved to plugins (default-pipeline-plugin).
 */
@Module({
    imports: [TriggerAiModule, GitModule],
    providers: [],
    exports: [],
})
export class TriggerItemsGeneratorModule {}
