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

/**
 * The workspace-identifying fields EVERY signed Slack delivery carries,
 * whatever its shape — a JSON Events API `event_callback`, or a
 * form-encoded slash-command invocation. {@link extractSlackWorkspaceRef}
 * reads only these, so both receivers share one resolution path.
 */
export interface SlackWorkspaceCarrier {
    team_id?: string;
    enterprise_id?: string;
    /** Grid deliveries carry the installing team/enterprise here. */
    authorizations?: Array<{ team_id?: string | null; enterprise_id?: string | null }>;
}

/** The subset of a Slack Events API `event_callback` we consume. */
export interface SlackEventCallbackBody extends SlackWorkspaceCarrier {
    type?: string;
    event_id?: string;
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
 * The subset of a Slack SLASH-COMMAND invocation we consume.
 *
 * Slash commands are delivered `application/x-www-form-urlencoded` (not
 * JSON like the Events API), so every field arrives as a string. The
 * body is signed with the very same v0 scheme, which is why both
 * receivers share `verifySlackSignature` and `resolveBinding`.
 */
export interface SlackSlashCommandBody extends SlackWorkspaceCarrier {
    /** The invoked command, including the leading slash (e.g. `/works`). */
    command?: string;
    /** Everything the user typed after the command. */
    text?: string;
    channel_id?: string;
    channel_name?: string;
    user_id?: string;
    user_name?: string;
    /** Unique per invocation — the dedupe identity for the spine. */
    trigger_id?: string;
    /** Slack's delayed-response endpoint (unused; see the receiver's docs). */
    response_url?: string;
    api_app_id?: string;
}

/** Ingest kind for a slash-command invocation (`slack.mention`'s sibling). */
export const SLACK_COMMAND_EVENT_KIND = 'slack.command';

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
    body: SlackWorkspaceCarrier | undefined,
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
 * 4. `handleSlashCommand()` — the SAME chat leg for a slash-command
 *    invocation (`/works …`): ingest a `slack.command` envelope, then
 *    run the identical completion + reply path a mention takes, so both
 *    entry points behave the same. Unlike the mention path this one
 *    AWAITS the chat leg: its caller (the commands receiver) has
 *    already acked Slack and detached the work.
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
            const replyText = await this.runChatCompletion(binding, prompt);
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

    // ── Slash commands ──────────────────────────────────────────────────

    /**
     * Handle ONE verified slash-command invocation end to end: ingest it
     * into the spine (so it shows up in Activities/Memory like every
     * other Slack event), then answer through the same chat leg a
     * mention takes.
     *
     * Called DETACHED by the receiver — Slack has already been acked, so
     * this may take as long as the completion needs. A duplicate
     * delivery (Slack re-sends when an ack times out) dedupes to zero
     * inserts and is never answered twice.
     */
    async handleSlashCommand(
        binding: SlackEventsBinding,
        command: SlackSlashCommandBody,
    ): Promise<{ ingested: IngestResult | null }> {
        const envelope = this.toCommandEnvelope(command);
        let ingested: IngestResult | null = null;

        if (envelope) {
            try {
                ingested = await this.eventIngestService.ingest(binding.userId, [envelope]);
            } catch (error) {
                // Ingest is the audit trail, not the answer — a spine
                // failure must not cost the user their reply.
                this.logger.warn(
                    `Slack slash-command ingest failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
            if (ingested && ingested.inserted === 0) {
                this.logger.debug('Duplicate Slack slash-command delivery; not answering it twice');
                return { ingested };
            }
        }

        await this.bridgeCommandToChat(binding, command);
        return { ingested };
    }

    /** Normalize a slash-command invocation into an ingest envelope (or skip it). */
    toCommandEnvelope(command: SlackSlashCommandBody): IngestedEventEnvelope | null {
        const channel = command.channel_id ?? '';
        const invoked = (command.command ?? '').trim();
        if (!channel || !invoked) return null;

        const text = command.text ?? '';
        return {
            id: randomUUID(),
            source: SLACK_CONNECTOR_PLUGIN_ID,
            // A slash command has no message `ts`, so `channel:ts` is not
            // available. `trigger_id` is unique per invocation; the
            // `command:` namespace keeps it from ever colliding with the
            // message identities the mention/pull paths mint.
            sourceEventId: `command:${command.trigger_id ?? randomUUID()}`,
            kind: SLACK_COMMAND_EVENT_KIND,
            occurredAt: new Date().toISOString(),
            actor: {
                name: command.user_name ?? command.user_id ?? 'unknown',
                ...(command.user_id ? { externalId: command.user_id } : {}),
            },
            subject: {
                type: 'channel',
                externalId: channel,
                ...(command.channel_name ? { title: command.channel_name } : {}),
            },
            // Same routing as a message: the channel is the container.
            workHint: { kind: 'chat-channel', externalId: channel },
            payload: {
                channel,
                command: invoked,
                ...(command.trigger_id ? { triggerId: command.trigger_id } : {}),
                ...(command.team_id ? { teamId: command.team_id } : {}),
                text:
                    text.length > SLACK_EVENT_TEXT_MAX_CHARS
                        ? text.slice(0, SLACK_EVENT_TEXT_MAX_CHARS)
                        : text,
            },
        };
    }

    /**
     * Route a slash command's text into the platform chat as the bound
     * user and post the completion back into the originating channel.
     * BEST-EFFORT end to end, exactly like the mention path: every
     * failure is logged and swallowed (Slack was acked long ago).
     */
    async bridgeCommandToChat(
        binding: SlackEventsBinding,
        command: SlackSlashCommandBody,
    ): Promise<void> {
        const channel = command.channel_id;
        const prompt = (command.text ?? '').trim();
        if (!channel || !prompt) {
            this.logger.debug('Slack slash command carried no channel or text; skipping');
            return;
        }

        try {
            const replyText = await this.runChatCompletion(binding, prompt);
            if (!replyText) {
                this.logger.warn('Slack command chat completion returned no content; not replying');
                return;
            }
            // No thread to answer in — a slash command is invoked against
            // the channel itself, so the reply lands at the channel root.
            await this.postReply(binding, {
                channel,
                text: replyText,
                ...(command.trigger_id ? { providerEventId: command.trigger_id } : {}),
            });
        } catch (error) {
            this.logger.warn(
                `Slack command → chat bridge failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Run ONE platform-chat completion as the bound user — the single
     * chat leg shared by the mention and slash-command paths.
     *
     * `model: 'auto'` defers model selection to the user's configured AI
     * plugin settings, which is the same path the web chat uses.
     */
    private async runChatCompletion(
        binding: SlackEventsBinding,
        prompt: string,
    ): Promise<string | null> {
        const completion = await this.openAiCompatService.handleCompletion(
            {
                model: 'auto',
                messages: [{ role: 'user', content: prompt }],
            } as OpenAiChatCompletionRequestDto,
            { userId: binding.userId },
        );
        return completion.choices?.[0]?.message?.content?.trim() ?? null;
    }

    /**
     * Post a reply through the slack-connector plugin (vendor SDK path).
     * With a `threadTs` the reply lands in that thread (mentions);
     * without one it lands at the channel root (slash commands).
     */
    private async postReply(
        binding: SlackEventsBinding,
        input: { channel: string; threadTs?: string; text: string; providerEventId?: string },
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
        const conversationId = input.threadTs
            ? `${input.channel}:${input.threadTs}`
            : input.channel;
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
                target: {
                    ...target,
                    channelId: input.channel,
                    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
                },
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
