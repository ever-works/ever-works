/**
 * Fleet — session status, attention and the board (FL-05, CONTRACTS §4.2,
 * §5.1, §5.2, R-6, R-12).
 *
 * FL-04 runs a session and keeps its process; this file answers the question
 * an owner has when they are NOT looking: "is anything waiting for me?".
 *
 *  - **States.** A live session is in exactly one of `working · needs_you ·
 *    done · idle` (plus FL-04's `starting`, and `ended` once the process is
 *    gone). `outcome` is set when a turn leaves `working`/`needs_you` for
 *    `done`, and again by the process exit for `ended`.
 *  - **Evidence.** The state comes first from the agent CLI's own hooks (a
 *    per-session overlay the node injects — never the person's global
 *    configuration, R-6), then from structured events, then from a rules file
 *    that reads the terminal screen, and last from the process itself
 *    (output, Ctrl-C, exit). A lower source never overrides a state a higher
 *    one set less than {@link FLEET_SESSION_PRECEDENCE_GUARD_MS} ago, and
 *    nothing becomes `done` by silence: 30 minutes without evidence is `idle`.
 *  - **Attention.** Every edge into `needs_you` mints one attention key
 *    (`fleet-session:<sessionId>:<reason>:<promptId>`, §5.2) — the identity of
 *    that edge on the card, the Inbox item, the Decision, the "needs a look"
 *    row and the notification. A finished turn mints a `finished` key for
 *    unread and notification only.
 *
 * {@link mergeFleetSessionEvidence} is the ONE state machine: the node runs
 * it over the evidence it sees and reports the result (`session.status`,
 * `session.attention` on channel 0); the platform keeps the row and re-checks
 * the shape of every report with the parsers here, because the node is a
 * different release of the code than the platform reading it. Pure — no
 * clock, no I/O; every time is handed in.
 */

import {
	isFleetDaemonSessionId,
	isFleetSessionOutcome,
	isFleetSessionProvider,
	isFleetSessionState,
	type FleetSessionOutcome,
	type FleetSessionProvider,
	type FleetSessionState,
	type FleetSessionView
} from './fleet-sessions.types.js';

// ─── Limits and windows (CONTRACTS §10, §10.1, spec FR-4, FR-14, FR-34, FR-39) ───

/** Working or done for this long with no evidence at all → `idle` (FR-14). */
export const FLEET_SESSION_IDLE_AFTER_MS = 30 * 60_000;

/** A lower-precedence source never overrides a state a higher one set this recently (FR-13). */
export const FLEET_SESSION_PRECEDENCE_GUARD_MS = 10_000;

/** Screen rules run only for a session with no hook evidence this long (FR-34). */
export const FLEET_SESSION_RULE_QUIET_MS = 10_000;

/** Screen rules run at most this often per session (FR-34). */
export const FLEET_SESSION_RULE_INTERVAL_MS = 2_000;

/** A stop this soon after a start or resume, with no prompt between, is a boundary — not news (FR-39). */
export const FLEET_SESSION_BOUNDARY_MS = 5_000;

/** Notifications for one subject (session + reason) are sent at most once in this window (FR-39). */
export const FLEET_SESSION_NOTIFY_DEDUPE_MS = 5_000;

/** `done` cards stay on the board this long after finishing, then only in the list (FR-42). */
export const FLEET_SESSION_DONE_BOARD_HOURS = 24;

/** A session's Decision left unanswered this long is marked stale — never answered (R-12, FR-27a). */
export const FLEET_SESSION_DECISION_STALE_MS = 24 * 60 * 60_000;

/** Session answers per user per minute (CONTRACTS §10.1). */
export const FLEET_SESSION_ANSWERS_PER_MINUTE = 60;

/** The hook endpoint reads at most this much of a request body (plan §3). */
export const FLEET_SESSION_HOOK_BODY_MAX_BYTES = 64 * 1024;

/** A hook script gives up on the endpoint after this long and spools (FR-4: exit within 2 s). */
export const FLEET_SESSION_HOOK_POST_TIMEOUT_MS = 1_500;

/** Spool caps (FR-4): one file per session, at most this big … */
export const FLEET_SESSION_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024;
/** … at most this many files … */
export const FLEET_SESSION_HOOK_SPOOL_MAX_FILES = 1_024;
/** … kept at most this long. */
export const FLEET_SESSION_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Bad-token requests in one minute that the computer page surfaces (FR-6). */
export const FLEET_SESSION_HOOK_BAD_TOKEN_ALERT = 20;

/** A card's "You:" / agent line, in characters (redacted, 2-line clamp on screen). */
export const FLEET_SESSION_LINE_MAX_CHARS = 200;

/** An attention prompt, in characters (redacted). */
export const FLEET_SESSION_PROMPT_MAX_CHARS = 500;

/** Options one attention offers (digits 1–9 answer them, FR-52). */
export const FLEET_SESSION_ATTENTION_MAX_OPTIONS = 9;

/** One option's label, in characters. */
export const FLEET_SESSION_OPTION_LABEL_MAX_CHARS = 120;

/** A free-text answer, in characters (typed into the session, never stored). */
export const FLEET_SESSION_ANSWER_TEXT_MAX_CHARS = 4_000;

// ─── Attention (CONTRACTS §5.2) ─────────────────────────────────────────────

export const FLEET_SESSION_ATTENTION_REASONS = ['question', 'permission', 'blocked', 'failed', 'finished'] as const;

