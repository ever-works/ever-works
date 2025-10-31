import { Module } from '@nestjs/common';
import { AiService } from '@src/ai/ai.service';

@Module({
    providers: [AiService],
    exports: [AiService],
})
export class TriggerAiModule {}
