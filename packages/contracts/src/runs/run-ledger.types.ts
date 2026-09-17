/**
 * Runs ledger + run receipt (AW-09 P1) — the wire shapes behind the
 * calendar-navigated ledger of every Agent run and the itemised receipt
 * of one run.
 *
 * Zero-dependency value types only. The read model lives in
 * `@ever-works/agent` (over the existing `agent_runs`, `agent_run_logs`,
 * `plugin_usage_events` and `credit_ledger_entries` rows — there is no
 * separate run store), the endpoints in `apps/api`, and the readers are
 * the dashboard and anything else that wants to answer "what did my
 * agents do, and what did it cost".
 *
 * Honesty rule shared by every numeric field below: `null` means "the
 * platform did not measure this", never "zero". A surface that renders
 * one of these must say so instead of printing `0`.
 */

/** The three window granularities the ledger navigates by. */
export const RUN_LEDGER_GRANULARITIES = ['day', 'week', 'month'] as const;
export type RunLedgerGranularity = (typeof RUN_LEDGER_GRANULARITIES)[number];

/** Run lifecycle states, mirroring `agent_runs.status`. */
export const RUN_LEDGER_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunLedgerStatus = (typeof RUN_LEDGER_STATUSES)[number];

/** States a run never leaves once reached. */
export const RUN_LEDGER_TERMINAL_STATUSES: readonly RunLedgerStatus[] = ['completed', 'failed', 'cancelled'];

/** What started a run, mirroring `agent_runs.triggerKind`. */
export const RUN_LEDGER_TRIGGER_KINDS = ['heartbeat', 'manual', 'task', 'chat', 'event', 'conversation'] as const;
export type RunLedgerTriggerKind = (typeof RUN_LEDGER_TRIGGER_KINDS)[number];

/** Default and maximum rows per ledger page. */
export const RUN_LEDGER_DEFAULT_LIMIT = 50;
export const RUN_LEDGER_MAX_LIMIT = 200;

/** How far back and forward the window may be moved. */
export const RUN_LEDGER_REACH_BACK_MONTHS = 12;
export const RUN_LEDGER_REACH_FORWARD_DAYS = 7;

/** Bounds on the free-text search over run summaries and errors. */
export const RUN_LEDGER_SEARCH_MIN_LENGTH = 2;
export const RUN_LEDGER_SEARCH_MAX_LENGTH = 200;

/** Maximum Agents one ledger request may filter by. */
export const RUN_LEDGER_MAX_AGENT_FILTERS = 20;

/**
 * How many failures from one schedule inside a window make the schedule,
 * rather than any single run, the likelier culprit.
 */
export const RUN_REPEAT_FAILURE_THRESHOLD = 2;

/**
 * Itemised usage rows are pruned after this many months, while the run
 * row (and its settled total) is kept. A receipt older than this can
 * still show the total but no longer the breakdown.
 */
export const RUN_USAGE_DETAIL_RETENTION_MONTHS = 12;

/** The resolved time window a ledger response was computed over. */
export interface RunLedgerWindow {
	granularity: RunLedgerGranularity;
	/** The calendar date (`YYYY-MM-DD`, in `timezone`) the window was anchored on. */
	anchorDate: string;
	/** Inclusive start instant, ISO 8601 (UTC). */
	from: string;
	/** Exclusive end instant, ISO 8601 (UTC). */
	to: string;
	/** IANA timezone the calendar boundaries were computed in. */
	timezone: string;
	/** True when the requested anchor fell outside the reachable range and was moved into it. */
	clamped: boolean;
}

/** Filters the ledger, the window totals and the calendar all accept. AND across fields, OR within a list. */
export interface RunLedgerFilters {
	agentIds?: string[];
	triggerKinds?: RunLedgerTriggerKind[];
	statuses?: RunLedgerStatus[];
	workId?: string;
	missionId?: string;
	/** Free text matched against the run summary and error message. */
	search?: string;
}