/**
 * `question` / `permission` — the CLI stopped to ask (a Decision, R-12);
 * `blocked` / `failed` — it cannot go on (an Inbox notice only); `finished` —
 * a turn ended (unread and notification only, never a Decision).
 */
export type FleetSessionAttentionReason = (typeof FLEET_SESSION_ATTENTION_REASONS)[number];

export function isFleetSessionAttentionReason(value: unknown): value is FleetSessionAttentionReason {
	return typeof value === 'string' && (FLEET_SESSION_ATTENTION_REASONS as readonly string[]).includes(value);
}

/** The reasons that put a session in `needs_you` (everything but `finished`). */
export const FLEET_SESSION_NEEDS_YOU_REASONS: readonly FleetSessionAttentionReason[] = [
	'question',
	'permission',
	'blocked',
	'failed'
];

/** The reasons a Decision answers (R-12): a question and a permission request. */
export function isFleetSessionDecisionReason(reason: FleetSessionAttentionReason): boolean {
	return reason === 'question' || reason === 'permission';
}

/**
 * One option the CLI showed (FR-31). `id` is what an answer names; the keys
 * the node types for it stay on the node (the platform never sends keys).
 */
export interface FleetSessionAttentionOption {
	id: string;
	label: string;
	/** The first option the CLI showed (the card's primary button). */
	primary?: boolean;
	/** The option that denies / cancels (Esc on the detail's approval card). */
	deny?: boolean;
}

/** `fleet_sessions.attention` (CONTRACTS §4.2) and every surface's view of it. */
export interface FleetSessionAttention {
	/** `fleet-session:<sessionId>:<reason>:<promptId|turnId>` (§5.2). */
	key: string;
	reason: FleetSessionAttentionReason;
	/** What the CLI asks, redacted, ≤ {@link FLEET_SESSION_PROMPT_MAX_CHARS}. Empty for `finished` without a line. */
	prompt: string;
	/** Exactly the options the CLI showed (FR-31); empty for `blocked`, `failed`, `finished`. */
	options: FleetSessionAttentionOption[];
	/** A question that also takes free text (the question tool's "other"). */
	allowsText?: boolean;
	/** The tool a permission asks about (`Bash`, `Edit`, …), when the CLI said. */
	tool?: string;
	/** ISO time the edge was raised. */
	raisedAt: string;
	/** ISO time it was acknowledged (the detail was opened); `acknowledgedAt < raisedAt` = unread (§5.2). */
	acknowledgedAt: string | null;
}

/** The one attention identity (CONTRACTS §5.2). */
export function fleetSessionAttentionKey(
	sessionId: string,
	reason: FleetSessionAttentionReason,
	promptId: string
): string {
	const id = promptId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || '0';
	return `fleet-session:${sessionId}:${reason}:${id}`;
}

/** Read an attention key back: `null` when it is not one. */
export function parseFleetSessionAttentionKey(
	key: unknown
): { sessionId: string; reason: FleetSessionAttentionReason; promptId: string } | null {
	if (typeof key !== 'string' || key.length > 200) return null;
	const parts = key.split(':');
	if (parts.length !== 4 || parts[0] !== 'fleet-session') return null;
	const [, sessionId, reason, promptId] = parts;
	if (!isFleetDaemonSessionId(sessionId) || !isFleetSessionAttentionReason(reason)) return null;
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(promptId)) return null;
	return { sessionId, reason, promptId };
}

/** Unread = raised and never acknowledged since (§5.2). */
export function isFleetSessionAttentionUnread(attention: FleetSessionAttention | null | undefined): boolean {
	if (!attention) return false;
	if (!attention.acknowledgedAt) return true;
	const raised = Date.parse(attention.raisedAt);
	const acknowledged = Date.parse(attention.acknowledgedAt);
	if (!Number.isFinite(raised) || !Number.isFinite(acknowledged)) return !Number.isFinite(acknowledged);
	return acknowledged < raised;
}

function boundText(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	// Control characters never reach a card (a screen line may carry escapes).
	// eslint-disable-next-line no-control-regex
	const flat = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
	if (flat.length === 0) return '';
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseOption(value: unknown): FleetSessionAttentionOption | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(record.id)) return null;
	const label = boundText(record.label, FLEET_SESSION_OPTION_LABEL_MAX_CHARS);
	if (!label) return null;
	const option: FleetSessionAttentionOption = { id: record.id, label };
	if (record.primary === true) option.primary = true;
	if (record.deny === true) option.deny = true;
	return option;
}

/**
 * Read an attention off the wire or a stored column: `null` when it is not
 * one. Strings bounded, options capped and de-duplicated, unknown keys dropped.
 */
export function parseFleetSessionAttention(value: unknown): FleetSessionAttention | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const key = parseFleetSessionAttentionKey(record.key);
	if (!key || !isFleetSessionAttentionReason(record.reason) || key.reason !== record.reason) return null;
	if (typeof record.raisedAt !== 'string' || record.raisedAt.length > 40) return null;
	const options: FleetSessionAttentionOption[] = [];
	const seen = new Set<string>();
	if (Array.isArray(record.options)) {
		for (const raw of record.options) {
			if (options.length >= FLEET_SESSION_ATTENTION_MAX_OPTIONS) break;
			const option = parseOption(raw);
			if (option && !seen.has(option.id)) {
				seen.add(option.id);
				options.push(option);
			}
		}
	}
	const attention: FleetSessionAttention = {
		key: record.key as string,
		reason: record.reason,
		prompt: boundText(record.prompt, FLEET_SESSION_PROMPT_MAX_CHARS) ?? '',
		options,
		raisedAt: record.raisedAt,
		acknowledgedAt:
			typeof record.acknowledgedAt === 'string' && record.acknowledgedAt.length <= 40
				? record.acknowledgedAt
				: null
	};
	if (record.allowsText === true) attention.allowsText = true;
	const tool = boundText(record.tool, 64);
	if (tool) attention.tool = tool;
	return attention;
}

