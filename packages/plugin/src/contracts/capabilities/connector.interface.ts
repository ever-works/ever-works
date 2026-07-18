import type { IPlugin } from '../plugin.interface.js';
import type { PluginPricing } from '../pricing.types.js';
import type {
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification
} from './notification-channel.interface.js';

/**
 * Connectors (EW "Connector fabric") — first-party, **bidirectional**
 * communication-channel plugins that both send outbound (messages /
 * records) AND accept inbound control (a message arrives → routes to
 * an Agent/Team → replies). This is a superset of the outbound-only
 * `INotificationChannelPlugin` (which stays unchanged) and is distinct
 * from the third-party aggregators (Composio / Make / SIM / Zapier /
 * Activepieces).
 *
 * See `docs/specs/features/connectors/spec.md` §7 for the canonical
 * contract description.
 *
 * Plugins implement `IConnectorPlugin` and declare the umbrella
 * `CONNECTOR` capability plus the provider-specific `CONNECTOR_SLACK` /
 * `_DISCORD` / etc. constant (mirrors the notification-channel
 * convention).
 *
 * The outbound leg reuses the proven notification-channel DTO shapes
 * (`ChannelSendInput` / `ChannelSendResult` / `ChannelTargetConfig` /
 * `ChannelVerification`) so we neither fork the send path nor overload
 * the notifications contract. The inbound leg is defined here as
 * **interface + types only** — the routing/pairing/session runtime
 * (`ConnectorRoutingService`) lands in a later increment (P2). The
 * first connector (`slack-connector`) implements the outbound leg;
 * inbound methods are optional and omitted until P2.
 */

/** How inbound events arrive for a connector. */
export type ConnectorInboundTransport = 'webhook' | 'poll' | 'socket';

/** Which directions a connector actually implements. */
export type ConnectorDirection = 'outbound' | 'inbound' | 'bidirectional';

/**
 * How an inbound message is dispatched once the sender is paired.
 * v1 routes to a single `defaultAgentId`; `team` and `chat` fold in
 * as the Teams surface + chat-everything engine wiring land (P2+).
 */
export type ConnectorRoutingMode = 'agent' | 'team' | 'chat';

/** Lifecycle of an external-identity ↔ platform-user pairing. */
export type ConnectorPairingState = 'pending' | 'paired' | 'revoked';

/**
 * Static capability flags a connector advertises (drives UI + routing).
 * A connector with only `outboundMessage` is a strict superset of an
 * outbound notification channel; the inbound flags are what make it a
 * connector rather than a channel.
 */
export interface ConnectorCapabilityFlags {
	/** Can send a chat/message (reuses `ChannelSendInput`). */
	readonly outboundMessage: boolean;
	/** Can `createRecord()` a structured object (Notion page, CRM row). */
	readonly outboundRecord: boolean;
	/** Can receive + route inbound events. */
	readonly inbound: boolean;
	/** Can `reply()` into an inbound conversation/thread. */
	readonly reply: boolean;
	/** First inbound contact from an external identity needs a pairing code. */
	readonly pairing: boolean;
	/** Supports `ChannelRichPayload` on outbound. */
	readonly richOutbound: boolean;
}

/** Provider-agnostic connector metadata declared by every connector. */
export interface ConnectorMetadata {
	readonly direction: ConnectorDirection;
	readonly transport: ConnectorInboundTransport;
	readonly flags: ConnectorCapabilityFlags;
}

/** A raw inbound HTTP delivery handed to verify/challenge/parse. */
export interface ConnectorInboundRequest {
	/** Raw, unparsed body — required for signature verification. */
	readonly rawBody: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
}

/** Outcome of `verifyInbound` — fail-closed (`valid: false`) by default. */
export interface ConnectorInboundVerification {
	readonly valid: boolean;
	readonly reason?: string;
}

/**
 * Provider handshake short-circuit (Slack `url_verification`,
 * Discord `PING`). Returned verbatim by the inbound route before any
 * parsing/routing happens.
 */