/** One row of the ledger — one Agent run. */
export interface RunLedgerRow {
	id: string;
	agentId: string;
	/** Null when the Agent row no longer exists. */
	agentName: string | null;
	/** True when the Agent has been archived; its historical runs still list. */
	agentArchived: boolean;
	triggerKind: string;
	status: RunLedgerStatus;
	startedAt: string | null;
	createdAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	/** Settled cost in integer cents; null until settlement stamps it. */
	costCents: number | null;
	totalTokens: number | null;
	/** The run's own summary, plain text. */
	summary: string | null;
	/** The run's error, plain text, already redacted and capped. */
	errorMessage: string | null;
	/** The live "what it is doing now" line, plain text. */
	currentActivity: string | null;
	taskId: string | null;
	taskTitle: string | null;
	missionId: string | null;
	missionTitle: string | null;
	workId: string | null;
	workName: string | null;
	/**
	 * `agent_heartbeat:<agentId>` when a schedule produced the run — the
	 * same key the unified schedule list uses — else null.
	 */
	scheduleKey: string | null;
	awaitingInput: boolean;
	queuedReason: string | null;
	attentionReason: string | null;
}

/** One cursor page of the ledger. */
export interface RunLedgerPage {
	window: RunLedgerWindow;
	rows: RunLedgerRow[];
	/** Opaque `<epochMillis>_<uuid>`; null on the last page. */
	nextCursor: string | null;
	/** Runs in the window matching the filters, across every page. */
	total: number;
	limit: number;
	/**
	 * Only answered for an empty, unfiltered window: true when the caller
	 * has runs outside it ("nothing ran on this day"), false when they have
	 * never had a run ("no runs yet"). Null whenever it was not checked.
	 */
	everRan: boolean | null;
}

/** A token count split by kind. Each part is null when it was not measured. */
export interface RunTokenSplit {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	total: number | null;
}

/** A schedule that produced repeated failures inside the window. */
export interface RunRepeatFailure {
	scheduleKey: string;
	agentId: string;
	agentName: string | null;
	failures: number;
}

/** Headline numbers for one window and filter set. */
export interface RunWindowStats {
	window: RunLedgerWindow;
	total: number;
	byStatus: Record<RunLedgerStatus, number>;
	byTrigger: Record<string, number>;
	/** Completed ÷ terminal, 0–100 with one decimal; null when nothing is terminal yet. */
	successRate: number | null;
	errorCount: number;
	/** Sum of recorded run durations. */
	totalDurationMs: number;
	/** Sum of settled run costs; null when no run in the window has a settled cost. */
	costCents: number | null;
	/** Runs in the window whose cost is not (yet) attributable. */
	unsettledRuns: number;
	tokens: RunTokenSplit;
	repeatFailures: RunRepeatFailure[];
}

/** One calendar day that had at least one run. */
export interface RunCalendarDay {
	/** `YYYY-MM-DD` in the caller's timezone. */
	date: string;
	runs: number;
	failures: number;
}

/** Days with runs in one calendar month. */
export interface RunCalendarMonth {
	/** `YYYY-MM`. */
	month: string;
	timezone: string;
	days: RunCalendarDay[];
	/** True when the month held more runs than were scanned; counts are then lower bounds. */
	truncated: boolean;
}

/** One line of a run's cost, grouped by capability and model. */
export interface RunCostLine {
	/** `ai`, `search`, `screenshot`, … as recorded on the usage row. */
	capability: string;
	/** Null for calls that never went through a model. */
	modelId: string | null;
	calls: number;
	units: number;
	costCents: number;
}

/**
 * What one run cost. Every figure comes from the same metering rows and
 * settlement stamp the Costs dashboard reads, so the two never disagree.
 */
export interface RunCostBreakdown {
	/** `agent_runs.costCents` — the settled total; null until settlement. */
	settledCents: number | null;
	/** Sum of the run's retained usage rows; null when none are retained. */
	meteredCents: number | null;
	/** True while the run is not terminal: every figure is "so far". */
	soFar: boolean;
	/** Credits debited for this run; null when no debit was recorded. */
	creditsDebited: number | null;
	/** False once the run is older than the usage-detail retention window. */
	detailRetained: boolean;
	tokens: RunTokenSplit;
	lines: RunCostLine[];
}

/** A Knowledge Base document this run cited. */
export interface RunKnowledgeCitation {
	documentId: string;
	workId: string;
	relevanceScore: number | null;
	citedAt: string;
}

/** The itemised account of one run. */
export interface RunReceipt {
	row: RunLedgerRow;
	cost: RunCostBreakdown;
	counts: { messages: number; toolCalls: number; filesTouched: number };
	filesTouched: string[];
	/** True when the run reached its capture cap and older timeline entries were dropped. */
	captureTruncated: boolean;
	knowledge: RunKnowledgeCitation[];
}