// ─── Evidence (CONTRACTS §4.2 `lastEvidence`, §5.1) ─────────────────────────

export const FLEET_SESSION_EVIDENCE_SOURCES = ['hook', 'structured', 'rules', 'exit'] as const;

/**
 * Where a state came from, highest first: the CLI's hooks, a structured event
 * stream (reserved — no structured transport ships yet, spec §8), the screen
 * rules, and the process itself (`exit` — output, Ctrl-C, exit, silence).
 */
export type FleetSessionEvidenceSource = (typeof FLEET_SESSION_EVIDENCE_SOURCES)[number];

export function isFleetSessionEvidenceSource(value: unknown): value is FleetSessionEvidenceSource {
	return typeof value === 'string' && (FLEET_SESSION_EVIDENCE_SOURCES as readonly string[]).includes(value);
}

/** Higher wins (FR-13). */
export const FLEET_SESSION_EVIDENCE_PRECEDENCE: Readonly<Record<FleetSessionEvidenceSource, number>> = {
	hook: 4,
	structured: 3,
	rules: 2,
	exit: 1
};

export const FLEET_SESSION_EVIDENCE_EVENTS = [
	// The CLI's hooks (normalised per provider on the node).
	'session-start',
	'prompt',
	'permission',
	'question',
	'stop',
	'idle-prompt',
	'session-end',
	// The screen rules.
	'blocked',
	'working',
	'idle-weak',
	// The process and the node.
	'activity',
	'interrupt',
	'answered',
	'silence',
	'exit',
	'lost'
] as const;

/**
 * The normalised evidence vocabulary (plan §6.3):
 *
 *  - `session-start` — the CLI started, resumed or cleared (Claude
 *    `SessionStart`): `working`, and a {@link FLEET_SESSION_BOUNDARY_MS} window
 *    in which a stop is not news;
 *  - `prompt` — a prompt was submitted (`UserPromptSubmit`): `working`;
 *  - `permission` / `question` — the CLI asks (`PermissionRequest`, the
 *    question tool's `PreToolUse`, a permission `Notification`, or a rule):
 *    `needs_you`;
 *  - `stop` — the turn ended (`Stop`, Codex `agent-turn-complete`): `done ·
 *    success`;
 *  - `idle-prompt` — the CLI says it waits for input (`Notification
 *    idle_prompt`): `done` when a turn was running;
 *  - `session-end` — the CLI ended its session (`SessionEnd`; the process may
 *    go on after `/clear`): clears an open prompt; `ended` is the exit's;
 *  - `blocked` / `working` / `idle-weak` — screen rules (never `done`);
 *  - `activity` — output: `idle → working` only;
 *  - `interrupt` — a person pressed Ctrl-C in a running turn: `done ·
 *    interrupted` (not news);
 *  - `answered` — the node typed an answer: the prompt clears, `working`;
 *  - `silence` — {@link FLEET_SESSION_IDLE_AFTER_MS} without evidence: `idle`;
 *  - `exit` / `lost` — the process ended (FL-04 ends the row; nothing here
 *    changes the state).
 */
export type FleetSessionEvidenceEvent = (typeof FLEET_SESSION_EVIDENCE_EVENTS)[number];

export function isFleetSessionEvidenceEvent(value: unknown): value is FleetSessionEvidenceEvent {
	return typeof value === 'string' && (FLEET_SESSION_EVIDENCE_EVENTS as readonly string[]).includes(value);
}

/** One piece of evidence, as the node hands it to {@link mergeFleetSessionEvidence}. */
export interface FleetSessionEvidence {
	source: FleetSessionEvidenceSource;
	event: FleetSessionEvidenceEvent;
	/** When it happened (ms since the epoch, the node's clock). */
	at: number;
	/** The CLI's id for the prompt (a tool-use id), when it gave one — the attention key's last part. */
	promptId?: string;
	/** What the CLI asks (redacted by the caller). */
	prompt?: string;
	/** The options the CLI showed. */
	options?: FleetSessionAttentionOption[];
	/** A question that also takes free text. */
	allowsText?: boolean;
	/** The tool a permission asks about. */
	tool?: string;
	/** The prompt the person submitted (redacted, first line) — the card's "You:" line. */
	userLine?: string;
	/** The agent's last message (redacted, first line) — the card's agent line. */
	agentLine?: string;
	/** The screen rule that matched (`rules`). */
	rule?: string;
	/** `confirm-only`: a permission notification that only confirms what a richer hook raised. */
	confirmOnly?: boolean;
}

/** `fleet_sessions.lastEvidence` (CONTRACTS §4.2): why the state is what it is. */
export interface FleetSessionLastEvidence {
	source: FleetSessionEvidenceSource;
	/** ISO time. */
	at: string;
	detail: FleetSessionEvidenceDetail;
}

