/**
 * Human-in-the-loop question payloads (judgment layer G8s).
 *
 * G3 shipped the escalation RECORD — "the agent gave up, here is a
 * one-line summary and a free-text `decisionNeeded`". That is enough to
 * notify a human and nothing more: a free-text question cannot be
 * rendered as a control, cannot be validated, and cannot be answered
 * machine-readably. This file adds the typed half.
 *
 * A HITL question is a discriminated union over five shapes, each with a
 * matching answer shape:
 *
 *   confirm       → { confirmed: boolean }
 *   choice        → { optionId: string }
 *   multi_choice  → { optionIds: string[] }
 *   text          → { text: string }
 *   approval      → { decision: 'approved' | 'rejected', note? }
 *
 * Everything round-trips through JSON: {@link serializeHitlQuestion} /
 * {@link parseHitlQuestion} are the persistence + wire boundary, and
 * {@link validateHitlAnswer} is the one place an answer is checked
 * against the question that asked for it. Parsers are TOLERANT on
 * unknown extra keys (forward compatibility) and STRICT on the fields
 * they read — an unparseable payload is `null`, never a half-built
 * object.
 *
 * Zero-dependency value types: the renderers live in the web app's
 * canvas registry, the writers are the agent runtime, and the readers
 * are the Task-detail surfaces.
 */

export type HitlQuestionKind = 'confirm' | 'choice' | 'multi_choice' | 'text' | 'approval';

export const HITL_QUESTION_KINDS: readonly HitlQuestionKind[] = [
	'confirm',
	'choice',
	'multi_choice',
	'text',
	'approval'
];

/** Hard caps applied by the parser (DoS + prompt-log guard). */
export const HITL_MAX_PROMPT_CHARS = 1000;
export const HITL_MAX_CONTEXT_CHARS = 4000;
export const HITL_MAX_OPTIONS = 25;
export const HITL_MAX_OPTION_LABEL_CHARS = 200;
export const HITL_MAX_TEXT_ANSWER_CHARS = 4000;
export const HITL_MAX_NOTE_CHARS = 1000;

/** One selectable option for `choice` / `multi_choice`. */
export interface HitlChoiceOption {
	/** Stable machine token returned in the answer. */
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Renderers may highlight a risky option (e.g. the destructive branch). */
	readonly tone?: 'default' | 'success' | 'warning' | 'danger';
}

interface HitlQuestionBase {
	readonly id: string;
	/** What the human is being asked, in one line. Plain text — never markup. */
	readonly prompt: string;
	/** Optional longer background (what was tried, what is at stake). */
	readonly context?: string;
	/** Escalation this question belongs to, when it came from one (G3). */
	readonly escalationId?: string | null;
	readonly runId?: string | null;
	readonly taskId?: string | null;
}

export interface HitlConfirmQuestion extends HitlQuestionBase {
	readonly kind: 'confirm';
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly defaultValue?: boolean;
}

export interface HitlChoiceQuestion extends HitlQuestionBase {
	readonly kind: 'choice';
	readonly options: readonly HitlChoiceOption[];
	readonly defaultOptionId?: string;
}

export interface HitlMultiChoiceQuestion extends HitlQuestionBase {
	readonly kind: 'multi_choice';
	readonly options: readonly HitlChoiceOption[];
	readonly minSelected?: number;
	readonly maxSelected?: number;
}

export interface HitlTextQuestion extends HitlQuestionBase {
	readonly kind: 'text';
	readonly placeholder?: string;
	readonly multiline?: boolean;
	readonly maxLength?: number;
}

/**
 * The "may I do this?" gate. Distinct from `confirm` because it carries
 * WHAT is about to happen and WHY it is risky — the renderer shows the
 * action + risks, and the answer records a decision plus an optional
 * note that becomes the escalation's resolution note.
 */
export interface HitlApprovalQuestion extends HitlQuestionBase {
	readonly kind: 'approval';
	/** One line describing the action awaiting approval. */
	readonly action: string;
	readonly risks?: readonly string[];
	/** Optional preview (diff, message body) — plain text, rendered verbatim. */
	readonly preview?: string;
}

