/**
 * Model accounts and the model ladder (AW-16) — wire types shared by the API,
 * the web client and the agent runtime.
 *
 * Two nouns live here:
 *
 * - A **Model Account** is one set of credentials for one AI-provider plugin,
 *   held by a workspace, with a name and a position. Several may exist for the
 *   same provider; the position is the order they are used in.
 * - A **Model Policy** is the routing decision at one scope (workspace, Agent
 *   or schedule): a primary model, fallbacks, a reasoning effort and a run
 *   timeout. Every field is independently optional so a narrower scope can set
 *   one field and inherit the rest.
 *
 * Providers are never listed here. The set of providers is whatever installed
 * plugin declares the `ai-provider` capability, and a provider's credential
 * fields are the secret fields its own settings schema declares.
 *
 * Zero-dependency value types only.
 */

/** How hard a model should think before answering. `medium` is the default. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

/** The scopes a Model Policy can be stored at, widest first. */
export const MODEL_POLICY_SCOPE_TYPES = ['workspace', 'agent', 'schedule'] as const;
export type ModelPolicyScopeType = (typeof MODEL_POLICY_SCOPE_TYPES)[number];

/**
 * Which recurring definition a schedule-scoped policy belongs to. The same
 * source vocabulary the unified schedule list uses, so a schedule row's
 * synthetic key (`${source}:${ownerId}`) addresses its policy directly.
 */
export const MODEL_POLICY_SCHEDULE_SOURCES = [
	'recurring_task',
	'agent_heartbeat',
	'work_schedule',
	'mission_tick',
	'source_validation',
	'data_sync',
	'inbound_trigger'
] as const;
export type ModelPolicyScheduleSource = (typeof MODEL_POLICY_SCHEDULE_SOURCES)[number];

/** A Model Account's health. `paused` is the owner's choice, never an error. */
export const MODEL_ACCOUNT_HEALTH_STATES = ['working', 'expiring', 'expired', 'invalid', 'paused', 'unknown'] as const;
export type ModelAccountHealth = (typeof MODEL_ACCOUNT_HEALTH_STATES)[number];

/** Every number the model ladder is bounded by. */
export const MODEL_ROUTING_LIMITS = {
	accountsPerProvider: 8,
	accountsPerWorkspace: 32,
	accountLabelMaxLength: 60,
	fallbackEntriesPerPolicy: 3,
	attemptsPerCall: 6,
	runTimeoutSeconds: { default: 900, min: 60, max: 7200 },
	attemptTimeoutSeconds: { default: 120, min: 15, max: 600 },
	expiringWithinDays: 14,
	bannerWithinDays: 3,
	probeIntervalHours: 6,
	/** A policy or account change binds on the next call within this window. */
	changePropagationMs: 5000
} as const;

/** A provider and a model id together. */
export interface ModelChainEntry {
	providerPluginId: string;
	modelId: string;
	/** True when the id was not in the provider's visible catalogue at save time. */
	unverified?: boolean;
}

/**
 * A model choice where either half may be absent — the shape an Agent's own
 * provider/model pair has always had (a provider with its default model, or a
 * model on whichever provider resolves).
 */
export interface ModelSelection {
	providerPluginId: string | null;
	modelId: string | null;
}

/**
 * One Model Account as any member may see it. Deliberately carries no
 * credential field of any kind — not the value, not a mask, not a hash.
 */
export interface ModelAccountView {
	id: string;
	providerPluginId: string;
	providerName: string;
	label: string;
	/** 1..N within its provider. The order the accounts are used in. */
	position: number;
	health: ModelAccountHealth;
	enabled: boolean;
	/** ISO timestamps, or null when unknown / never. */
	credentialExpiresAt: string | null;
	lastUsedAt: string | null;
	lastCheckedAt: string | null;
	cooldownUntil: string | null;
	createdAt: string;
	updatedAt: string;
}

/** One credential field a provider's settings schema declares as secret. */
export interface ModelCredentialField {
	key: string;
	title: string;
	description: string | null;
}