/**
 * `lastEvidence.detail` — the event and the report's sequence (CONTRACTS §4.2),
 * plus what the card shows: the last user line and the last agent line, carried
 * forward from report to report so the card keeps both (FR-20).
 */
export interface FleetSessionEvidenceDetail {
	event: FleetSessionEvidenceEvent;
	/** The node's report sequence; the platform applies a report only when it is newer (U5). */
	seq: number;
	/** The rule id when `source` is `rules`. */
	rule?: string;
	userLine?: string | null;
	agentLine?: string | null;
}

export function parseFleetSessionLastEvidence(value: unknown): FleetSessionLastEvidence | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetSessionEvidenceSource(record.source)) return null;
	if (typeof record.at !== 'string' || record.at.length > 40) return null;
	const raw = record.detail;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const detailRecord = raw as Record<string, unknown>;
	if (!isFleetSessionEvidenceEvent(detailRecord.event)) return null;
	if (typeof detailRecord.seq !== 'number' || !Number.isFinite(detailRecord.seq) || detailRecord.seq < 0) return null;
	const detail: FleetSessionEvidenceDetail = { event: detailRecord.event, seq: Math.floor(detailRecord.seq) };
	if (typeof detailRecord.rule === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(detailRecord.rule)) {
		detail.rule = detailRecord.rule;
	}
	if (detailRecord.userLine === null) detail.userLine = null;
	else {
		const userLine = boundText(detailRecord.userLine, FLEET_SESSION_LINE_MAX_CHARS);
		if (userLine) detail.userLine = userLine;
	}
	if (detailRecord.agentLine === null) detail.agentLine = null;
	else {
		const agentLine = boundText(detailRecord.agentLine, FLEET_SESSION_LINE_MAX_CHARS);
		if (agentLine) detail.agentLine = agentLine;
	}
	return { source: record.source, at: record.at, detail };
}

// ─── What the node injected (CONTRACTS §4.2 `hooks`, R-6, FR-10, FR-11) ─────

/**
 * The Claude Code hook events the overlay may register (FR-7). `PostToolUse`
 * is beside the spec's seven: it is what says a permission answered IN THE
 * TERMINAL has let the tool run, so `needs_you` does not outlive the prompt (U5).
 */
export const FLEET_SESSION_CLAUDE_HOOK_EVENTS = [
	'SessionStart',
	'UserPromptSubmit',
	'PermissionRequest',
	'PreToolUse',
	'PostToolUse',
	'Stop',
	'SessionEnd',
	'Notification'
] as const;

export type FleetSessionClaudeHookEvent = (typeof FLEET_SESSION_CLAUDE_HOOK_EVENTS)[number];

/** Codex reports through its `notify` program, which it runs on these events. */
export const FLEET_SESSION_CODEX_NOTIFY_EVENTS = ['agent-turn-complete'] as const;

/**
 * The events exact status RELIES on (FR-11): with all of them injected the
 * status is "from the CLI's hooks"; with some, "partly from the screen"; with
 * none, "from the screen".
 */
export const FLEET_SESSION_RELIED_HOOK_EVENTS: Readonly<Record<'claude-code' | 'codex', readonly string[]>> = {
	'claude-code': ['UserPromptSubmit', 'PermissionRequest', 'Stop'],
	// Codex has no permission hook: its prompts are read from the screen (FR-33).
	codex: ['agent-turn-complete', 'permission']
};

/** `fleet_sessions.hooks` — what the node injected for this session. */
export interface FleetSessionHooks {
	provider: FleetSessionProvider;
	injected: boolean;
	/** The hook events actually registered. */
	events: string[];
	/** Codex owner sessions: the person's own notify command does not run in this session (U11, R-6). */
	notifyReplaced?: boolean;
}

export function parseFleetSessionHooks(value: unknown): FleetSessionHooks | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetSessionProvider(record.provider) || typeof record.injected !== 'boolean') return null;
	const events = Array.isArray(record.events)
		? record.events
				.filter((event): event is string => typeof event === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(event))
				.slice(0, 16)
		: [];
	const hooks: FleetSessionHooks = { provider: record.provider, injected: record.injected, events };
	if (record.notifyReplaced === true) hooks.notifyReplaced = true;
	return hooks;
}

/** Where a session's status comes from, as every surface labels it (FR-11, spec §5.10). */
export type FleetSessionStatusSource = 'hooks' | 'partial' | 'screen' | 'shell';

export function fleetSessionStatusSource(
	provider: FleetSessionProvider,
	hooks: FleetSessionHooks | null | undefined
): FleetSessionStatusSource {
	if (provider === 'shell') return 'shell';
	if (!hooks || !hooks.injected || hooks.events.length === 0) return 'screen';
	const relied =
		provider === 'claude-code' || provider === 'codex' ? FLEET_SESSION_RELIED_HOOK_EVENTS[provider] : null;
	if (!relied) return 'screen';
	return relied.every((event) => hooks.events.includes(event)) ? 'hooks' : 'partial';
}

// ─── The state machine (CONTRACTS §5.1) ─────────────────────────────────────