export type HitlQuestion =
	| HitlConfirmQuestion
	| HitlChoiceQuestion
	| HitlMultiChoiceQuestion
	| HitlTextQuestion
	| HitlApprovalQuestion;

interface HitlAnswerBase {
	readonly questionId: string;
	readonly answeredByUserId?: string | null;
	/** ISO-8601. Left to the writer so this stays a pure value type. */
	readonly answeredAt?: string | null;
}

export interface HitlConfirmAnswer extends HitlAnswerBase {
	readonly kind: 'confirm';
	readonly confirmed: boolean;
}

export interface HitlChoiceAnswer extends HitlAnswerBase {
	readonly kind: 'choice';
	readonly optionId: string;
}

export interface HitlMultiChoiceAnswer extends HitlAnswerBase {
	readonly kind: 'multi_choice';
	readonly optionIds: readonly string[];
}

export interface HitlTextAnswer extends HitlAnswerBase {
	readonly kind: 'text';
	readonly text: string;
}

export interface HitlApprovalAnswer extends HitlAnswerBase {
	readonly kind: 'approval';
	readonly decision: 'approved' | 'rejected';
	readonly note?: string;
}

export type HitlAnswer =
	| HitlConfirmAnswer
	| HitlChoiceAnswer
	| HitlMultiChoiceAnswer
	| HitlTextAnswer
	| HitlApprovalAnswer;