export interface ConnectorChallengeResponse {
	readonly status: number;
	readonly body: unknown;
}

/** Normalized inbound event (provider-agnostic). */
export interface ConnectorInboundEvent {
	readonly kind: 'message' | 'command' | 'reaction' | 'record-changed' | 'membership';
	/** Slack `channel[:thread_ts]`, Discord channel id, WhatsApp `wa_id`. */
	readonly externalConversationId: string;
	readonly externalUserId: string;
	readonly externalUserHandle?: string;
	readonly text: string;
	/** Idempotency key for inbound dedupe (Slack `event_id`, …). */
	readonly providerEventId: string;
	readonly receivedAt: Date;
	readonly rich?: unknown;
	readonly raw?: Readonly<Record<string, unknown>>;
}

/** Threaded reply back into an inbound conversation. */
export interface ConnectorReply {
	readonly externalConversationId: string;
	readonly text: string;
	readonly rich?: ChannelSendInput['rich'];
	readonly inReplyToProviderEventId?: string;
}

/** Structured record write (Notion page / CRM object). */
export interface ConnectorRecordInput {
	/** Notion database id / CRM object type. */
	readonly collection: string;
	readonly fields: Readonly<Record<string, unknown>>;
	readonly idempotencyKey: string;
}

export interface ConnectorRecordResult {
	readonly provider: string;
	readonly recordId: string;
}

/** Poll-mode pull for transports without webhooks (Notion). */
export interface ConnectorPollResult {
	readonly events: readonly ConnectorInboundEvent[];
	readonly cursor: string | null;
}

/**
 * Per-call attribution + facade-resolved settings handed to every
 * connector call. Mirrors `ChannelOptions` — the facade fills
 * `target` from `connectors.targetConfig` so plugins never touch the
 * DB directly.
 */
export interface ConnectorCallOptions {
	readonly userId?: string;
	readonly connectorId?: string;
	readonly agentId?: string;
	/** Resolved per-connection config (bot token, signing secret, …). */
	readonly target?: ChannelTargetConfig;
	readonly settings?: Readonly<Record<string, unknown>>;
}

/**
 * Connector plugin contract — a bidirectional superset of
 * `INotificationChannelPlugin`.
 *
 * Implementations declare `PLUGIN_CAPABILITIES.CONNECTOR` (umbrella)
 * plus the provider-specific constant (`CONNECTOR_SLACK` etc.).
 *
 * Outbound (`verifyConnection` + `send`) is required. `createRecord`
 * and every inbound method are optional — an outbound-only connector
 * (P1 Slack) omits them and is a strict superset of an outbound
 * channel; the inbound methods (P2+) are what make it a connector.
 */
export interface IConnectorPlugin extends IPlugin {
	/** Static direction/transport/flags declaration (drives UI + routing). */
	readonly connector: ConnectorMetadata;

	// --- OUTBOUND ---

	/**
	 * Validate the per-connection config (bot token has post
	 * permissions, signing secret present, …). Called by the "Test"
	 * button + the add-connector wizard.
	 */
	verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification>;

