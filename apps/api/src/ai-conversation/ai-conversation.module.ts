import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { AiConversationController } from './ai-conversation.controller';
import { AiConversationService } from './ai-conversation.service';

@Module({
    imports: [FacadesModule, DatabaseModule],
    controllers: [AiConversationController],
    providers: [AiConversationService],
})
export class AiConversationModule {}
