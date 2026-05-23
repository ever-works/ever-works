import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { KnowledgeBaseModule } from '@ever-works/agent/services';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';
import { ConversationController } from './conversation.controller';
import { ConversationTitleService } from './conversation-title.service';

@Module({
    // EW-641 Phase 2/c row 34c — KnowledgeBaseModule brings
    // `KbMentionResolverService` into scope so `OpenAiCompatService`
    // can resolve `@kb:` mentions in user messages and inject a
    // `<kb>...</kb>` system message before the LLM call.
    imports: [FacadesModule, DatabaseModule, KnowledgeBaseModule],
    controllers: [OpenAiCompatController, ConversationController],
    providers: [OpenAiCompatService, ConversationTitleService],
})
export class AiConversationModule {}
