/**
 * Inbox (operator message center) — wire types.
 *
 * One surface where agents / works / the system put messages FOR the
 * human: blocking questions (the run idles until the reply, and the
 * reply resumes it), approval requests, escalations and FYI notices.
 * The `inbox_items` entity in `@ever-works/agent` persists these; this
 * file is the client-safe projection plus the option-normalization
 * shared by the `askHuman` agent tool and the API edge.
 *
 * Sources: `agent-run` (the in-process `askHuman` tool), `escalation`,
 * `proposal`, `system`, `work`, and — self-build slice Q — `fleet-run`:
 * a question a run executing on one of the owner's OWN machines asked by
 * writing `.ever-works/QUESTION.md`. A fleet question carries
 * `sourceMeta` (node, branch, Task title, PR) so the Inbox can say WHERE
 * it came from without the web parsing it out of the body.
 *
 * Distinct from the HITL question payloads next door (`../hitl`): those
 * are the typed canvas payloads rendered inside a Task detail. An inbox
 * item is a MESSAGE — one flat option list, one reply box — so it keeps
 * the deliberately smaller shape the founder screenshots show.
 */

export type InboxItemKind =
	| 'question'
	| 'approval'
	| 'escalation'
	| 'notice'
	// Integration inbox push (`origin: 'integration'`): kinds another product's
	// Inbox has (Ever Gauzy first) that no Ever Works producer writes.
	| 'mention'
	| 'assignment'
	| 'email'
	| 'other';

/** Appended in the order they shipped — the web mirror pins the sequence. */
export const INBOX_ITEM_KINDS: readonly InboxItemKind[] = [
	'question',
	'approval',
	'escalation',
	'notice',
	'mention',
	'assignment',
	'email',
	'other'
];

/**
 * The kinds an INTEGRATION may file (`POST /api/integrations/v1/inbox/items`).
 * `escalation` is not one of them: an escalation is an Ever Works agent giving
 * up, and answering it resolves an Ever Works record.
 */
export const INBOX_EXTERNAL_ITEM_KINDS: readonly InboxItemKind[] = [
	'notice',
	'question',
	'approval',
	'mention',
	'assignment',
	'email',
	'other'
];

/** The kinds an integration may give answer buttons (`choices`). */
export const INBOX_EXTERNAL_CHOICE_KINDS: readonly InboxItemKind[] = ['question', 'approval'];

/**
 * Who wrote the row: an Ever Works producer (`platform`, every row before the
 * integration inbox push) or an integration key (`integration`: an item another
 * product's Inbox put into the member's Ever Works Inbox).
 */
export type InboxItemOrigin = 'platform' | 'integration';

export const INBOX_ITEM_ORIGINS: readonly InboxItemOrigin[] = ['platform', 'integration'];

export type InboxItemStatus = 'open' | 'answered' | 'archived';

export const INBOX_ITEM_STATUSES: readonly InboxItemStatus[] = ['open', 'answered', 'archived'];

export type InboxItemSourceType =
	| 'agent-run'
	| 'escalation'
	| 'proposal'
	| 'system'
	| 'work'
	| 'fleet-run'
	// FL-05 (CONTRACTS R-12): a session on a computer that needs you — a question or a
	// permission request (the Decision), or a blocked / failed notice.
	| 'fleet-session'
	// Integration inbox push: an item an integration key filed (`origin: 'integration'`).
	// Its answer is stored on the item for the integration to read back; no run starts.
	| 'integration';

/** Appended in the order they shipped — the web spec pins the sequence. */
export const INBOX_ITEM_SOURCE_TYPES: readonly InboxItemSourceType[] = [
	'agent-run',
	'escalation',
	'proposal',
	'system',
	'work',
	'fleet-run',
	'fleet-session',
	'integration'
];

/**
 * Self-build slice Q — where a `fleet-run` question came from. Rendered
 * as plain chips by the web, never as markup. Every field is optional so
 * rows written by older producers (and every other source type) read
 * NULL; each string is capped by {@link normalizeInboxSourceMeta}.
 */
export interface InboxItemSourceMeta {
	nodeId?: string | null;
	nodeName?: string | null;
	/** Task branch the run pushed (or would have pushed) its work to. */
	branch?: string | null;
	taskTitle?: string | null;
	prUrl?: string | null;
	/** Set when the model asked from a mounted repository (`.mounts/<dir>`). */
	mountDir?: string | null;
	/** FL-05 — the session a `fleet-session` item is about. */
	sessionId?: string | null;
	sessionTitle?: string | null;
	/** `claude-code` · `codex` · … — rendered as the CLI's name. */
	provider?: string | null;
	/** The attention key (CONTRACTS §5.2): one identity for the card, this item and the notification. */
	attentionKey?: string | null;
}

