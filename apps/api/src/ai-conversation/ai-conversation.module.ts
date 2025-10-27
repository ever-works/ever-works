import { Module } from '@nestjs/common';
import { AiConversationController } from './ai-conversation.controller';
import { AiModule } from '@packages/agent/ai';

@Module({
    imports: [AiModule],
    controllers: [AiConversationController],
})
export class AiConversationModule {}