/** What the merger keeps per session (the node in memory; the platform derives its row from the reports). */
export interface FleetSessionStatusSnapshot {
	state: FleetSessionState;
	outcome: FleetSessionOutcome | null;
	/** When the state last changed (ms). */
	stateChangedAt: number;
	/** When any evidence last arrived (ms) — the idle clock. */
	lastEvidenceAt: number;
	/** The evidence that last changed anything. */
	lastEvidence: { source: FleetSessionEvidenceSource; event: FleetSessionEvidenceEvent; at: number; rule?: string } | null;
	/** The source that set the current state, and when (the precedence guard). */
	stateSource: FleetSessionEvidenceSource | null;
	stateSourceAt: number;
	attention: FleetSessionAttention | null;
	/** End of the session-boundary window (ms), or null (FR-39). */
	boundaryUntil: number | null;
	/** A prompt was submitted since the last start / resume. */
	promptSinceStart: boolean;
	/** Turn counter (a prompt opens a turn) — attention keys when the CLI gave no prompt id. */
	turn: number;
	/** Attention edges raised so far — keeps keys unique within a turn. */
	edges: number;
	userLine: string | null;
	agentLine: string | null;
}

/** The snapshot of a session nobody has reported on yet (the node's first sight of it). */
export function initialFleetSessionStatus(at: number, state: FleetSessionState = 'working'): FleetSessionStatusSnapshot {
	return {
		state,
		outcome: null,
		stateChangedAt: at,
		lastEvidenceAt: at,
		lastEvidence: null,
		stateSource: null,
		stateSourceAt: 0,
		attention: null,
		boundaryUntil: null,
		promptSinceStart: false,
		turn: 0,
		edges: 0,
		userLine: null,
		agentLine: null
	};
}

export interface FleetSessionMergeContext {
	sessionId: string;
	provider: FleetSessionProvider;
}

export interface FleetSessionMergeResult {
	next: FleetSessionStatusSnapshot;
	/** Anything a report carries changed (state, outcome, lines, boundary). */
	changed: boolean;
	/** The attention changed (raised, updated, cleared). */
	attentionChanged: boolean;
	/** The evidence was refused by the precedence guard (FR-13). */
	guarded: boolean;
	/** A turn finished and it is news (not a boundary, not an interrupt) — the `finished` key was minted. */
	finished: boolean;
}

/** Evidence that moves the state no matter which source set it (a person's own act, the clock). */
const UNGUARDED_EVENTS: ReadonlySet<FleetSessionEvidenceEvent> = new Set(['interrupt', 'answered', 'silence']);

function attentionFor(
	ctx: FleetSessionMergeContext,
	prev: FleetSessionStatusSnapshot,
	reason: FleetSessionAttentionReason,
	evidence: FleetSessionEvidence,
	edges: number
): FleetSessionAttention {
	const promptId = evidence.promptId && /^[A-Za-z0-9._-]{1,64}$/.test(evidence.promptId)
		? evidence.promptId
		: `t${prev.turn}e${edges}`;
	const attention: FleetSessionAttention = {
		key: fleetSessionAttentionKey(ctx.sessionId, reason, promptId),
		reason,
		prompt: boundText(evidence.prompt, FLEET_SESSION_PROMPT_MAX_CHARS) ?? '',
		options: (evidence.options ?? [])
			.map((option) => parseOption(option))
			.filter((option): option is FleetSessionAttentionOption => option !== null)
			.slice(0, FLEET_SESSION_ATTENTION_MAX_OPTIONS),
		raisedAt: new Date(evidence.at).toISOString(),
		acknowledgedAt: null
	};
	if (evidence.allowsText) attention.allowsText = true;
	const tool = boundText(evidence.tool, 64);
	if (tool) attention.tool = tool;
	return attention;
}

/**
 * Merge one piece of evidence into a session's snapshot (CONTRACTS §5.1,
 * spec FR-12 … FR-19, plan §6.3). Returns the next snapshot and what changed;
 * never throws, never mutates `prev`.
 *
 * Rules, in order:
 *
 *  1. `ended` is terminal (FL-04 owns it): nothing changes it here.
 *  2. A shell is only ever `working`, `idle` or `ended` (FR-19): output →
 *     `working`, silence → `idle`, everything else is ignored.
 *  3. The precedence guard (FR-13): evidence from a lower source than the one
 *     that set the current state, less than 10 s after it did, changes
 *     nothing — except a person's own act (`interrupt`, `answered`) and the
 *     clock (`silence`).
 *  4. The event's own transition (the vocabulary above). Nothing becomes
 *     `done` by silence (FR-14), and no rule can raise `done` (FR-34).
 */
