import { MAX_MENTIONS_PER_MESSAGE, type ConversationMention } from './conversation.types.js';

/**
 * The one rule for what an `@` in a Conversation message addresses.
 *
 * It lives here, beside the limits, because two places must agree on it
 * exactly: the server that decides who a message reaches, and the composer
 * that highlights a mention before it is sent. A highlight has to mean the
 * mention will land (FR-29), so the composer runs this same function against
 * candidates the server already confirmed for the person typing.
 *
 *  - a mention matches a candidate's full display name (multi-word names
 *    included) or its full slug, case-insensitively, and NEVER a prefix
 *    (`@Nov` does not reach "Nova") (FR-30);
 *  - the longest name wins, so "Nova Prime" is not read as "Nova";
 *  - an `@` inside a word (an email address, a handle) is not a mention;
 *  - the existing document-reference syntax (`@kb:slug`) is not a mention and
 *    is left exactly as written (FR-33);
 *  - resolved mentions are capped at ten; later ones stay plain text (FR-31);
 *  - an `@` token that resolves to nobody is removed from what an Agent
 *    receives (FR-32).
 */

/** Someone a person can address by name. */
export interface ConversationMentionCandidateSource {
	type: 'agent' | 'user';
	id: string;
	slug: string;
	name: string;
	status?: string | null;
}

/** A resolved `@` token, by position in the body. */
export interface ConversationMentionSpan {
	start: number;
	length: number;
	type: 'agent' | 'user';
	id: string;
}

export interface ParsedConversationMentionBody {
	/** Resolved mentions, de-duplicated, at most {@link MAX_MENTIONS_PER_MESSAGE}. */
	mentions: ConversationMention[];
	/** Agent ids among {@link mentions}, in first-mention order. */
	agentIds: string[];
	/**
	 * The body an Agent receives: identical to the stored body except that
	 * every `@` token that did not resolve is removed.
	 */
	agentVisibleBody: string;
	/** Resolved spans in the body — exactly what a composer may highlight. */
	spans: ConversationMentionSpan[];
	/** Resolvable mentions past the cap; they stay plain text. */
	overLimit: number;
}

/** A document reference (`@kb:slug`) by position in the body. */
export interface ConversationDocumentReferenceSpan {
	start: number;
	length: number;
	slug: string;
}

/** Characters that continue a name or slug — a match must not be followed by one. */
const NAME_CONTINUATION_RE = /[\p{L}\p{N}_-]/u;
/** Characters that make an `@` part of a word rather than a mention. */
const WORD_BEFORE_AT_RE = /[\p{L}\p{N}_.+-]/u;
/** The token an unresolved `@` mention covers. */
const UNRESOLVED_TOKEN_RE = /^[\p{L}\p{N}_-]{1,80}/u;
/** The existing document-reference prefix. */
export const CONVERSATION_DOCUMENT_REFERENCE_PREFIX = 'kb:';
/** The document-reference syntax the model proxy already resolves (`@kb:class/slug`). */
const DOCUMENT_REFERENCE_RE = /(?<![A-Za-z0-9_])@kb:([A-Za-z0-9/_.-]+)/g;

/**
 * Pure parse of `body` against `candidates` — see the module note for the
 * rule. The same input always gives the same answer, on the server and in the
 * browser.
 */
export function parseConversationMentions(
	body: string,
	candidates: readonly ConversationMentionCandidateSource[]
): ParsedConversationMentionBody {
	const keys = candidates
		.flatMap((candidate) =>
			[candidate.name, candidate.slug]
				.filter((key): key is string => typeof key === 'string' && key.trim() !== '')
				.map((key) => ({ key: key.trim().toLowerCase(), candidate }))
		)
		.sort((a, b) => b.key.length - a.key.length);

	const mentions: ConversationMention[] = [];
	const agentIds: string[] = [];
	const spans: ConversationMentionSpan[] = [];
	const strip: Array<{ start: number; end: number }> = [];
	const seen = new Set<string>();
	let overLimit = 0;
	const lower = body.toLowerCase();

	for (let at = body.indexOf('@'); at !== -1; at = body.indexOf('@', at + 1)) {
		if (at > 0 && WORD_BEFORE_AT_RE.test(body[at - 1])) continue;
		const restLower = lower.slice(at + 1);
		if (restLower.startsWith(CONVERSATION_DOCUMENT_REFERENCE_PREFIX)) continue;

		const hit = keys.find(
			({ key }) =>
				restLower.startsWith(key) &&
				(restLower.length === key.length || !NAME_CONTINUATION_RE.test(restLower[key.length]))
		);

		if (!hit) {
			const token = UNRESOLVED_TOKEN_RE.exec(body.slice(at + 1));
			if (token) strip.push({ start: at, end: at + 1 + token[0].length });
			continue;
		}

		const { candidate, key } = hit;
		const span: ConversationMentionSpan = {
			start: at,
			length: key.length + 1,
			type: candidate.type,
			id: candidate.id
		};
		const identity = `${candidate.type}:${candidate.id}`;
		if (seen.has(identity)) {
			// A repeat of a mention that landed: it lands too (once).
			spans.push(span);
			continue;
		}
		if (mentions.length >= MAX_MENTIONS_PER_MESSAGE) {
			// Past the cap: plain text, and never highlighted — a highlight
			// must always mean the mention lands.
			overLimit += 1;
			continue;
		}
		seen.add(identity);
		spans.push(span);
		mentions.push({ type: candidate.type, id: candidate.id, slug: candidate.slug });
		if (candidate.type === 'agent') agentIds.push(candidate.id);
	}

	return {
		mentions,
		agentIds,
		agentVisibleBody: removeSpans(body, strip),
		spans,
		overLimit
	};
}

/** Every `@kb:slug` document reference in `body`, in order. */
export function findConversationDocumentReferences(body: string): ConversationDocumentReferenceSpan[] {
	const references: ConversationDocumentReferenceSpan[] = [];
	for (const match of body.matchAll(DOCUMENT_REFERENCE_RE)) {
		if (match.index === undefined) continue;
		references.push({ start: match.index, length: match[0].length, slug: match[1] });
	}
	return references;
}

function removeSpans(body: string, spans: Array<{ start: number; end: number }>): string {
	if (spans.length === 0) return body;
	let out = '';
	let cursor = 0;
	for (const span of spans) {
		out += body.slice(cursor, span.start);
		cursor = span.end;
	}
	out += body.slice(cursor);
	return (
		out
			.replace(/[ \t]{2,}/g, ' ')
			// A single space, not ` +`. The two are equivalent here because the
			// collapse on the line above already leaves no run of two or more —
			// and that equivalence is the whole point: ` +` IS quadratic when it
			// meets a long run with no punctuation to anchor on (measured: 20k
			// spaces 1.4s, 40k 5.8s, 80k 22s, 160k 85s), and the only thing
			// standing between an attacker-supplied body and that cost is one
			// earlier `.replace` that nothing forces to stay. Stated plainly:
			// this was NOT exploitable before, and the change is so that a later
			// edit to the collapse cannot make it so.
			.replace(/ ([,.;:!?])/g, '$1')
			.trim()
	);
}