export function isHitlQuestionKind(value: unknown): value is HitlQuestionKind {
	return typeof value === 'string' && (HITL_QUESTION_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cappedString(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function nullableId(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	return value.length > 0 ? value : undefined;
}

function parseOptions(value: unknown): readonly HitlChoiceOption[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const options: HitlChoiceOption[] = [];
	const seen = new Set<string>();
	for (const raw of value.slice(0, HITL_MAX_OPTIONS)) {
		if (!isRecord(raw)) return null;
		const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
		const label = cappedString(raw.label, HITL_MAX_OPTION_LABEL_CHARS);
		if (!id || !label) return null;
		// A duplicate option id makes the answer ambiguous — refuse the
		// whole payload rather than silently picking one of them.
		if (seen.has(id)) return null;
		seen.add(id);
		const option: {
			id: string;
			label: string;
			description?: string;
			tone?: HitlChoiceOption['tone'];
		} = { id, label };
		const description = cappedString(raw.description, HITL_MAX_OPTION_LABEL_CHARS);
		if (description) option.description = description;
		if (raw.tone === 'default' || raw.tone === 'success' || raw.tone === 'warning' || raw.tone === 'danger') {
			option.tone = raw.tone;
		}
		options.push(option);
	}
	return options.length > 0 ? options : null;
}

function parseBase(raw: Record<string, unknown>): HitlQuestionBase | null {
	const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
	const prompt = cappedString(raw.prompt, HITL_MAX_PROMPT_CHARS);
	if (!id || !prompt) return null;
	const base: {
		id: string;
		prompt: string;
		context?: string;
		escalationId?: string | null;
		runId?: string | null;
		taskId?: string | null;
	} = { id, prompt };
	const context = cappedString(raw.context, HITL_MAX_CONTEXT_CHARS);
	if (context) base.context = context;
	const escalationId = nullableId(raw.escalationId);
	if (escalationId !== undefined) base.escalationId = escalationId;
	const runId = nullableId(raw.runId);
	if (runId !== undefined) base.runId = runId;
	const taskId = nullableId(raw.taskId);
	if (taskId !== undefined) base.taskId = taskId;
	return base;
}

/**
 * Parse an untrusted payload into a `HitlQuestion`, or `null`.
 *
 * Accepts either a JSON string or an already-parsed object so the same
 * function guards a DB column, a tool argument, and a wire body.
 */
export function parseHitlQuestion(input: unknown): HitlQuestion | null {
	let raw: unknown = input;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!isRecord(raw)) return null;
	const kind = raw.kind;
	if (!isHitlQuestionKind(kind)) return null;
	const base = parseBase(raw);
	if (!base) return null;

	switch (kind) {
		case 'confirm': {
			const confirmLabel = cappedString(raw.confirmLabel, HITL_MAX_OPTION_LABEL_CHARS);
			const cancelLabel = cappedString(raw.cancelLabel, HITL_MAX_OPTION_LABEL_CHARS);
			const question: HitlConfirmQuestion = {
				...base,
				kind: 'confirm',
				...(confirmLabel ? { confirmLabel } : {}),
				...(cancelLabel ? { cancelLabel } : {}),
				...(typeof raw.defaultValue === 'boolean' ? { defaultValue: raw.defaultValue } : {})
			};
			return question;
		}
		case 'choice': {
			const options = parseOptions(raw.options);
			if (!options) return null;
			const defaultOptionId =
				typeof raw.defaultOptionId === 'string' && options.some((option) => option.id === raw.defaultOptionId)
					? raw.defaultOptionId
					: undefined;
			const question: HitlChoiceQuestion = {
				...base,
				kind: 'choice',
				options,
				...(defaultOptionId ? { defaultOptionId } : {})
			};
			return question;
		}
		case 'multi_choice': {
			const options = parseOptions(raw.options);
			if (!options) return null;
			const minSelected =
				typeof raw.minSelected === 'number' && Number.isInteger(raw.minSelected) && raw.minSelected >= 0
					? raw.minSelected
					: undefined;
			const maxSelected =
				typeof raw.maxSelected === 'number' && Number.isInteger(raw.maxSelected) && raw.maxSelected > 0
					? raw.maxSelected
					: undefined;
			const question: HitlMultiChoiceQuestion = {
				...base,
				kind: 'multi_choice',
				options,
				...(minSelected !== undefined ? { minSelected } : {}),
				...(maxSelected !== undefined ? { maxSelected } : {})
			};
			return question;
		}
		case 'text': {
			const maxLength =
				typeof raw.maxLength === 'number' && Number.isInteger(raw.maxLength) && raw.maxLength > 0
					? Math.min(raw.maxLength, HITL_MAX_TEXT_ANSWER_CHARS)
					: undefined;
			const placeholder = cappedString(raw.placeholder, HITL_MAX_OPTION_LABEL_CHARS);
			const question: HitlTextQuestion = {
				...base,
				kind: 'text',
				...(placeholder ? { placeholder } : {}),
				...(typeof raw.multiline === 'boolean' ? { multiline: raw.multiline } : {}),
				...(maxLength !== undefined ? { maxLength } : {})
			};
			return question;
		}
		case 'approval': {
			const action = cappedString(raw.action, HITL_MAX_PROMPT_CHARS);
			if (!action) return null;
			const risks = Array.isArray(raw.risks)
				? raw.risks
						.map((risk) => cappedString(risk, HITL_MAX_OPTION_LABEL_CHARS))
						.filter((risk): risk is string => Boolean(risk))
						.slice(0, HITL_MAX_OPTIONS)
				: [];
			const preview = cappedString(raw.preview, HITL_MAX_CONTEXT_CHARS);
			const question: HitlApprovalQuestion = {
				...base,
				kind: 'approval',
				action,
				...(risks.length > 0 ? { risks } : {}),
				...(preview ? { preview } : {})
			};
			return question;
		}
		default:
			return null;
	}
}

/** JSON form of a question — the persistence + wire representation. */
export function serializeHitlQuestion(question: HitlQuestion): string {
	return JSON.stringify(question);
}

/** Parse an untrusted payload into a `HitlAnswer`, or `null`. */
export function parseHitlAnswer(input: unknown): HitlAnswer | null {
	let raw: unknown = input;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!isRecord(raw)) return null;
	const kind = raw.kind;
	if (!isHitlQuestionKind(kind)) return null;
	const questionId = typeof raw.questionId === 'string' && raw.questionId.length > 0 ? raw.questionId : null;
	if (!questionId) return null;

	const base: { questionId: string; answeredByUserId?: string | null; answeredAt?: string | null } = {
		questionId
	};
	const answeredByUserId = nullableId(raw.answeredByUserId);
	if (answeredByUserId !== undefined) base.answeredByUserId = answeredByUserId;
	const answeredAt = nullableId(raw.answeredAt);
	if (answeredAt !== undefined) base.answeredAt = answeredAt;

	switch (raw.kind) {
		case 'confirm':
			if (typeof raw.confirmed !== 'boolean') return null;
			return { ...base, kind: 'confirm', confirmed: raw.confirmed };
		case 'choice':
			if (typeof raw.optionId !== 'string' || raw.optionId.length === 0) return null;
			return { ...base, kind: 'choice', optionId: raw.optionId };
		case 'multi_choice': {
			if (!Array.isArray(raw.optionIds)) return null;
			const optionIds = raw.optionIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
			if (optionIds.length !== raw.optionIds.length) return null;
			return { ...base, kind: 'multi_choice', optionIds };
		}
		case 'text': {
			if (typeof raw.text !== 'string') return null;
			const text = raw.text.slice(0, HITL_MAX_TEXT_ANSWER_CHARS);
			return { ...base, kind: 'text', text };
		}
		case 'approval': {
			if (raw.decision !== 'approved' && raw.decision !== 'rejected') return null;
			const note = cappedString(raw.note, HITL_MAX_NOTE_CHARS);
			return { ...base, kind: 'approval', decision: raw.decision, ...(note ? { note } : {}) };
		}
		default:
			return null;
	}
}

export function serializeHitlAnswer(answer: HitlAnswer): string {
	return JSON.stringify(answer);
}

export type HitlAnswerValidation = { readonly valid: true } | { readonly valid: false; readonly error: string };

/**
 * Check an answer against the question that asked for it. This is the
 * ONE place the pairing rules live — the renderer, the API edge and the
 * agent runtime all call it rather than re-deriving them.
 */
export function validateHitlAnswer(question: HitlQuestion, answer: HitlAnswer): HitlAnswerValidation {
	if (answer.questionId !== question.id) {
		return { valid: false, error: `answer is for question "${answer.questionId}", not "${question.id}"` };
	}
	if (answer.kind !== question.kind) {
		return { valid: false, error: `answer kind "${answer.kind}" does not match question kind "${question.kind}"` };
	}
	switch (question.kind) {
		case 'choice': {
			const chosen = (answer as HitlChoiceAnswer).optionId;
			if (!question.options.some((option) => option.id === chosen)) {
				return { valid: false, error: `"${chosen}" is not one of the offered options` };
			}
			return { valid: true };
		}
		case 'multi_choice': {
			const chosen = (answer as HitlMultiChoiceAnswer).optionIds;
			const unique = new Set(chosen);
			if (unique.size !== chosen.length) return { valid: false, error: 'duplicate option selected' };
			for (const id of chosen) {
				if (!question.options.some((option) => option.id === id)) {
					return { valid: false, error: `"${id}" is not one of the offered options` };
				}
			}
			if (question.minSelected !== undefined && chosen.length < question.minSelected) {
				return { valid: false, error: `at least ${question.minSelected} option(s) required` };
			}
			if (question.maxSelected !== undefined && chosen.length > question.maxSelected) {
				return { valid: false, error: `at most ${question.maxSelected} option(s) allowed` };
			}
			return { valid: true };
		}
		case 'text': {
			const text = (answer as HitlTextAnswer).text;
			const max = question.maxLength ?? HITL_MAX_TEXT_ANSWER_CHARS;
			if (text.length > max) return { valid: false, error: `answer exceeds ${max} characters` };
			return { valid: true };
		}
		default:
			return { valid: true };
	}
}

/** One-line rendering for logs, notifications and digest lines. */
export function describeHitlQuestion(question: HitlQuestion): string {
	switch (question.kind) {
		case 'confirm':
			return `${question.prompt} (yes/no)`;
		case 'choice':
			return `${question.prompt} (${question.options.map((option) => option.label).join(' / ')})`;
		case 'multi_choice':
			return `${question.prompt} (pick any: ${question.options.map((option) => option.label).join(', ')})`;
		case 'text':
			return `${question.prompt} (free text)`;
		case 'approval':
			return `${question.prompt} — approve: ${question.action}`;
		default:
			// Unreachable while the union and this switch stay in lockstep;
			// a new kind added without a case lands here instead of throwing.
			return (question as HitlQuestionBase).prompt;
	}
}