export function mergeFleetSessionEvidence(
	prev: FleetSessionStatusSnapshot,
	evidence: FleetSessionEvidence,
	ctx: FleetSessionMergeContext
): FleetSessionMergeResult {
	const unchanged: FleetSessionMergeResult = {
		next: prev,
		changed: false,
		attentionChanged: false,
		guarded: false,
		finished: false
	};
	if (prev.state === 'ended') return unchanged;
	const at = Number.isFinite(evidence.at) ? evidence.at : prev.lastEvidenceAt;
	// Silence is the clock, not evidence: it never restarts the idle clock.
	const lastEvidenceAt = evidence.event === 'silence' ? prev.lastEvidenceAt : Math.max(prev.lastEvidenceAt, at);
	const next: FleetSessionStatusSnapshot = { ...prev, lastEvidenceAt };
	let changed = false;
	let attentionChanged = false;
	let finished = false;

	const setState = (state: FleetSessionState, outcome?: FleetSessionOutcome | null) => {
		const moved = next.state !== state;
		if (moved) {
			next.state = state;
			next.stateChangedAt = at;
			changed = true;
		}
		if (outcome !== undefined && next.outcome !== outcome) {
			next.outcome = outcome;
			changed = true;
		}
		// A lower source only CONFIRMING a state never takes the guard over from a higher one.
		if (
			moved ||
			prev.stateSource === null ||
			FLEET_SESSION_EVIDENCE_PRECEDENCE[evidence.source] >= FLEET_SESSION_EVIDENCE_PRECEDENCE[prev.stateSource]
		) {
			next.stateSource = evidence.source;
			next.stateSourceAt = at;
		}
	};
	const setAttention = (attention: FleetSessionAttention | null) => {
		if (next.attention === attention) return;
		if (next.attention && attention && next.attention.key === attention.key) {
			// Same edge: only richer content updates it; the raise time stays.
			const merged: FleetSessionAttention = {
				...attention,
				raisedAt: next.attention.raisedAt,
				acknowledgedAt: next.attention.acknowledgedAt
			};
			if (JSON.stringify(merged) === JSON.stringify(next.attention)) return;
			next.attention = merged;
			attentionChanged = true;
			return;
		}
		next.attention = attention;
		attentionChanged = true;
	};
	const clearPrompt = () => {
		if (next.attention) setAttention(null);
	};
	const finish = (): FleetSessionMergeResult => {
		if (changed || attentionChanged) {
			next.lastEvidence = {
				source: evidence.source,
				event: evidence.event,
				at,
				...(evidence.rule ? { rule: evidence.rule } : {})
			};
		}
		return { next, changed, attentionChanged, guarded: false, finished };
	};

	// 2. A shell has no agent status (FR-19, U20).
	if (ctx.provider === 'shell') {
		if (evidence.event === 'activity' && (prev.state === 'idle' || prev.state === 'starting')) setState('working');
		else if (
			evidence.event === 'silence' &&
			prev.state !== 'idle' &&
			at - prev.lastEvidenceAt >= FLEET_SESSION_IDLE_AFTER_MS
		)
			setState('idle');
		return finish();
	}

	// 3. The precedence guard (FR-13).
	if (
		!UNGUARDED_EVENTS.has(evidence.event) &&
		prev.stateSource !== null &&
		FLEET_SESSION_EVIDENCE_PRECEDENCE[evidence.source] < FLEET_SESSION_EVIDENCE_PRECEDENCE[prev.stateSource] &&
		at - prev.stateSourceAt < FLEET_SESSION_PRECEDENCE_GUARD_MS
	) {
		return { ...unchanged, next: { ...prev, lastEvidenceAt: next.lastEvidenceAt }, guarded: true };
	}

	const userLine = boundText(evidence.userLine, FLEET_SESSION_LINE_MAX_CHARS);
	const agentLine = boundText(evidence.agentLine, FLEET_SESSION_LINE_MAX_CHARS);
	const inBoundary = !prev.promptSinceStart || (prev.boundaryUntil !== null && at <= prev.boundaryUntil);

	// 4. The event's own transition.
	switch (evidence.event) {
		case 'session-start': {
			setState('working', null);
			next.boundaryUntil = at + FLEET_SESSION_BOUNDARY_MS;
			next.promptSinceStart = false;
			changed = true;
			clearPrompt();
			break;
		}
		case 'prompt': {
			setState('working', null);
			next.promptSinceStart = true;
			next.boundaryUntil = null;
			next.turn = prev.turn + 1;
			if (userLine !== null && userLine !== next.userLine) next.userLine = userLine || null;
			next.agentLine = null;
			changed = true;
			clearPrompt();
			break;
		}
		case 'permission':
		case 'question':
		case 'blocked': {
			const reason: FleetSessionAttentionReason = evidence.event;
			if (prev.state === 'needs_you' && prev.attention && prev.attention.reason === reason) {
				// The same prompt again (a rule re-reading the screen, a confirming notification):
				// keep the edge; take richer content when this report has it.
				if (evidence.confirmOnly) {
					next.stateSource = prev.stateSource;
					next.stateSourceAt = prev.stateSourceAt;
					break;
				}
				const fresh = attentionFor(ctx, prev, reason, evidence, prev.edges);
				const richer =
					(fresh.options.length > 0 && prev.attention.options.length === 0) ||
					(fresh.prompt.length > 0 && prev.attention.prompt.length === 0);
				const samePrompt = fresh.prompt === prev.attention.prompt || fresh.prompt.length === 0;
				if (richer || samePrompt) {
					if (richer) setAttention({ ...fresh, key: prev.attention.key });
					setState('needs_you');
					break;
				}
				// A different prompt of the same reason: a new edge.
			}
			const edges = prev.edges + 1;
			next.edges = edges;
			setState('needs_you', null);
			setAttention(attentionFor(ctx, prev, reason, evidence, edges));
			break;
		}
		case 'stop': {
			if (agentLine !== null && (agentLine || null) !== prev.agentLine) {
				next.agentLine = agentLine || null;
				changed = true;
			}
			// A second stop for the same turn is no new news.
			if (prev.state === 'done') break;
			setState('done', 'success');
			if (inBoundary) {
				clearPrompt();
			} else {
				finished = true;
				const edges = prev.edges + 1;
				next.edges = edges;
				setAttention(
					attentionFor(
						ctx,
						prev,
						'finished',
						{ ...evidence, prompt: agentLine ?? prev.agentLine ?? '', options: [], promptId: undefined },
						edges
					)
				);
			}
			break;
		}
		case 'idle-prompt': {
			// The CLI waits for input: a running turn has ended (older CLIs, a missed Stop).
			if (prev.state !== 'working') break;
			setState('done', 'success');
			if (inBoundary) clearPrompt();
			else {
				finished = true;
				const edges = prev.edges + 1;
				next.edges = edges;
				setAttention(
					attentionFor(
						ctx,
						prev,
						'finished',
						{ ...evidence, prompt: prev.agentLine ?? '', options: [], promptId: undefined },
						edges
					)
				);
			}
			break;
		}
		case 'session-end': {
			// `ended` is the exit's (FL-04); after `/clear` the process goes on.
			if (prev.state === 'needs_you') setState('working');
			clearPrompt();
			break;
		}
		case 'working': {
			// A rule sees the CLI at work: a prompt answered in the terminal is over (U5).
			if (prev.state === 'working') break;
			setState('working', null);
			clearPrompt();
			break;
		}
		case 'idle-weak': {
			if (prev.state === 'working' && prev.stateSource !== 'hook') setState('idle');
			break;
		}
		case 'activity': {
			if (prev.state === 'idle' || prev.state === 'starting') setState('working', null);
			break;
		}
		case 'interrupt': {
			if (prev.state !== 'working' && prev.state !== 'needs_you') break;
			setState('done', 'interrupted');
			clearPrompt();
			break;
		}
		case 'answered': {
			clearPrompt();
			if (prev.state === 'needs_you') setState('working', null);
			break;
		}
		case 'silence': {
			if (prev.state !== 'working' && prev.state !== 'done' && prev.state !== 'starting') break;
			if (at - prev.lastEvidenceAt < FLEET_SESSION_IDLE_AFTER_MS) break;
			setState('idle');
			if (next.attention && next.attention.reason !== 'finished') clearPrompt();
			break;
		}
		case 'exit':
		case 'lost':
		default:
			break;
	}
	return finish();
}

