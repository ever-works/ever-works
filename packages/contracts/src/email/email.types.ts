/**
 * Agent email (AW-05) — wire types for the approve-before-send gate and the
 * send ceilings.
 *
 * The `email_messages` table already records every message an Agent sends
 * or receives. What it could not say before is WHERE an outbound message is
 * in its life: written but not yet approved, on its way to the provider,
 * gone, or refused. {@link EmailMessageStatus} is that axis. Rows written
 * before the column existed are backfilled (`sent` for outbound, `received`
 * for inbound), so every reader can treat the value as present.
 */

export type EmailMessageStatus =
	| 'received'
	| 'draft'
	| 'revising'
	| 'scheduled'
	| 'sending'
	| 'sent'
	| 'failed'
	| 'escalated'
	| 'discarded'
	| 'blocked';

/** Append only — the order feeds `@IsIn` validators. */
export const EMAIL_MESSAGE_STATUSES: readonly EmailMessageStatus[] = [
	'received',
	'draft',
	'revising',
	'scheduled',
	'sending',
	'sent',
	'failed',
	'escalated',
	'discarded',
	'blocked'
];

/**
 * How an Agent inbox treats mail its Agent writes.
 *
 * - `draft-review` — nothing the Agent writes leaves until a person approves
 *   it. Enforced in the send path on the server, not by instructions to the
 *   model.
 * - `auto-send` — the Agent may send on its own, still inside every send
 *   ceiling.
 */
export type AgentInboxMode = 'draft-review' | 'auto-send';

export const AGENT_INBOX_MODES: readonly AgentInboxMode[] = ['draft-review', 'auto-send'];

/** Mode a newly created inbox starts in: nothing sends without a person. */
export const AGENT_INBOX_DEFAULT_MODE: AgentInboxMode = 'draft-review';

export type AgentInboxState = 'active' | 'cap-paused' | 'suspended' | 'released';

export const AGENT_INBOX_STATES: readonly AgentInboxState[] = ['active', 'cap-paused', 'suspended', 'released'];

/**
 * Who asked for a send. Set by SERVER code at the call site — never read from
 * a request body — because the approval gate keys on it.
 *
 * - `agent`  — an Agent tool call (`sendEmail`, `messageAgent`) or the release
 *   of a draft an Agent wrote. Subject to the inbox mode.
 * - `human`  — a person composing from the product. A person is the approver,
 *   so the draft gate does not apply; every send ceiling still does.
 * - `system` — platform mail (verification and the like).
 */
export type EmailSendOrigin = 'agent' | 'human' | 'system';

export const EMAIL_SEND_ORIGINS: readonly EmailSendOrigin[] = ['agent', 'human', 'system'];

/** Which ceiling a refused send hit. */
export type EmailSendCapLimitKind =
	| 'recipientsPerMessage'
	| 'inboxBurst'
	| 'inboxRecipients'
	| 'inboxDaily'
	| 'workspaceDaily'
	| 'workspaceMonthly';

/** Evaluation order — the first ceiling a send breaks is the one reported. */
export const EMAIL_SEND_CAP_LIMIT_KINDS: readonly EmailSendCapLimitKind[] = [
	'recipientsPerMessage',
	'inboxBurst',
	'inboxRecipients',
	'inboxDaily',
	'workspaceDaily',
	'workspaceMonthly'
];

export type EmailSendCapScope = 'message' | 'inbox' | 'workspace';

/**
 * A ceiling as configured at one scope.
 *
 * - `null` / absent → inherit from the scope above.
 * - `0`             → no ceiling for this limit (explicitly unrestricted).
 * - a positive int  → that ceiling.
 */
export interface EmailSendCapsOverride {
	inboxDailySends?: number | null;
	inboxBurstSends?: number | null;
	inboxBurstRecipients?: number | null;
	recipientsPerMessage?: number | null;
	workspaceDailySends?: number | null;
	workspaceMonthlySends?: number | null;
}

/** The fields an Agent inbox may override for itself — never the workspace ones. */
export const EMAIL_INBOX_CAP_FIELDS = [
	'inboxDailySends',
	'inboxBurstSends',
	'inboxBurstRecipients',
	'recipientsPerMessage'
] as const satisfies readonly (keyof EmailSendCapsOverride)[];

export const EMAIL_SEND_CAP_FIELDS = [
	...EMAIL_INBOX_CAP_FIELDS,
	'workspaceDailySends',
	'workspaceMonthlySends'
] as const satisfies readonly (keyof EmailSendCapsOverride)[];

export type EmailSendCapField = (typeof EMAIL_SEND_CAP_FIELDS)[number];

/** Resolved ceilings. `null` = no ceiling. */
export type ResolvedEmailSendCaps = Record<EmailSendCapField, number | null>;

/** Which scope decided each resolved ceiling. */
export type EmailSendCapSource = 'platform' | 'organization' | 'inbox';

/**
 * Organization-level email sending policy (stored on the organization).
 * Every field is optional; absence inherits the platform default.
 */
export interface EmailSendPolicyOverride {
	/**
	 * Mode for Agents in this organization that have no inbox settings of
	 * their own. Absent = the platform default.
	 */
	defaultMode?: AgentInboxMode | null;
	caps?: EmailSendCapsOverride | null;
}

export interface EmailCapWindowDto {
	kind: EmailSendCapLimitKind;
	scope: EmailSendCapScope;
	/** Sends (or distinct recipients, for `inboxRecipients`) counted in the window. */
	used: number;
	/** `null` = no ceiling. */
	cap: number | null;
	/** `0` for `recipientsPerMessage`, which is not a time window. */
	windowSeconds: number;
	source: EmailSendCapSource;
}

/**
 * A live reading of an Agent's send ceilings — what the inbox page renders
 * and what a refusal is explained with. Counts come from persisted message
 * rows, never from anything a model wrote.
 */
export interface EmailCapMeterDto {
	agentId: string;
	/** `false` when the operator has turned ceilings off for this deployment. */
	enforced: boolean;
	mode: AgentInboxMode;
	modeSource: EmailSendCapSource;
	windows: EmailCapWindowDto[];
	/** ISO time the inbox's rolling-24h ceiling frees up again, when it is currently full. */
	pausedUntil: string | null;
}

export interface AgentInboxDto {
	id: string;
	agentId: string;
	emailAddressId: string | null;
	mode: AgentInboxMode;
	state: AgentInboxState;
	caps: Pick<EmailSendCapsOverride, (typeof EMAIL_INBOX_CAP_FIELDS)[number]>;
	capPausedUntil: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Details carried on a refused send (HTTP 429). */
export interface EmailSendCapExceededDetails {
	scope: EmailSendCapScope;
	limitKind: EmailSendCapLimitKind;
	used: number;
	cap: number;
	windowSeconds: number;
	/** Seconds until the send could succeed; `0` when waiting will not help. */
	retryAfterSeconds: number;
	agentId?: string;
}