/** Cap on every `InboxItemSourceMeta` string field. */
export const INBOX_SOURCE_META_MAX_FIELD_CHARS = 300;

const INBOX_SOURCE_META_FIELDS = [
	'nodeId',
	'nodeName',
	'branch',
	'taskTitle',
	'prUrl',
	'mountDir',
	// FL-05 — appended, never reordered.
	'sessionId',
	'sessionTitle',
	'provider',
	'attentionKey'
] as const;

/** Hard caps applied by writers (DoS + prompt-log guard). */
export const INBOX_MAX_TITLE_CHARS = 300;
export const INBOX_MAX_BODY_CHARS = 8000;
export const INBOX_MAX_OPTIONS = 12;
export const INBOX_MAX_OPTION_ID_CHARS = 64;
export const INBOX_MAX_OPTION_LABEL_CHARS = 200;
export const INBOX_MAX_REPLY_CHARS = 8000;

// ── Integration inbox push (`POST /api/integrations/v1/inbox/items`) ──────
//
// An integration (Ever Gauzy first) files ITS OWN Inbox items into a member's
// Ever Works Inbox. These caps are the contract's: the API refuses a value past
// them (`400 validation_failed`) instead of truncating it, so the integration
// never holds a copy that differs from the one Ever Works stored.

/** `externalId`: the integration's own id of the item, unique per tenant and key. */
export const INBOX_EXTERNAL_ID_MAX_CHARS = 128;
/** An integration item's body (markdown, stored and shown as plain text). */
export const INBOX_EXTERNAL_BODY_MAX_CHARS = 20_000;
/** `sourceUrl` (`https:` only). */
export const INBOX_SOURCE_URL_MAX_CHARS = 2000;
/** `sourceLabel`, the badge text (defaults to the integration's name). */
export const INBOX_SOURCE_LABEL_MAX_CHARS = 80;
/** `choices` of a `question` / `approval` from an integration. */
export const INBOX_EXTERNAL_MAX_CHOICES = 10;
/** `email.from` (one address, optionally with a display name). */
export const INBOX_EMAIL_FROM_MAX_CHARS = 320;
/** `email.to` (one or more addresses, as the integration wrote them). */
export const INBOX_EMAIL_TO_MAX_CHARS = 1000;
/** `email.subject`. */
export const INBOX_EMAIL_SUBJECT_MAX_CHARS = 300;
/** `email.receivedAt` (an ISO 8601 date-time). */
export const INBOX_EMAIL_RECEIVED_AT_MAX_CHARS = 64;

/**
 * The header block of a `kind: 'email'` item an integration filed: who sent
 * it, to whom, its subject and when it arrived. Plain text BY CONTRACT; the
 * web renders it as text, never as markup.
 */
export interface InboxItemEmailMeta {
	from: string;
	to?: string | null;
	subject: string;
	receivedAt: string;
}

/**
 * Normalize an untrusted email header block (a DB column, a request body that
 * already passed the API's validation) into a clean {@link InboxItemEmailMeta},
 * or `null` when `from` or `subject` is missing. Strings are trimmed and
 * capped; unknown keys are dropped.
 */
export function normalizeInboxEmailMeta(value: unknown): InboxItemEmailMeta | null {
	if (!isRecord(value)) return null;
	const text = (raw: unknown, max: number): string | null => {
		if (typeof raw !== 'string') return null;
		const trimmed = raw.trim();
		return trimmed ? trimmed.slice(0, max) : null;
	};
	const from = text(value.from, INBOX_EMAIL_FROM_MAX_CHARS);
	const subject = text(value.subject, INBOX_EMAIL_SUBJECT_MAX_CHARS);
	if (!from || !subject) return null;
	return {
		from,
		to: text(value.to, INBOX_EMAIL_TO_MAX_CHARS),
		subject,
		receivedAt: text(value.receivedAt, INBOX_EMAIL_RECEIVED_AT_MAX_CHARS) ?? ''
	};
}

/** Whitespace or a control character anywhere in a URL. */
const URL_UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;

/**
 * Whether `value` is a link an integration may attach to an inbox item: an
 * absolute `https:` URL of at most {@link INBOX_SOURCE_URL_MAX_CHARS}
 * characters, with a host and no embedded credentials. `javascript:`, `data:`,
 * `http:` and relative URLs are refused, and so is any whitespace or control
 * character (a browser strips some of them and would resolve another URL than
 * the one checked). The web checks again before it renders it (`safeHttpsUrl`).
 */