/** True when a state change into `done` at `at` falls inside the boundary window (FR-39). */
export function isFleetSessionBoundaryDone(
	snapshot: Pick<FleetSessionStatusSnapshot, 'promptSinceStart' | 'boundaryUntil'>,
	at: number
): boolean {
	return !snapshot.promptSinceStart || (snapshot.boundaryUntil !== null && at <= snapshot.boundaryUntil);
}

// ─── Channel 0, node → platform (CONTRACTS §3.3) ────────────────────────────

/**
 * `session.status` — the merged state after every change (plan §6.5): the
 * platform applies it when `seq` is newer than the row's
 * `lastEvidence.detail.seq` (U5), and never for an ended session.
 */
export interface FleetSessionStatusMessage {
	type: 'session.status';
	sessionId: string;
	/** Monotonic per node (across restarts: never below the node's clock in ms). */
	seq: number;
	state: Exclude<FleetSessionState, 'ended'>;
	outcome: FleetSessionOutcome | null;
	/** ISO, the node's clock. */
	stateChangedAt: string;
	lastEvidence: FleetSessionLastEvidence;
	/** What was injected, when the node knows (it does for the sessions it launched). */
	hooks?: FleetSessionHooks;
	/** ISO end of the boundary window, or null. */
	boundaryUntil: string | null;
}

/**
 * `session.attention` — raised, updated or cleared (`attention: null`) on the
 * node (a prompt answered in the terminal clears it there first). `finished`
 * marks a turn that ended and is news (FR-38, FR-39).
 */
export interface FleetSessionAttentionMessage {
	type: 'session.attention';
	sessionId: string;
	seq: number;
	attention: FleetSessionAttention | null;
	finished?: boolean;
}

/** The channel-0 types FL-05 adds beside FL-04's `session.event` / `session.list`. */
export const FLEET_SESSION_STATUS_CONTROL_TYPES = ['session.status', 'session.attention'] as const;

function parseSeq(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function parseFleetSessionStatusMessage(value: unknown): FleetSessionStatusMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.status' || !isFleetDaemonSessionId(record.sessionId)) return null;
	const seq = parseSeq(record.seq);
	if (seq === null) return null;
	if (!isFleetSessionState(record.state) || record.state === 'ended') return null;
	const rawOutcome = record.outcome === null || record.outcome === undefined ? null : record.outcome;
	if (rawOutcome !== null && !isFleetSessionOutcome(rawOutcome)) return null;
	// Typed explicitly: consumers that compile this source with `strictNullChecks: false`
	// (packages/agent's ts-jest) do not get the `!== null` narrowing above.
	const outcome = rawOutcome as FleetSessionOutcome | null;
	if (typeof record.stateChangedAt !== 'string' || record.stateChangedAt.length > 40) return null;
	const lastEvidence = parseFleetSessionLastEvidence(record.lastEvidence);
	if (!lastEvidence) return null;
	const message: FleetSessionStatusMessage = {
		type: 'session.status',
		sessionId: record.sessionId,
		seq,
		state: record.state,
		outcome,
		stateChangedAt: record.stateChangedAt,
		lastEvidence,
		boundaryUntil:
			typeof record.boundaryUntil === 'string' && record.boundaryUntil.length <= 40 ? record.boundaryUntil : null
	};
	if (record.hooks !== undefined) {
		const hooks = parseFleetSessionHooks(record.hooks);
		if (hooks) message.hooks = hooks;
	}
	return message;
}

