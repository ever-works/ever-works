import { Module } from '@nestjs/common';
import { EventIngestModule } from '@ever-works/agent/ingest';
import { AiConversationModule } from '../ai-conversation/ai-conversation.module';
import { IngestController } from './ingest.controller';
import { SlackEventsController } from './slack/slack-events.controller';
import { SlackChatBridgeService } from './slack/slack-chat-bridge.service';

/**
 * Event-ingest spine (Wave 6) — thin API module exposing
 * `POST /api/ingest/events` over the agent-side `EventIngestModule`
 * (dedupe-insert + processor fan-out live there), plus the Slack
 * Events API receiver (`POST /api/ingest/slack/events`) and its
 * mention→platform-chat bridge (`SlackChatBridgeService`).
 *
 * Plugin-system services the bridge consumes (registry / settings /
 * user-plugin repository) come from the @Global agent PluginsModule
 * bootstrapped in api.module.ts; `OpenAiCompatService` (the platform
 * chat surface) comes from `AiConversationModule`.
 */
@Module({
    imports: [EventIngestModule, AiConversationModule],
    controllers: [IngestController, SlackEventsController],
    providers: [SlackChatBridgeService],
    exports: [EventIngestModule],
})
export class IngestModule {}
