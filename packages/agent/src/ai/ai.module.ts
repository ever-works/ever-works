import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { TypeORMChatHistoryService } from './typeorm-chat-history.service';
import { AiConversationService } from './ai-conversation.service';
import { ModelRouterService } from './model-router';
import { DatabaseModule } from '../database/database.module';

@Module({
    imports: [DatabaseModule],
    providers: [AiService, TypeORMChatHistoryService, AiConversationService, ModelRouterService],
    exports: [AiService, TypeORMChatHistoryService, AiConversationService, ModelRouterService],
})
export class AiModule {}
