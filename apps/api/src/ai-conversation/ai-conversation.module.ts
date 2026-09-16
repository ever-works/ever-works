import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { KnowledgeBaseModule } from '@ever-works/agent/services';
import { ConversationsModule } from '@ever-works/agent/conversations';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';
import { ConversationController } from './conversation.controller';
import { ConversationParticipantsController } from './conversation-participants.controller';
import { ConversationStreamController } from './conversation-stream.controller';
import { ConversationTitleService } from './conversation-title.service';

@Module({
    // EW-641 Phase 2/c row 34c — KnowledgeBaseModule brings
    // `KbMentionResolverService` into scope so `OpenAiCompatService`
    // can resolve `@kb:` mentions in user messages and inject a
    // `<kb>...</kb>` system message before the LLM call.
    //
    // Named Conversations with Agents — `ConversationsModule` brings the
    // naming, participant, mention and send services the new routes use.
    imports: [FacadesModule, DatabaseModule, KnowledgeBaseModule, ConversationsModule],
    // Order matters: `ConversationStreamController` owns the static
    // `GET /api/conversations/stream` and must be routed before
    // `ConversationController`'s `GET /api/conversations/:id`.
    controllers: [
        OpenAiCompatController,
        ConversationStreamController,
        ConversationController,
        ConversationParticipantsController,
    ],
    providers: [OpenAiCompatService, ConversationTitleService],
    // Exported for the Slack chat bridge (IngestModule) — Slack mentions
    // route through the SAME chat surface the web app uses.
    exports: [OpenAiCompatService],
})
export class AiConversationModule {}
