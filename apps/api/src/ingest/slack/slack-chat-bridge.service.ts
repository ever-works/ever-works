import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import {
    EventIngestService,
    IngestInstallBindingRepository,
    type IngestResult,
} from '@ever-works/agent/ingest';
import {
    PluginRegistryService,
    PluginSettingsService,
    UserPluginRepository,
} from '@ever-works/agent/plugins';
import { PLUGIN_CAPABILITIES, isConnectorPlugin } from '@ever-works/plugin';
import type { ChannelTargetConfig, IConnectorPlugin } from '@ever-works/plugin';
import { OpenAiCompatService } from '../../ai-conversation/openai-compat.service';
import type { OpenAiChatCompletionRequestDto } from '../../ai-conversation/dto/openai-compat.dto';
import type { IngestBindingMatch, IngestBindingResolution } from '../install-binding.types';

export const SLACK_CONNECTOR_PLUGIN_ID = 'slack-connector';

/** Binding-table namespace for Slack workspaces. */
export const SLACK_BINDING_PROVIDER = 'slack';

/** Payload text cap for envelopes built from webhook deliveries. */
export const SLACK_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * The external workspace identity a Slack delivery carries. `teamId` is
 * the discriminator (unique per workspace, including inside an Enterprise
 * Grid); `enterpriseId` is an extra guard applied when both the delivery
 * and the stored binding carry one.
 */
export interface SlackWorkspaceRef {
    readonly teamId: string;
    readonly enterpriseId?: string;
}

/**
 * Per-workspace binding: the platform user that OWNS the Slack workspace
 * a delivery came from, plus the signing secret the receiver verifies it
 * with and the resolved settings used to post the reply back.
 *
 * Resolution order and the refusal posture live in
 * `../install-binding.types`. `matchedBy` records which path produced
 * this binding so the receiver knows whether to persist it after
 * signature verification.
 */
export interface SlackEventsBinding {
    readonly userId: string;
    readonly signingSecret: string;
    /** Resolved plugin settings (secrets included) for outbound replies. */
    readonly settings: Record<string, unknown>;
    readonly matchedBy: IngestBindingMatch;
    /** The workspace this delivery named, when it carried one. */
    readonly workspace?: SlackWorkspaceRef;
}

/** Inputs the receiver passes when resolving a delivery to its owner. */
export interface SlackBindingLookup {
    /** Workspace identity read off the (not yet verified) delivery body. */
    readonly workspace?: SlackWorkspaceRef;
    /**
     * Verifies the raw delivery against a candidate's signing secret.
     * Only consulted when the workspace is unknown AND several installs
     * exist — a unique match is cryptographic proof of ownership.
     */
    readonly verifySignature?: (signingSecret: string) => boolean;
}

