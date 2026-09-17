/**
 * Agent status reason (AW-23 P1) — the single derived answer to "what is
 * this agent doing, and why is it not working?".
 *
 * Today an agent surfaces a six-value status enum and nothing else: the
 * detail hero prints the raw `paused` string, the card prints a coloured
 * chip, and neither says who paused it, when, or what broke. The reason
 * below is DERIVED server-side from the agent's status, its persisted halt
 * reason, its in-flight runs, its open decisions and its schedule, so the
 * compact card and the full card can never disagree — they call the same
 * resolver rather than each re-deriving a story in the browser.
 *
 * Zero-dependency value types only: the resolver lives in
 * `@ever-works/agent`, the endpoints in `apps/api`, and the renderer in
 * `apps/web`. Every string here is persisted in no table — the reason is
 * computed per request — but it IS a wire value, so members are added,
 * never renamed.
 */

/**
 * The closed set of reasons an agent surface may state.
 *
 * - `working`              — a run is in flight right now.
 * - `idle`                 — nothing running, nothing wrong; waiting for its
 *                            next schedule slot or for work to arrive.
 * - `waitingOnYou`         — at least one open escalation or pending approval
 *                            proposal is blocking it.
 * - `pausedByYou`          — a person pressed Pause.
 * - `blockedOnCredential`  — a provider rejected this agent's account, so it
 *                            halted after ONE failure instead of three.
 * - `stoppedByFailures`    — consecutive run failures reached the agent's own
 *                            `pauseAfterFailures` threshold.
 * - `stoppedAtACap`        — a spend cap stopped it. Defined and rendered
 *                            here; the caps that raise it arrive with the
 *                            costs-and-caps work, so nothing raises it yet.
 * - `stoppedByThePlatform` — an operator stopped agents platform-wide.
 * - `notStarted`           — a draft agent, or one that has never run.
 * - `archived`             — retired; read-only.
 */
export const AGENT_STATUS_REASONS = [
	'working',
	'idle',
	'waitingOnYou',
	'pausedByYou',
	'blockedOnCredential',
	'stoppedByFailures',
	'stoppedAtACap',
	'stoppedByThePlatform',
	'notStarted',
	'archived'
] as const;

export type AgentStatusReasonCode = (typeof AGENT_STATUS_REASONS)[number];

/** How a reason's dot paints. Colour is never the only carrier — see `AgentStatusDto.reason`. */
export type AgentStatusDotTone = 'green' | 'amber' | 'red' | 'grey' | 'greyOutline';

/**
 * One appearance per reason, decided once and shared by every surface.
 *
 * Accessibility: the dot is decoration. The reason headline and its
 * sub-line are what a screen reader announces, which is why no renderer
 * may show a dot without the sentence next to it.
 */
export const AGENT_STATUS_DOT: Record<AgentStatusReasonCode, AgentStatusDotTone> = {
	working: 'green',
	idle: 'grey',
	waitingOnYou: 'amber',
	pausedByYou: 'amber',
	blockedOnCredential: 'amber',
	stoppedByFailures: 'red',
	stoppedAtACap: 'amber',
	stoppedByThePlatform: 'amber',
	notStarted: 'greyOutline',
	archived: 'grey'
};

/**
 * How often a visible agent surface re-reads status. Imported by the
 * polling hook — never redeclared there, so the cadence has one home.
 */
export const AGENT_STATUS_POLL_INTERVAL_MS = 10_000;

/** Upper bound on one batched status read, so a roster poll is ONE query. */
export const AGENT_STATUS_BATCH_MAX = 100;

/** What the reason's action link points at, when the reason has one. */
export type AgentStatusLinkKind = 'run' | 'decision' | 'connection';

/**
 * The status half of an agent's identity, computed per request.
 *
 * Privacy: `note` is the human note from the pause dialog (secret-scanned
 * on write) and `subjectLabel` is a facade-resolved display name. Neither
 * carries a credential, a token fragment or a raw error body.
 */
export interface AgentStatusDto {
	agentId: string;
	reason: AgentStatusReasonCode;
	/** Link target for the reason's action, when there is one. */
	linkKind?: AgentStatusLinkKind;
	linkId?: string;
	/** The optional pause note, verbatim. Never set for an automatic halt. */
	note?: string | null;
	/** When the halt was written, or when the in-flight run started. ISO 8601. */
	since?: string | null;
	/** Consecutive halts for the SAME reason. `2` is what makes a loop visible. */
	repeatCount?: number;
	/** Display name of whatever refused the agent — never any part of a credential. */
	subjectLabel?: string | null;
	/** Consecutive run failures behind `stoppedByFailures`. */
	failureCount?: number;
	/** Open escalations + pending approval proposals behind `waitingOnYou`. */
	openDecisionCount?: number;
	/** The current activity line of the in-flight run, when there is one. */
	activity?: string | null;
	/** Runs still finishing after a pause landed. */
	inFlightCount: number;
	/** Runs parked because this agent is paused. */
	heldCount: number;
}