export function parseFleetSessionAttentionMessage(value: unknown): FleetSessionAttentionMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.attention' || !isFleetDaemonSessionId(record.sessionId)) return null;
	const seq = parseSeq(record.seq);
	if (seq === null) return null;
	let attention: FleetSessionAttention | null = null;
	if (record.attention !== null) {
		attention = parseFleetSessionAttention(record.attention);
		if (!attention) return null;
		// An attention names its own session.
		if (parseFleetSessionAttentionKey(attention.key)?.sessionId !== record.sessionId) return null;
	}
	const message: FleetSessionAttentionMessage = {
		type: 'session.attention',
		sessionId: record.sessionId,
		seq,
		attention
	};
	if (record.finished === true) message.finished = true;
	return message;
}

// ─── Platform → node: answering (CONTRACTS §3.3 `session.answer`) ───────────

/** `session.answer` params: the attention it answers and the option or the text (FR-28). */
export interface FleetSessionAnswerParams {
	key: string;
	answer: { optionId?: string; text?: string };
}

export function parseFleetSessionAnswerParams(value: unknown): FleetSessionAnswerParams | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!parseFleetSessionAttentionKey(record.key)) return null;
	const raw = record.answer;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const answerRecord = raw as Record<string, unknown>;
	const answer: FleetSessionAnswerParams['answer'] = {};
	if (answerRecord.optionId !== undefined) {
		if (typeof answerRecord.optionId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(answerRecord.optionId))
			return null;
		answer.optionId = answerRecord.optionId;
	}
	if (answerRecord.text !== undefined) {
		if (
			typeof answerRecord.text !== 'string' ||
			answerRecord.text.trim().length === 0 ||
			answerRecord.text.length > FLEET_SESSION_ANSWER_TEXT_MAX_CHARS ||
			answerRecord.text.includes('\0')
		)
			return null;
		answer.text = answerRecord.text;
	}
	// Exactly one of the two.
	if ((answer.optionId === undefined) === (answer.text === undefined)) return null;
	return { key: record.key as string, answer };
}

/** `POST /api/fleet/sessions/:id/answer` body (plan §5). */
export interface FleetSessionAnswerRequest {
	key: string;
	optionId?: string;
	text?: string;
}

/** Where an answer came from (the `node.session.answer` audit row's `source`, plan §11). */
export const FLEET_SESSION_ANSWER_SOURCES = ['card', 'detail', 'inbox', 'decisions', 'tool', 'cli'] as const;

export type FleetSessionAnswerSource = (typeof FLEET_SESSION_ANSWER_SOURCES)[number];

export function isFleetSessionAnswerSource(value: unknown): value is FleetSessionAnswerSource {
	return typeof value === 'string' && (FLEET_SESSION_ANSWER_SOURCES as readonly string[]).includes(value);
}

/** What `POST /sessions/:id/answer` answers (`202`): the key it cleared. */
export interface FleetSessionAnswerResponse {
	key: string;
	answered: true;
}

/** `fleet_sessions_question` / `GET` read of what a session asks (FL-05 P2, readOnly). */
export interface FleetSessionQuestionView {
	sessionId: string;
	state: FleetSessionState;
	attention: FleetSessionAttention | null;
	/** `hooks` · `rules` — where the prompt was read. */
	source: FleetSessionEvidenceSource | null;
}

/** `PATCH /api/fleet/sessions/:id` acknowledgement body (plan §5), beside FL-04's `{ title }`. */
export interface FleetSessionAcknowledgeRequest {
	acknowledge: string;
}

// ─── The board (P3, spec FR-41 … FR-44) ─────────────────────────────────────

/** The board's four columns, in order. */
export const FLEET_SESSION_BOARD_COLUMNS = ['needs_you', 'working', 'done', 'idle'] as const;

export type FleetSessionBoardColumn = (typeof FLEET_SESSION_BOARD_COLUMNS)[number];

/**
 * `GET /api/fleet/sessions?view=board` (P3, spec FR-41 … FR-44): the four
 * columns, each most-recently-moved first, of every live session on the
 * computers the reader may see sessions on (or one computer, `nodeId`), with
 * `done` sessions only for 24 h after they finished.
 */
export interface FleetSessionBoardResponse {
	columns: Record<FleetSessionBoardColumn, FleetSessionView[]>;
	/** ISO — when the platform read it. */
	generatedAt: string;
}

/** Most live sessions one board read returns (the board's 200-session first paint, spec §6, with headroom). */
export const FLEET_SESSION_BOARD_MAX = 400;

/**
 * The column a session sits in, or null when it is not on the board: ended
 * sessions are list-only (FR-42), `done` leaves the board
 * {@link FLEET_SESSION_DONE_BOARD_HOURS} after it finished, and a `starting`
 * session counts as working.
 */
export function fleetSessionBoardColumn(
	session: { state: FleetSessionState; stateChangedAt?: string | null; updatedAt?: string | null },
	now: number
): FleetSessionBoardColumn | null {
	switch (session.state) {
		case 'needs_you':
			return 'needs_you';
		case 'starting':
		case 'working':
			return 'working';
		case 'idle':
			return 'idle';
		case 'done': {
			const at = Date.parse(session.stateChangedAt ?? session.updatedAt ?? '');
			if (Number.isFinite(at) && now - at > FLEET_SESSION_DONE_BOARD_HOURS * 60 * 60_000) return null;
			return 'done';
		}
		default:
			return null;
	}
}
