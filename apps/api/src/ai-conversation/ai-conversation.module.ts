import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';
import { ConversationController } from './conversation.controller';
import { ConversationTitleService } from './conversation-title.service';

@Module({
    imports: [FacadesModule, DatabaseModule],
    controllers: [OpenAiCompatController, ConversationController],
    providers: [OpenAiCompatService, ConversationTitleService],
})
export class AiConversationModule {}
