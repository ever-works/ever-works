import { Module } from '@nestjs/common';
import { TriggerAiModule } from './trigger-ai.module';
import { GitModule } from '@src/git/git.module';
import { STEP_SERVICES, STEP_SERVICES_EXPORTS } from '@src/items-generator';

@Module({
    imports: [TriggerAiModule, GitModule],
    providers: STEP_SERVICES,
    exports: STEP_SERVICES_EXPORTS,
})
export class TriggerItemsGeneratorModule {}
