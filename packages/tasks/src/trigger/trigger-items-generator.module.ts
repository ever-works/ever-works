import { Module } from '@nestjs/common';
import { GitModule } from '@packages/agent/git';
import { STEP_SERVICES, STEP_SERVICES_EXPORTS } from '@packages/agent/items-generator';
import { TriggerAiModule } from './trigger-ai.module';

@Module({
    imports: [TriggerAiModule, GitModule],
    providers: STEP_SERVICES,
    exports: STEP_SERVICES_EXPORTS,
})
export class TriggerItemsGeneratorModule {}