export function isSafeInboxSourceUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > INBOX_SOURCE_URL_MAX_CHARS) {
		return false;
	}
	if (URL_UNSAFE_CHARS.test(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** One structured answer button on a `question` / `approval` item. */
export interface InboxItemOption {
	/** Stable machine token returned in the reply. */
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Renderers may pre-select / highlight the recommended branch. */
	readonly recommended?: boolean;
}

/** Wire projection of one inbox item. Dates are ISO strings. */
export interface InboxItemDto {
	id: string;
	kind: InboxItemKind;
	title: string;
	body: string;
	options: InboxItemOption[] | null;
	sourceType: InboxItemSourceType;
	/** Fleet provenance (slice Q); optional on the wire so an older API may omit it. */
	sourceMeta?: InboxItemSourceMeta | null;
	agentId: string | null;
	agentRunId: string | null;
	taskId: string | null;
	workId: string | null;
	escalationId: string | null;
	proposalId: string | null;
	status: InboxItemStatus;
	unread: boolean;
	answeredAt: string | null;
	answerText: string | null;
	answerOptionId: string | null;
	/**
	 * When a human first opened the item (the first read flip or the
	 * answer, whichever came first). Optional on the wire so an older API
	 * may omit it; NULL = nobody has looked yet.
	 */
	firstViewedAt?: string | null;
	createdAt: string;
	updatedAt: string;
	// ── Integration inbox push. Optional on the wire: an older API omits them. ──
	/** `platform` (an Ever Works producer) or `integration` (filed by an integration key). */
	origin?: InboxItemOrigin;
	/** The badge text of an integration item, e.g. "Ever Gauzy". NULL for platform items. */
	sourceLabel?: string | null;
	/** The item in the integration's own app (`https:` only). NULL for platform items. */
	sourceUrl?: string | null;
	/** The header block of a `kind: 'email'` integration item. */
	email?: InboxItemEmailMeta | null;
	/** When it happened at the source, when the integration said so. */
	occurredAt?: string | null;
	/** The Goal an integration item is about. */
	goalId?: string | null;
}

// ── My Decisions — the decision view of the Inbox ──────────────────────
//
// A "decision" is not a second record: it is an Inbox item that asks the
// human to decide something — a question an agent is parked on, an
// approval an agent is waiting for, or an escalation where an agent gave
// up. The Inbox already mirrors every escalation and every pending
// approval (idempotent per record) and already routes the answer back to
// the record and the run, so My Decisions is the Inbox read through a
// ranking and a handful of filters, never a parallel queue.

/**
 * The Inbox kinds that ask the human to decide: not the FYI ones (`notice`,
 * and the integration push's `mention` / `assignment` / `email` / `other`).
 * An integration's `question` / `approval` IS a decision and shows in My Decisions.
 */
export const INBOX_DECISION_KINDS: readonly InboxItemKind[] = ['question', 'approval', 'escalation'];

/** Default page of the decision view. */
export const INBOX_DECISION_PAGE_SIZE = 25;

/** Largest page a caller may request; larger values are refused by the API edge. */
export const INBOX_DECISION_MAX_LIMIT = 100;

/**
 * Rank used for a decision nobody scored. Only escalations carry a
 * confidence; an unscored decision sorts as if the platform were
 * half-sure, above a weak score and below a strong one, and is shown as
 * "not scored" rather than as a percentage.
 */
export const INBOX_DECISION_UNSCORED_RANK = 0.5;

/** An open decision older than this, with no live work behind it, is flagged dormant (never auto-archived). */
export const INBOX_DECISION_DORMANT_AFTER_DAYS = 30;

/** No decision raised within this window reads as "quiet" rather than "all clear". */
export const INBOX_DECISION_QUIET_WINDOW_DAYS = 14;

/** Why an open decision is holding work back. */
export type InboxDecisionBlockingReason = 'run-parked' | 'task-blocked';

/**
 * What the decision view adds to an Inbox item — read at list time from
 * the records the item already links to (the run, the Task, the
 * escalation, the proposal, the Agent). Nothing here is stored twice.
 */
export interface InboxDecisionContext {
	/** A parked run or a blocked Task sits behind this decision. */
	blocking: boolean;
	blockingReason: InboxDecisionBlockingReason | null;
	/** Escalation confidence 0..1; NULL = not scored (ranks at {@link INBOX_DECISION_UNSCORED_RANK}). */
	confidence: number | null;
	confidenceSource: 'ai-judge' | 'heuristic' | null;
	/** Escalation reason code, when the item mirrors an escalation. */
	reasonCode: string | null;
	/** What the agent already tried, when the escalation recorded it. Plain text. */
	attempted: Array<{ label: string; outcome: string; detail?: string }>;
	/** Proposal action type, when the item mirrors an approval. */
	actionType: string | null;
	riskFlags: string[];
	agentName: string | null;
	/**
	 * The Task this decision belongs to — the item's own link, or the linked run's.
	 * NULL when that Task is gone or belongs to another owner.
	 */
	taskId: string | null;
	taskTitle: string | null;
	taskStatus: string | null;
	/** The Mission the Task was raised under. Provenance only: a Mission is never blocked. */
	missionId: string | null;
	runStatus: string | null;
	/** Open for longer than {@link INBOX_DECISION_DORMANT_AFTER_DAYS} with no live work behind it. */
	dormant: boolean;
}

/** One row of the decision view: the Inbox item plus its decision context. */
export interface InboxDecisionDto extends InboxItemDto {
	decision: InboxDecisionContext;
}

/** Header counts of the decision view (and the sidebar badge). */
export interface InboxDecisionCounts {
	/** Open decisions. */
	open: number;
	/** Open decisions with a parked run or a blocked Task behind them. */
	blocking: number;
	/** When the most recent decision was raised, any status; NULL = never. */
	lastRaisedAt: string | null;
}

/** Whether an Inbox kind asks the human to decide. */
export function isInboxDecisionKind(kind: unknown): kind is InboxItemKind {
	return typeof kind === 'string' && (INBOX_DECISION_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether answering a decision this way must carry a reason.
 *
 * Saying no, or sending the agent a different way than it recommended, is
 * exactly the answer the agent learns the most from — and the one it
 * cannot interpret from a bare button press. So:
 *
 *   - an approval answered with `reject` needs a reason;
 *   - a question whose options mark one as recommended, answered with a
 *     different option, needs a reason.
 *
 * Every other answer (approve, the recommended option, free text, a
 * question with no recommendation) does not. Opt-in at the API edge, so
 * callers that never asked for the rule keep today's behaviour.
 */
export function inboxDecisionNeedsReason(
	item: { kind: InboxItemKind; options?: readonly InboxItemOption[] | null },
	optionId: string | null | undefined
): boolean {
	if (!optionId) return false;
	if (item.kind === 'approval') return optionId === 'reject';
	if (item.kind !== 'question') return false;
	const options = Array.isArray(item.options) ? item.options : [];
	const recommended = options.find((option) => option.recommended === true);
	return recommended !== undefined && recommended.id !== optionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize an untrusted option list (a model-supplied tool argument, a
 * queue payload, a DB column) into a clean `InboxItemOption[]`, or
 * `null` when nothing usable survives.
 *
 * Strict on the fields it reads (an option without an id or label is
 * dropped — an unanswerable button is worse than none), tolerant on
 * extras, and every axis the producer controls is capped. A duplicate
 * option id makes the answer ambiguous, so later duplicates are
 * dropped rather than silently overwriting the first.
 */
export function normalizeInboxOptions(value: unknown): InboxItemOption[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const out: InboxItemOption[] = [];
	const seen = new Set<string>();
	for (const raw of value.slice(0, INBOX_MAX_OPTIONS)) {
		if (!isRecord(raw)) continue;
		const id =
			typeof raw.id === 'string' && raw.id.trim().length > 0
				? raw.id.trim().slice(0, INBOX_MAX_OPTION_ID_CHARS)
				: null;
		const label =
			typeof raw.label === 'string' && raw.label.trim().length > 0
				? raw.label.trim().slice(0, INBOX_MAX_OPTION_LABEL_CHARS)
				: null;
		if (!id || !label || seen.has(id)) continue;
		seen.add(id);
		const option: { id: string; label: string; description?: string; recommended?: boolean } = {
			id,
			label
		};
		if (typeof raw.description === 'string' && raw.description.trim().length > 0) {
			option.description = raw.description.trim().slice(0, INBOX_MAX_OPTION_LABEL_CHARS);
		}
		if (raw.recommended === true) {
			option.recommended = true;
		}
		out.push(option);
	}
	return out.length > 0 ? out : null;
}

/**
 * Normalize untrusted fleet provenance (a reconciler input, a DB column)
 * into a clean `InboxItemSourceMeta`, or `null` when nothing usable
 * survives — the same posture as {@link normalizeInboxOptions}: only the
 * declared string fields come through, trimmed and capped, and an
 * unknown key is dropped rather than stored.
 */
export function normalizeInboxSourceMeta(value: unknown): InboxItemSourceMeta | null {
	if (!isRecord(value)) return null;
	const out: InboxItemSourceMeta = {};
	let populated = false;
	for (const field of INBOX_SOURCE_META_FIELDS) {
		const raw = value[field];
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		out[field] = trimmed.slice(0, INBOX_SOURCE_META_MAX_FIELD_CHARS);
		populated = true;
	}
	return populated ? out : null;
}