/** The subset of a Slack Events API `event_callback` we consume. */
export interface SlackEventCallbackBody {
    type?: string;
    event_id?: string;
    team_id?: string;
    enterprise_id?: string;
    /** Grid deliveries carry the installing team/enterprise here. */
    authorizations?: Array<{ team_id?: string | null; enterprise_id?: string | null }>;
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
 * Read the workspace identity off a delivery body.
 *
 * The body is NOT yet signature-verified at this point, and that is safe:
 * the value is used only to SELECT which install's secret to verify
 * against. A forged `team_id` therefore picks a secret that will not
 * validate the HMAC, and the delivery is rejected — it can never be used
 * to attribute an event to someone else.
 */
export function extractSlackWorkspaceRef(
    body: SlackEventCallbackBody | undefined,
): SlackWorkspaceRef | undefined {
    const auth = body?.authorizations?.[0];
    const teamId = body?.team_id ?? auth?.team_id ?? undefined;
    if (typeof teamId !== 'string' || teamId.length === 0) return undefined;
    const enterpriseId = body?.enterprise_id ?? auth?.enterprise_id ?? undefined;
    return typeof enterpriseId === 'string' && enterpriseId.length > 0
        ? { teamId, enterpriseId }
        : { teamId };
}

/**
 * Slack app surface (Wave 6, feature f) — ONE service bridging the Slack
 * Events API into the platform:
 *
 * 1. `resolveBinding()` — the PER-WORKSPACE binding (see
 *    {@link SlackEventsBinding}) plus the signing secret the receiver
 *    verifies deliveries with. Deliveries are attributed to the platform
 *    user that owns the Slack workspace they came from — never to "the
 *    oldest install". Fail-closed: no configured install → the endpoint
 *    401s; an unknown/ambiguous workspace is refused as a clean no-op.
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
        private readonly installBindings: IngestInstallBindingRepository,
    ) {}

    /**
     * Resolve one delivery to the platform user that OWNS the Slack
     * workspace it came from.
     *
     * Order (see `../install-binding.types`): exact binding → single
     * install (warn, then recorded once verified) → unique signature
     * match → refuse. Never falls back to "some other install": with two
     * workspaces configured, each one's events reach exactly its own
     * owner, and an unrecognized workspace is refused rather than guessed.
     */
    async resolveBinding(
        lookup: SlackBindingLookup = {},
    ): Promise<IngestBindingResolution<SlackEventsBinding>> {
        const candidates = await this.loadCandidates();
        if (candidates.length === 0) {
            return { status: 'not-configured' };
        }

        const workspace = lookup.workspace;

        // 1. Exact binding — the authoritative path.
        if (workspace) {
            const bound = await this.installBindings
                .findByWorkspace(SLACK_BINDING_PROVIDER, workspace.teamId)
                .catch(() => null);
            if (bound) {
                if (
                    bound.externalEnterpriseId &&
                    workspace.enterpriseId &&
                    bound.externalEnterpriseId !== workspace.enterpriseId
                ) {
                    this.logger.warn(
                        `Refusing Slack delivery for team ${workspace.teamId}: bound to a different enterprise`,
                    );
                    return { status: 'unresolved', reason: 'enterprise-mismatch' };
                }
                const owner = candidates.find((c) => c.userId === bound.userId);
                if (owner) {
                    return {
                        status: 'resolved',
                        binding: { ...owner, matchedBy: 'binding', workspace },
                    };
                }
                // The bound install was removed or lost its signing secret.
                // Attributing its events to ANOTHER user is exactly the
                // defect this replaces, so refuse instead.
                this.logger.warn(
                    `Refusing Slack delivery for team ${workspace.teamId}: the bound install is disabled or unconfigured`,
                );
                return { status: 'unresolved', reason: 'bound-install-unavailable' };
            }
        }

        // 2. Single-install legacy path — nothing to disambiguate.
        if (candidates.length === 1) {
            this.logger.warn(
                `Slack delivery${
                    workspace ? ` for team ${workspace.teamId}` : ''
                } has no workspace binding; attributing it to the single configured install (legacy path)`,
            );
            return {
                status: 'resolved',
                binding: {
                    ...candidates[0],
                    matchedBy: 'single-install',
                    ...(workspace ? { workspace } : {}),
                },
            };
        }

        // 3. Signature proof. Only decisive when the installs carry
        //    DIFFERENT signing secrets — installs of the same Slack app
        //    share one, so those deliveries fall through to the refusal.
        if (lookup.verifySignature) {
            const matches = candidates.filter((c) => lookup.verifySignature!(c.signingSecret));
            if (matches.length === 1) {
                return {
                    status: 'resolved',
                    binding: {
                        ...matches[0],
                        matchedBy: 'signature',
                        ...(workspace ? { workspace } : {}),
                    },
                };
            }
            if (matches.length > 1) {
                this.logger.warn(
                    `Refusing Slack delivery${
                        workspace ? ` for team ${workspace.teamId}` : ''
                    }: ${matches.length} installs share a signing secret and nothing distinguishes them`,
                );
                return { status: 'unresolved', reason: 'ambiguous-install' };
            }
        }

        this.logger.warn(
            `Refusing Slack delivery${
                workspace ? ` for team ${workspace.teamId}` : ' with no team_id'
            }: no install is bound to this workspace`,
        );
        return { status: 'unresolved', reason: 'unknown-workspace' };
    }

    /**
     * Persist the workspace→user binding after a delivery has passed
     * signature verification, so the deployment self-migrates off the
     * legacy single-install path onto exact resolution.
     *
     * Best-effort: a failure here must never break a webhook that has
     * already been verified and handled.
     */
    async recordBinding(binding: SlackEventsBinding): Promise<void> {
        if (binding.matchedBy === 'binding' || !binding.workspace) return;
        try {
            await this.installBindings.record({
                provider: SLACK_BINDING_PROVIDER,
                externalWorkspaceId: binding.workspace.teamId,
                externalEnterpriseId: binding.workspace.enterpriseId ?? null,
                userId: binding.userId,
                pluginId: SLACK_CONNECTOR_PLUGIN_ID,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record Slack workspace binding for team ${binding.workspace.teamId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Enabled slack-connector installs whose resolved settings carry a
     * signing secret, oldest first (stable ordering keeps the
     * single-install path deterministic).
     */
    private async loadCandidates(): Promise<
        Array<{ userId: string; signingSecret: string; settings: Record<string, unknown> }>
    > {
        const installs = await this.userPluginRepository.findByPlugin(SLACK_CONNECTOR_PLUGIN_ID);
        const enabled = installs
            .filter((row) => row.enabled)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const candidates: Array<{
            userId: string;
            signingSecret: string;
            settings: Record<string, unknown>;
        }> = [];
        for (const row of enabled) {
            const settings = await this.pluginSettingsService.getSettings(
                SLACK_CONNECTOR_PLUGIN_ID,
                { userId: row.userId, includeSecrets: true },
            );
            const signingSecret = settings?.signingSecret;
            if (typeof signingSecret === 'string' && signingSecret.length > 0) {
                candidates.push({ userId: row.userId, signingSecret, settings: settings ?? {} });
            }
        }
        return candidates;
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
            // Work routing: the channel is the container. Resolved
            // against the bound user's own Works only — a channel two
            // users both connect routes independently for each of them.
            workHint: { kind: 'chat-channel', externalId: channel },
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
