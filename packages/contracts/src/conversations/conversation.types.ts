/**
 * Conversations — the vocabulary shared by the API, the agent package and the
 * web app for named conversations with an Agent.
 *
 * A Conversation already exists (one person, an optional machine title, a
 * provider and a model). These types add what an owner needs to talk to a
 * specific Agent and trust what happened to a message: a *kind*, the
 * *participants* (a person or an Agent), who *authored* a message, whether it
 * was *sent*, and what became of each Agent it was addressed to.
 *
 * Every numeric limit an owner can hit lives here as a named constant, so the
 * server that enforces it and the composer that warns about it read one value.
 */

/**
 * `direct` — one person and at most one Agent. The existing assistant thread
 * (no Agent) is a `direct` Conversation with no address, and keeps working.
 * `group` — one person and 2–8 Agents. `organization_channel` — one per
 * Organization. `agent_pair` — two Agents, with the person as an observer.
 */
export const CONVERSATION_KINDS = ['direct', 'group', 'organization_channel', 'agent_pair'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** A person's message: `sending` → `sent`, or `failed` with a reason. An Agent's is `sent` on write. */
export const CONVERSATION_MESSAGE_STATUSES = ['sending', 'sent', 'failed'] as const;
export type ConversationMessageStatus = (typeof CONVERSATION_MESSAGE_STATUSES)[number];

/** Who wrote a message. `role` on the message still says what the model sees. */
export const CONVERSATION_AUTHOR_TYPES = ['user', 'agent', 'system'] as const;
export type ConversationAuthorType = (typeof CONVERSATION_AUTHOR_TYPES)[number];

/** What became of one Agent a message was addressed to. */
export const CONVERSATION_REACH_OUTCOMES = ['delivered', 'queued', 'skipped', 'refused'] as const;
export type ConversationReachOutcome = (typeof CONVERSATION_REACH_OUTCOMES)[number];

export const CONVERSATION_PARTICIPANT_TYPES = ['user', 'agent'] as const;
export type ConversationParticipantType = (typeof CONVERSATION_PARTICIPANT_TYPES)[number];

export const CONVERSATION_PARTICIPANT_ROLES = ['owner', 'member', 'observer'] as const;
export type ConversationParticipantRole = (typeof CONVERSATION_PARTICIPANT_ROLES)[number];

/** `user` — a person named it, and automatic titling never touches it again. */
export const CONVERSATION_TITLE_SOURCES = ['user', 'auto'] as const;
export type ConversationTitleSource = (typeof CONVERSATION_TITLE_SOURCES)[number];

/** The one object a Conversation may be about, fixed at creation. */
export const CONVERSATION_CONTEXT_TYPES = ['mission', 'task', 'work', 'idea', 'agent'] as const;
export type ConversationContextType = (typeof CONVERSATION_CONTEXT_TYPES)[number];

/**
 * Why a person's message did not send. Stable machine tokens — the composer
 * maps each to plain-language copy, never shows the token itself.
 *
 * `capacity_limited` — the run dispatch gate would not start a reply right now
 * (too many runs in flight, or runs are paused); nothing retries it on its
 * own, so the person can Retry once capacity frees. `budget_exceeded` — a
 * spending limit refused the reply: the Agent's budget, or the account's
 * credits.
 */
export const CONVERSATION_FAILURE_CODES = [
	'rate_limited',
	'provider_unavailable',
	'network',
	'too_large',
	'secret_detected',
	'forbidden',
	'capacity_limited',
	'budget_exceeded'
] as const;
export type ConversationFailureCode = (typeof CONVERSATION_FAILURE_CODES)[number];

/** Message bodies are short by intent; longer material goes in an attachment (FR-37). */
export const MAX_CONVERSATION_BODY_BYTES = 16 * 1024;
/** Resolved mentions carried by one message; later `@` tokens stay plain text (FR-31). */
export const MAX_MENTIONS_PER_MESSAGE = 10;
/** Attachments on one message (FR-35). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Agents in one group Conversation (FR-53). */
export const MAX_GROUP_AGENTS = 8;
/** Reply executions started from one message; the rest are recorded as queued (FR-90). */
export const MAX_DISPATCH_PER_MESSAGE = 8;
/** Active Agents above which an organization channel post is refused (FR-71). */
export const MAX_BROADCAST_AGENTS = 200;
/** Messages carried into a group created from a direct Conversation (FR-50). */
export const PROMOTION_CARRY_MESSAGES = 20;
/** Days of history carried into a group created from a direct Conversation (FR-50). */
export const PROMOTION_CARRY_DAYS = 7;
/** Consecutive Agent-authored messages after which an Agent pair pauses (FR-82). */
export const AGENT_PAIR_STREAK_CEILING = 20;
/** Agent-authored Agent-pair messages per Organization per day (FR-84). */
export const AGENT_PAIR_DAILY_MESSAGE_CEILING = 200;
/** Longest name a person may give a Conversation (FR-5). */
export const CONVERSATION_NAME_MAX = 200;
/** Candidates the mention picker returns for one query (FR-26). */
export const MAX_MENTION_CANDIDATES = 8;
/** Default page of a Conversation list (FR-12). */
export const CONVERSATION_LIST_DEFAULT_LIMIT = 50;
/** Largest page of a Conversation list a client may ask for (FR-12). */
export const CONVERSATION_LIST_MAX_LIMIT = 200;
/** Longest client-generated message identifier accepted for retry idempotency (FR-41). */
export const CONVERSATION_CLIENT_MESSAGE_ID_MAX = 64;

/** A resolved mention, stored on the message. Same shape Task comments already store. */
export interface ConversationMention {
	type: 'user' | 'agent' | 'kb';
	id?: string;
	slug?: string;
}

/** An uploaded file attached to a message. */
export interface ConversationAttachmentRef {
	uploadId: string;
}

/**
 * An attachment as a message is read back: the stored reference plus what a
 * person needs to see and reopen the file. The details are resolved from the
 * upload when the message is read — never stored on the message — and are
 * `null` when the upload is no longer readable in this workspace. Optional:
 * older API builds send the bare reference.
 */
export interface ConversationAttachmentView extends ConversationAttachmentRef {
	/** The file's original name. */
	filename?: string | null;
	mimeType?: string | null;
	/** Same-origin, owner-gated URL that opens the file (`/api/uploads/…`). */
	url?: string | null;
}

/** One entry of a message's delivery record. */
export interface ConversationReach {
	agentId: string;
	outcome: ConversationReachOutcome;
	/**
	 * Why, as a short machine token: the queue reason for `queued`, the Agent
	 * status for `skipped`, the refusing rule for `refused` (including the run
	 * dispatch gate's own reason when it would not start the reply), and
	 * `steered` when a `delivered` message went into a run that was already in
	 * progress.
	 */
	reason?: string | null;
	/** The run that will answer, when one was created or steered. */
	runId?: string | null;
}

export interface ConversationParticipantView {
	participantType: ConversationParticipantType;
	participantId: string;
	role: ConversationParticipantRole;
	joinedAt: string;
	leftAt: string | null;
	lastReadMessageId: string | null;
	lastReadAt: string | null;
}

export interface ConversationMessageView {
	id: string;
	conversationId: string;
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	authorType: ConversationAuthorType;
	authorId: string | null;
	mentions: ConversationMention[] | null;
	attachments: ConversationAttachmentView[] | null;
	status: ConversationMessageStatus;
	failureCode: ConversationFailureCode | null;
	clientMessageId: string | null;
	replyToMessageId: string | null;
	createdAt: string;
}

export interface ConversationSummaryView {
	id: string;
	kind: ConversationKind;
	agentId: string | null;
	/** The name a person gave it, or the automatic title; `null` renders the preview instead. */
	title: string | null;
	titleSource: ConversationTitleSource | null;
	contextType: ConversationContextType | null;
	contextId: string | null;
	lastMessageAt: string | null;
	unreadCount: number;
	/**
	 * The first message a person wrote, shortened. A row with no `title`
	 * renders this instead — never "Untitled" (FR-4). Optional: older API
	 * builds do not send it.
	 */
	preview?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ConversationMentionCandidate {
	type: 'agent' | 'user';
	id: string;
	slug: string;
	name: string;
	status: string | null;
}

/** Response of a person's send: the stored message and what each addressed Agent got. */
export interface ConversationSendResult {
	message: ConversationMessageView;
	reach: ConversationReach[];
	/** `true` when the client id had already been stored and the first message was returned. */
	duplicate: boolean;
}

/** Server-sent event pushed on the Conversation stream. */
export interface ConversationStreamEvent {
	type: 'message';
	conversationId: string;
	message: ConversationMessageView;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isConversationKind(value: unknown): value is ConversationKind {
	return includes(CONVERSATION_KINDS, value);
}

export function isConversationContextType(value: unknown): value is ConversationContextType {
	return includes(CONVERSATION_CONTEXT_TYPES, value);
}

export function isConversationReachOutcome(value: unknown): value is ConversationReachOutcome {
	return includes(CONVERSATION_REACH_OUTCOMES, value);
}

export function isConversationFailureCode(value: unknown): value is ConversationFailureCode {
	return includes(CONVERSATION_FAILURE_CODES, value);
}

/** UTF-8 byte length — the unit {@link MAX_CONVERSATION_BODY_BYTES} is measured in. */
export function conversationBodyBytes(body: string): number {
	return new TextEncoder().encode(body).length;
}

/**
 * Only Conversations one person owns outright are removed by "delete all my
 * conversations". The organization channel and Agent pairs are shared records
 * and are never swept away by one member (FR-102).
 */
export function isPersonallyDeletableConversationKind(kind: ConversationKind): boolean {
	return kind === 'direct' || kind === 'group';
}
