/**
 * Escalation logging schema (judgment layer G3) — the wire/storage shape
 * for "the agent gave up and a human has to decide".
 *
 * Zero-dependency value types only: the entity + repository live in
 * `@ever-works/agent`, the writers are the worker and the domain
 * services, and the readers are the Task-detail endpoint and the digest.
 * Everything here is deliberately a plain string union so the same token
 * can be persisted, filtered on, and rendered without a mapping table.
 */

/**
 * WHY the agent stopped. Stable machine tokens — they are persisted, so
 * the string values are a compatibility surface and must never be
 * renamed (add a new member instead).
 *
 * - `gate-exhausted`     — the bounded red→iterate loop used every allowed
 *                          attempt and the required checks are still red.
 * - `gate-precheck-red`  — the cheap L0 pre-check failed and the policy
 *                          refuses to spend a model call on it.
 * - `judge-escalated`    — every acceptance check passed, but the
 *                          acceptance-criteria judge says the run does not
 *                          satisfy what the Task asked for. No failing
 *                          command to point at: a human has to decide.
 * - `guardrail-refusal`  — a guardrail (permission, allowlist, policy)
 *                          refused an action the agent needed to take.
 * - `budget-stop`        — an Agent/Work budget or credit ceiling stopped
 *                          the work before it was finished.
 * - `merge-refused`      — the resolved merge policy refused the agent
 *                          merge; the PR is open and needs a human.
 * - `awaiting-input`     — the agent parked on a question it cannot answer
 *                          itself.
 * - `run-parked`         — the sweeper hibernated a stale run; the
 *                          conversation is resumable but nobody is driving.
 * - `queued-too-long`    — the run never got capacity inside the bound.
 */
export type AgentEscalationReasonCode =
	| 'gate-exhausted'
	| 'gate-precheck-red'
	| 'judge-escalated'
	| 'guardrail-refusal'
	| 'budget-stop'
	| 'merge-refused'
	| 'awaiting-input'
	| 'run-parked'
	| 'queued-too-long';

/** Canonical list — one source of truth for `@IsIn` validators and pins. */
export const AGENT_ESCALATION_REASON_CODES: readonly AgentEscalationReasonCode[] = [
	'gate-exhausted',
	'gate-precheck-red',
	'judge-escalated',
	'guardrail-refusal',
	'budget-stop',
	'merge-refused',
	'awaiting-input',
	'run-parked',
	'queued-too-long'
];

/**
 * Where the escalation currently stands. An escalation is a QUESTION, so
 * it has exactly two states: nobody answered it yet, or somebody did.
 * Deliberately not a richer workflow — a third state would need an owner,
 * and the owner of an escalation is "whoever opens the Task".
 */
export type AgentEscalationStatus = 'open' | 'resolved';

export const AGENT_ESCALATION_STATUSES: readonly AgentEscalationStatus[] = ['open', 'resolved'];

/** Hard caps applied by the writer before persisting (DoS + prompt-log guard). */
export const AGENT_ESCALATION_MAX_SUMMARY_CHARS = 500;
export const AGENT_ESCALATION_MAX_DECISION_CHARS = 1000;
export const AGENT_ESCALATION_MAX_ATTEMPT_ENTRIES = 20;

/**
 * One thing the agent tried before giving up. Free enough to describe a
 * gate attempt, a refused merge, or a guardrail denial without three
 * separate shapes.
 */
export interface AgentEscalationAttempt {
	/** Short machine-ish label: `gate-attempt-2`, `merge`, `lint`. */
	label: string;
	/** What happened, in one line. Plain text — never rendered as markup. */
	outcome: string;
	/** Optional last-lines excerpt (already byte-capped by the writer). */
	detail?: string;
}

/** The read shape returned by the Task-detail + digest surfaces. */
export interface AgentEscalationDto {
	id: string;
	reasonCode: AgentEscalationReasonCode;
	status: AgentEscalationStatus;
	runId: string | null;
	taskId: string | null;
	workId: string | null;
	agentId: string | null;
	/** One-line "what happened". */
	summary: string;
	/** What a human should decide, phrased as a question/instruction. */
	decisionNeeded: string;
	/** What was attempted, newest last. */
	attempted: AgentEscalationAttempt[];
	resolvedByUserId: string | null;
	resolutionNote: string | null;
	resolvedAt: string | null;
	createdAt: string;
}
