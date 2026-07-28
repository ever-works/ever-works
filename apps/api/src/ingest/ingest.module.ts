import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { EventIngestModule } from '@ever-works/agent/ingest';
import { PrReviewModule } from '@ever-works/agent/pr-review';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { AiConversationModule } from '../ai-conversation/ai-conversation.module';
import { GitHubAppModule } from '../integrations/github-app/github-app.module';
import { IngestController } from './ingest.controller';
import { SlackEventsController } from './slack/slack-events.controller';
import { SlackCommandsController } from './slack/slack-commands.controller';
import { SlackChatBridgeService } from './slack/slack-chat-bridge.service';
import { GitHubEventsController } from './github/github-events.controller';
import { GitHubAppWebhookController } from './github/github-app-webhook.controller';
import { GitHubPrReviewBridgeService } from './github/github-pr-review-bridge.service';
import { GitHubWebhookDispatcherService } from './github/github-webhook-dispatcher.service';

/**
 * Event-ingest spine (Wave 6) — thin API module exposing
 * `GET/POST /api/ingest/events` over the agent-side `EventIngestModule`
 * (dedupe-insert + processor fan-out live there), plus the Slack
 * receivers — the Events API (`POST /api/ingest/slack/events`) and the
 * slash command (`POST /api/ingest/slack/commands`) — over their shared
 * mention/command→platform-chat bridge (`SlackChatBridgeService`), plus
 * the CONSOLIDATED GitHub receiver.
 *
 * ## The Slack receiver is one bridge on two routes
 *
 * `SlackChatBridgeService` owns workspace resolution, signing secrets,
 * ingest and the chat leg; the two controllers differ only in Slack's
 * wire contract (JSON events vs. a form-encoded slash command that must
 * be acked in under 3s). Both verify with the one
 * `verifySlackSignature` helper, and both answer through the same
 * completion + connector-reply path.
 *
 * ## The GitHub receiver is one receiver on two routes
 *
 * `GitHubWebhookDispatcherService` owns the whole inbound path:
 * signature verification (one helper, either configured credential),
 * install-binding resolution over the one `ingest_install_bindings`
 * table, and the fan-out to every consumer —
 * `GitHubPrReviewBridgeService` (ingest envelopes + AI PR review) and
 * `GitHubAppSyncService` (App installation / repository sync). Two
 * controllers sit on top of it and differ only in the status codes their
 * historical callers expect:
 *
 *   * `GitHubEventsController`     → `POST /api/ingest/github/events`
 *   * `GitHubAppWebhookController` → `POST /api/github-app/webhooks`
 *     (the URL configured in the GitHub App itself; kept as a thin
 *     forwarder, it cannot move)
 *
 * `GitHubAppModule` is imported for `GitHubAppSyncService` and the App
 * installation repositories. The edge is deliberately one-way — the App
 * module no longer registers a webhook controller, so nothing points
 * back here and there is no cycle.
 *
 * Plugin-system services the bridges consume (registry / settings /
 * user-plugin repository) come from the @Global agent PluginsModule
 * bootstrapped in api.module.ts; `OpenAiCompatService` (the platform
 * chat surface) comes from `AiConversationModule`; the Work-aware
 * reviewer comes from the agent-side `PrReviewModule`; the durable
 * rejection recorder (orchestration M9) comes from `TasksDomainModule`.
 */
@Module({
    imports: [
        DatabaseModule,
        EventIngestModule,
        AiConversationModule,
        PrReviewModule,
        GitHubAppModule,
        TasksDomainModule,
    ],
    controllers: [
        IngestController,
        SlackEventsController,
        SlackCommandsController,
        GitHubEventsController,
        GitHubAppWebhookController,
    ],
    providers: [
        SlackChatBridgeService,
        GitHubPrReviewBridgeService,
        GitHubWebhookDispatcherService,
    ],
    exports: [EventIngestModule],
})
export class IngestModule {}
