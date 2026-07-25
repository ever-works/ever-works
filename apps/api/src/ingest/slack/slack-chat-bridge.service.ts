import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService, type IngestResult } from '@ever-works/agent/ingest';
import {
    PluginRegistryService,
    PluginSettingsService,
    UserPluginRepository,
} from '@ever-works/agent/plugins';
import { PLUGIN_CAPABILITIES, isConnectorPlugin } from '@ever-works/plugin';
import type { ChannelTargetConfig, IConnectorPlugin } from '@ever-works/plugin';
import { OpenAiCompatService } from '../../ai-conversation/openai-compat.service';
import type { OpenAiChatCompletionRequestDto } from '../../ai-conversation/dto/openai-compat.dto';

export const SLACK_CONNECTOR_PLUGIN_ID = 'slack-connector';

/** Payload text cap for envelopes built from webhook deliveries. */
export const SLACK_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * v1 workspace→user binding: the events land under the platform user who
 * configured the slack-connector plugin (first enabled install with a
 * signing secret). Multi-user / per-workspace `team_id` mapping is a
 * documented follow-up (a pairing table keyed by Slack team + user id).
 */
export interface SlackEventsBinding {
    readonly userId: string;
    readonly signingSecret: string;
    /** Resolved plugin settings (secrets included) for outbound replies. */
    readonly settings: Record<string, unknown>;
}

/** The subset of a Slack Events API `event_callback` we consume. */
export interface SlackEventCallbackBody {
    type?: string;
    event_id?: string;
    team_id?: string;
    event?: {
        type?: string;
        subtype?: string;
        user?: string;
        username?: string;
        bot_id?: string;
        text?: string;
        channel?: string;
        ts?: string;
        event_ts?: string;
        thread_ts?: string;
    };
}

/**
 * Slack app surface (Wave 6, feature f) — ONE service bridging the Slack
 * Events API into the platform:
 *
 * 1. `resolveBinding()` — the v1 workspace→user binding (see
 *    {@link SlackEventsBinding}) plus the signing secret the receiver
 *    verifies deliveries with. Fail-closed: no configured install → no
 *    binding → the endpoint 401s.
 * 2. `handleEventCallback()` — normalizes `app_mention` / `message`
 *    events into `IngestedEventEnvelope`s and dedupe-inserts them
 *    through the event-ingest spine (`slack.mention` / `slack.message`,
 *    identity `channel:ts` so webhook pushes and the connector's
 *    `pullEvents` sweeps converge on one row).
 * 3. `@works` mentions — on a first-seen `app_mention`, routes the text
 *    into the EXISTING platform chat engine (`OpenAiCompatService`, the
 *    same surface the web app uses) as the bound user, and posts the
 *    completion back into the Slack thread via the slack-connector
 *    plugin's `reply` (best-effort: failures are logged, never thrown —
 *    the webhook 200s regardless).
 */
@Injectable()
export class SlackChatBridgeService {
    private readonly logger = new Logger(SlackChatBridgeService.name);

    constructor(
        private readonly userPluginRepository: UserPluginRepository,
        private readonly pluginSettingsService: PluginSettingsService,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly eventIngestService: EventIngestService,
        private readonly openAiCompatService: OpenAiCompatService,
    ) {}

    /**
     * Resolve the v1 events binding: the OLDEST enabled slack-connector
     * install whose resolved settings carry a signing secret. Returns
     * null when nothing is configured — callers must fail closed.
     */
    async resolveBinding(): Promise<SlackEventsBinding | null> {
        const installs = await this.userPluginRepository.findByPlugin(SLACK_CONNECTOR_PLUGIN_ID);
        const candidates = installs
            .filter((row) => row.enabled)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        for (const row of candidates) {
            const settings = await this.pluginSettingsService.getSettings(
                SLACK_CONNECTOR_PLUGIN_ID,
                { userId: row.userId, includeSecrets: true },
            );
            const signingSecret = settings?.signingSecret;
            if (typeof signingSecret === 'string' && signingSecret.length > 0) {
                return { userId: row.userId, signingSecret, settings: settings ?? {} };
            }
        }
        return null;
    }

