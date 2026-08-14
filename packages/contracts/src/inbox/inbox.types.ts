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
 * Distinct from the HITL question payloads next door (`../hitl`): those
 * are the typed canvas payloads rendered inside a Task detail. An inbox
 * item is a MESSAGE — one flat option list, one reply box — so it keeps
 * the deliberately smaller shape the founder screenshots show.
 */

export type InboxItemKind = 'question' | 'approval' | 'escalation' | 'notice';

export const INBOX_ITEM_KINDS: readonly InboxItemKind[] = [
	'question',
	'approval',
	'escalation',
	'notice'
];

export type InboxItemStatus = 'open' | 'answered' | 'archived';

export const INBOX_ITEM_STATUSES: readonly InboxItemStatus[] = ['open', 'answered', 'archived'];

export type InboxItemSourceType = 'agent-run' | 'escalation' | 'proposal' | 'system' | 'work';

export const INBOX_ITEM_SOURCE_TYPES: readonly InboxItemSourceType[] = [
	'agent-run',
	'escalation',
	'proposal',
	'system',
	'work'
];

/** Hard caps applied by writers (DoS + prompt-log guard). */
export const INBOX_MAX_TITLE_CHARS = 300;
export const INBOX_MAX_BODY_CHARS = 8000;
export const INBOX_MAX_OPTIONS = 12;
export const INBOX_MAX_OPTION_ID_CHARS = 64;
export const INBOX_MAX_OPTION_LABEL_CHARS = 200;
export const INBOX_MAX_REPLY_CHARS = 8000;

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
	createdAt: string;
	updatedAt: string;
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

/** Narrow an untrusted query value to a status, or `undefined`. */
export function parseInboxItemStatus(value: unknown): InboxItemStatus | undefined {
	return typeof value === 'string' && (INBOX_ITEM_STATUSES as readonly string[]).includes(value)
		? (value as InboxItemStatus)
		: undefined;
}