/** An installed AI-provider plugin, as the accounts surface lists it. */
export interface ModelProviderView {
	providerPluginId: string;
	providerName: string;
	credentialFields: ModelCredentialField[];
	/** False when the provider declares no secret field, so an account has nothing to hold. */
	acceptsAccounts: boolean;
	accountCount: number;
}

/** A stored Model Policy for one scope. `null` on a field means "inherit". */
export interface ModelPolicyView {
	scopeType: ModelPolicyScopeType;
	/** Null for the workspace; the Agent id or the schedule owner id otherwise. */
	scopeId: string | null;
	/** Only for schedule scope. */
	scopeVariant: ModelPolicyScheduleSource | null;
	/**
	 * The primary model this scope sets. For an Agent this is the Agent's own
	 * provider/model pair, so there is exactly one place an Agent's model lives.
	 */
	primaryModel: ModelSelection | null;
	/** Null = inherit, [] = explicitly no fallbacks. */
	fallbackModels: ModelChainEntry[] | null;
	reasoningEffort: ReasoningEffort | null;
	runTimeoutSeconds: number | null;
	attemptTimeoutSeconds: number | null;
	updatedAt: string | null;
}

/** Where a resolved field's value came from. */
export type ModelPolicyFieldSource = 'schedule' | 'agent' | 'workspace' | 'default';

export interface ResolvedModelPolicyField<T> {
	value: T;
	source: ModelPolicyFieldSource;
}

/**
 * The policy the runtime would use for one call, with the source of every
 * field. A `default` primary means the call keeps today's resolution: the
 * Work's selected plugin, then the provider plugin's own settings.
 */
export interface ResolvedModelPolicy {
	primaryModel: ResolvedModelPolicyField<ModelSelection | null>;
	fallbackModels: ResolvedModelPolicyField<ModelChainEntry[]>;
	reasoningEffort: ResolvedModelPolicyField<ReasoningEffort>;
	runTimeoutSeconds: ResolvedModelPolicyField<number>;
	attemptTimeoutSeconds: ResolvedModelPolicyField<number>;
}

/** How one model attempt inside a call ended. */
export const MODEL_ATTEMPT_RESULTS = [
	'ok',
	'rate_limited',
	'credential',
	'transient',
	'context_too_large',
	'fatal'
] as const;
export type ModelAttemptResult = (typeof MODEL_ATTEMPT_RESULTS)[number];

/** How a routed call as a whole ended. */
export const MODEL_ROUTING_OUTCOMES = ['answered', 'timeout', 'exhausted', 'budget-blocked', 'fatal'] as const;
export type ModelRoutingOutcome = (typeof MODEL_ROUTING_OUTCOMES)[number];

export interface AgentRunModelRoutingAttempt {
	provider: string;
	model: string;
	accountLabel?: string;
	result: ModelAttemptResult;
	ms: number;
}

/**
 * What actually answered a Run — stored on the Run itself. Written from the
 * provider's own response (the model id it reports), never from configuration.
 * Never carries a credential value, whole or partial.
 */
export interface AgentRunModelRouting {
	/** Plugin id that answered. */
	provider: string;
	/** Model id the provider reported answering with. */
	model: string;
	/** Null/absent when the plugin's own settings answered (no Model Account). */
	accountId?: string | null;
	accountLabel?: string | null;
	/** The effort that was requested for this Run, or `not-applicable`. */
	effort: ReasoningEffort | 'not-applicable';
	/**
	 * Whether the effort was sent to the provider. Reasoning control is not
	 * applied yet, so this is false and the effort is a record of intent.
	 */
	effortApplied?: boolean;
	runTimeoutSeconds: number;
	outcome: ModelRoutingOutcome;
	attempts: AgentRunModelRoutingAttempt[];
	truncatedAtAttemptCeiling?: boolean;
	/** Which scope chose the primary model. `request` = the call named its own. */
	primarySource?: ModelPolicyFieldSource | 'request';
	/**
	 * The model id the ladder asked for, when it chose one — kept beside the
	 * id the provider reported so a Run in flight keeps asking for the same
	 * model after a policy change.
	 */
	resolvedModel?: string | null;
	/** ISO time the record was last written. */
	recordedAt?: string;
}