    /**
     * Ingest one verified `event_callback` delivery and (for first-seen
     * mentions) kick the chat bridge. The chat leg is deliberately not
     * awaited — Slack requires a fast 200, and the reply is best-effort.
     */
    async handleEventCallback(
        binding: SlackEventsBinding,
        body: SlackEventCallbackBody,
    ): Promise<{ ingested: IngestResult | null }> {
        const envelope = this.toEnvelope(body);
        if (!envelope) {
            return { ingested: null };
        }

        const ingested = await this.eventIngestService.ingest(binding.userId, [envelope]);

        // Retries and pull-path overlap dedupe to 0 inserts — only a
        // first-seen mention triggers the chat bridge (no double replies).
        if (envelope.kind === 'slack.mention' && ingested.inserted > 0) {
            void this.bridgeMentionToChat(binding, body).catch((error: unknown) => {
                // bridgeMentionToChat handles its own errors; this catch is a
                // belt-and-suspenders guard so nothing escapes the void.
                this.logger.warn(
                    `Slack mention bridge failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }

        return { ingested };
    }

    /** Normalize an `event_callback` body into an ingest envelope (or skip it). */
    toEnvelope(body: SlackEventCallbackBody): IngestedEventEnvelope | null {
        if (body?.type !== 'event_callback' || !body.event) return null;
        const event = body.event;
        if (event.type !== 'app_mention' && event.type !== 'message') return null;
        // Never ingest bot-authored messages (incl. our own replies) or
        // system subtypes — the spine must not echo its own output.
        if (event.bot_id || event.subtype) return null;
        const channel = event.channel ?? '';
        const ts = event.ts ?? event.event_ts ?? '';
        if (!channel || !ts) return null;

        const text = event.text ?? '';
        return {
            id: randomUUID(),
            source: SLACK_CONNECTOR_PLUGIN_ID,
            // Identity is `channel:ts` (not Slack's event_id) so the webhook
            // push path and the connector's pullEvents sweep dedupe against
            // each other — one message, one row, regardless of arrival path.
            sourceEventId: `${channel}:${ts}`,
            kind: event.type === 'app_mention' ? 'slack.mention' : 'slack.message',
            occurredAt: this.slackTsToIso(ts),
            actor: {
                name: event.username ?? event.user ?? 'unknown',
                ...(event.user ? { externalId: event.user } : {}),
            },
            subject: { type: 'channel', externalId: channel },
            payload: {
                channel,
                ts,
                ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
                ...(body.team_id ? { teamId: body.team_id } : {}),
                ...(body.event_id ? { providerEventId: body.event_id } : {}),
                text:
                    text.length > SLACK_EVENT_TEXT_MAX_CHARS
                        ? text.slice(0, SLACK_EVENT_TEXT_MAX_CHARS)
                        : text,
            },
        };
    }

    /**
     * Route a mention's text into the platform chat as the bound user and
     * post the completion back into the originating Slack thread.
     * BEST-EFFORT end to end: every failure is logged and swallowed.
     */
    async bridgeMentionToChat(
        binding: SlackEventsBinding,
        body: SlackEventCallbackBody,
    ): Promise<void> {
        const event = body.event;
        const channel = event?.channel;
        const ts = event?.ts ?? event?.event_ts;
        if (!event || !channel || !ts) return;

        const prompt = this.stripMentions(event.text ?? '');
        if (!prompt) {
            this.logger.debug('Slack mention carried no text after stripping mentions; skipping');
            return;
        }

        try {
            // `model: 'auto'` defers model selection to the user's configured
            // AI plugin settings — the same path the web chat uses.
            const completion = await this.openAiCompatService.handleCompletion(
                {
                    model: 'auto',
                    messages: [{ role: 'user', content: prompt }],
                } as OpenAiChatCompletionRequestDto,
                { userId: binding.userId },
            );
            const replyText = completion.choices?.[0]?.message?.content?.trim();
            if (!replyText) {
                this.logger.warn('Slack mention chat completion returned no content; not replying');
                return;
            }
            await this.postReply(binding, {
                channel,
                threadTs: event.thread_ts ?? ts,
                text: replyText,
                providerEventId: body.event_id,
            });
        } catch (error) {
            // Never rethrow — the webhook already 200'd and Slack retries
            // would only duplicate work. Message only; never settings/secrets.
            this.logger.warn(
                `Slack mention → chat bridge failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Post a threaded reply through the slack-connector plugin (vendor SDK path). */
    private async postReply(
        binding: SlackEventsBinding,
        input: { channel: string; threadTs: string; text: string; providerEventId?: string },
    ): Promise<void> {
        const plugin = this.getSlackConnector();
        if (!plugin) {
            this.logger.warn('slack-connector plugin is not loaded; cannot post reply');
            return;
        }
        const botToken = binding.settings.botToken;
        if (typeof botToken !== 'string' || botToken.length === 0) {
            this.logger.warn('slack-connector settings have no botToken; cannot post reply');
            return;
        }
        const target: ChannelTargetConfig = { botToken };
        const options = {
            userId: binding.userId,
            settings: binding.settings,
            target,
        };
        const conversationId = `${input.channel}:${input.threadTs}`;
        if (plugin.reply) {
            await plugin.reply(
                {
                    externalConversationId: conversationId,
                    text: input.text,
                    ...(input.providerEventId
                        ? { inReplyToProviderEventId: input.providerEventId }
                        : {}),
                },
                options,
            );
            return;
        }
        // Older connector builds without `reply` — fall back to a plain send.
        await plugin.send(
            {
                text: input.text,
                messageRef: `slack-mention-${input.providerEventId ?? conversationId}`,
                attribution: { userId: binding.userId },
                target: { ...target, channelId: input.channel, threadTs: input.threadTs },
            },
            options,
        );
    }

    private getSlackConnector(): IConnectorPlugin | null {
        const registered = this.pluginRegistry
            .getByCapability(PLUGIN_CAPABILITIES.CONNECTOR_SLACK)
            .find((p) => p.plugin.id === SLACK_CONNECTOR_PLUGIN_ID && p.state === 'loaded');
        if (!registered || !isConnectorPlugin(registered.plugin)) return null;
        return registered.plugin;
    }

    /** Strip `<@U…>` mention tokens (and stray whitespace) from the text. */
    private stripMentions(text: string): string {
        return text
            .replace(/<@[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private slackTsToIso(ts: string): string {
        const seconds = Number(ts);
        if (!Number.isFinite(seconds)) return new Date(0).toISOString();
        return new Date(seconds * 1000).toISOString();
    }
}