	/**
	 * Deliver one outbound message. MUST be idempotent on
	 * `message.messageRef`, scoped to `connectorId` + conversation.
	 */
	send(message: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult>;

	/** Optional: write a structured record (Notion/CRM). */
	createRecord?(record: ConnectorRecordInput, options: ConnectorCallOptions): Promise<ConnectorRecordResult>;

	// --- INBOUND (omit for outbound-only connectors; runtime lands P2) ---

	/**
	 * Verify a signed HTTP delivery. MUST fail closed (`valid: false`)
	 * when the signature is missing/invalid or the timestamp skew is
	 * out of bounds.
	 */
	verifyInbound?(req: ConnectorInboundRequest, options: ConnectorCallOptions): Promise<ConnectorInboundVerification>;

	/** Short-circuit provider handshakes (Slack `url_verification`, Discord `PING`). */
	handleChallenge?(req: ConnectorInboundRequest): ConnectorChallengeResponse | null;

	/** Normalize a verified delivery into provider-agnostic events. */
	parseInbound?(
		req: ConnectorInboundRequest,
		options: ConnectorCallOptions
	): Promise<readonly ConnectorInboundEvent[]>;

	/** Poll-mode pull for transports without webhooks. */
	poll?(cursor: string | null, options: ConnectorCallOptions): Promise<ConnectorPollResult>;

	/** Reply into the originating inbound conversation/thread. */
	reply?(reply: ConnectorReply, options: ConnectorCallOptions): Promise<ChannelSendResult>;

	/** Optional per-send pricing for spend roll-ups. */
	getPricing?(): PluginPricing | Promise<PluginPricing>;
}

/**
 * Type guard — narrow an `IPlugin` to `IConnectorPlugin` via the
 * umbrella capability declaration.
 */
export function isConnectorPlugin(plugin: IPlugin): plugin is IConnectorPlugin {
	return plugin.capabilities.includes('connector');
}

/* -------------------------------------------------------------------------- */
/* Routing / pairing / session concepts (contract-only; runtime lands in P2). */
/* -------------------------------------------------------------------------- */

/**
 * The components of a per-conversation session key. Each external
 * conversation is an isolated chat session so there is no context
 * bleed across conversations, users, or connectors — a Slack thread,
 * a Slack DM, and a Discord channel are three separate sessions even
 * for the same paired platform user.
 */
export interface ConnectorSessionKeyParts {
	readonly platformUserId: string;
	readonly connectorId: string;
	readonly externalConversationId: string;
}

/**
 * Build the composite `{platformUserId}:{connectorId}:{externalConversationId}`
 * session key. Pure helper so both the routing service and tests
 * derive the key the same way.
 */
export function buildConnectorSessionKey(parts: ConnectorSessionKeyParts): string {
	return `${parts.platformUserId}:${parts.connectorId}:${parts.externalConversationId}`;
}

/**
 * Context handed to the (future) facade-level inbound handler —
 * `ConnectorFacadeService.handleInbound` → `ConnectorRoutingService`.
 * Interface-only in this increment.
 */
export interface ConnectorRouteContext {
	readonly connectorId: string;
	readonly routingMode: ConnectorRoutingMode;
	readonly platformUserId: string;
	readonly sessionKey: string;
	readonly defaultAgentId?: string;
	readonly defaultTeamId?: string;
}

/** Outcome of routing one inbound event to an Agent/Team/chat session. */
export interface ConnectorRouteResult {
	readonly handled: boolean;
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly reply?: ConnectorReply;
}

/**
 * The `handleInbound(event) → route to Agent/Team` signature. Owned by
 * the facade/routing layer (not the plugin) so the facade has no hard
 * dep on the chat engine. Defined here as a shared contract type; the
 * implementation lands in P2.
 */
export type ConnectorInboundHandler = (
	event: ConnectorInboundEvent,
	ctx: ConnectorRouteContext
) => Promise<ConnectorRouteResult>;

/** Context for the pairing-code authz hook. */
export interface ConnectorPairingContext {
	readonly connectorId: string;
	readonly externalUserId: string;
	readonly externalUserHandle?: string;
}

/**
 * Decision returned by the pairing-code authorizer. First inbound
 * contact from an unknown external identity never reaches an Agent —
 * it must present a valid, single-use, short-lived pairing code first.
 */
export type ConnectorAuthorizationDecision =
	| { readonly authorized: true; readonly platformUserId: string; readonly identityState: ConnectorPairingState }
	| { readonly authorized: false; readonly reason: string; readonly prompt?: string };

/**
 * The pairing-code authz hook signature — resolves whether an inbound
 * event may act, and for which platform user. Owned by the routing
 * layer; contract-only here (runtime lands in P2).
 */
export type ConnectorPairingAuthorizer = (
	event: ConnectorInboundEvent,
	ctx: ConnectorPairingContext
) => Promise<ConnectorAuthorizationDecision>;
