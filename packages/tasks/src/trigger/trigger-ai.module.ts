import { Module } from '@nestjs/common';
import { AiService } from '@packages/agent/ai';

@Module({
    providers: [AiService],
    exports: [AiService],
})
export class TriggerAiModule {}
