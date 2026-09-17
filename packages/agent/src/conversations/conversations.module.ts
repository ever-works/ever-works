import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentsModule } from '../agents/agents.module';
import { ConversationContextResolver } from './conversation-context.resolver';
import { ConversationDispatchService } from './conversation-dispatch.service';
import { ConversationMentionService } from './conversation-mention.service';
import { ConversationMessageService } from './conversation-message.service';
import { ConversationService } from './conversation.service';

/**
 * Named Conversations with Agents — agent-side domain module.
 *
 * Owns naming, participants, mentions, sending with retry, and the reply
 * contract. Persistence comes from `DatabaseModule` (the conversation and
 * participant repositories); the Agent and run repositories, the dispatch
 * gate and the run-steering port come from `AgentsModule`, exactly as the
 * Task chat service gets them.
 *
 * The job-runtime adapter behind `AGENT_CONVERSATION_REPLY_DISPATCHER` is
 * bound by the api-side @Global() `TasksModule`, alongside the Task
 * dispatchers, and injected `@Optional()` so this module constructs without it.
 */
@Module({
    imports: [DatabaseModule, AgentsModule],
    providers: [
        ConversationContextResolver,
        ConversationService,
        ConversationMentionService,
        ConversationDispatchService,
        ConversationMessageService,
    ],
    exports: [
        ConversationContextResolver,
        ConversationService,
        ConversationMentionService,
        ConversationDispatchService,
        ConversationMessageService,
    ],
})
export class ConversationsModule {}
