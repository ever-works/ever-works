import { Module } from '@nestjs/common';
import { EventIngestModule } from '@ever-works/agent/ingest';
import { PrReviewModule } from '@ever-works/agent/pr-review';
import { AiConversationModule } from '../ai-conversation/ai-conversation.module';
import { IngestController } from './ingest.controller';
import { SlackEventsController } from './slack/slack-events.controller';
import { SlackChatBridgeService } from './slack/slack-chat-bridge.service';
import { GitHubEventsController } from './github/github-events.controller';
import { GitHubPrReviewBridgeService } from './github/github-pr-review-bridge.service';

/**
 * Event-ingest spine (Wave 6) — thin API module exposing
 * `POST /api/ingest/events` over the agent-side `EventIngestModule`
 * (dedupe-insert + processor fan-out live there), plus the Slack
 * Events API receiver (`POST /api/ingest/slack/events`) and its
 * mention→platform-chat bridge (`SlackChatBridgeService`), plus the
 * GitHub events receiver (`POST /api/ingest/github/events`) and its
 * PR-review bridge (`GitHubPrReviewBridgeService`, Wave 7 feature g).
 *
 * Plugin-system services the bridges consume (registry / settings /
 * user-plugin repository) come from the @Global agent PluginsModule
 * bootstrapped in api.module.ts; `OpenAiCompatService` (the platform
 * chat surface) comes from `AiConversationModule`; the Work-aware
 * reviewer comes from the agent-side `PrReviewModule`.
 */
@Module({
    imports: [EventIngestModule, AiConversationModule, PrReviewModule],
    controllers: [IngestController, SlackEventsController, GitHubEventsController],
    providers: [SlackChatBridgeService, GitHubPrReviewBridgeService],
    exports: [EventIngestModule],
})
export class IngestModule {}
