import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { AiConversationController } from './ai-conversation.controller';
import { AiConversationService } from './ai-conversation.service';

@Module({
    imports: [FacadesModule],
    controllers: [AiConversationController],
    providers: [AiConversationService],
})
export class AiConversationModule {}
