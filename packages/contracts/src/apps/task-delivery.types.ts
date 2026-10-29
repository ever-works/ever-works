/**
 * APW-08 (plan §3.4, T7/T24/T56) — the App Work delivery and cost views.
 *
 * The delivery half (`TaskDeliveryView`, `TASK_DELIVERY_STATES`) is the shape the delivery chain
 * (T7–T9, T20–T23) will answer; it is published now so the web and the e2e helpers type against
 * one definition. The cost half is served today: `GET /api/tasks/:id/cost` answers
 * {@link TaskCostView} and `GET /api/works/:id/cost` answers {@link WorkCostRollup}, both from the
 * usage ledger and the Work's existing budget (no new spend account, FR-73).
 */

export const TASK_DELIVERY_STATES = [
	'merged',
	'building',
	'build_failed',
	'built',
	'deploying',
	'deploy_failed',
	'live',
	'closed_without_deploy'
] as const;
export type TaskDeliveryState = (typeof TASK_DELIVERY_STATES)[number];

/**
 * The states a reconciler still has work on (plan §2.4): a Task in one of them is visited on
 * every `app-change-delivery` tick. `live` and `closed_without_deploy` are terminal for the Task.
 */
export const TASK_DELIVERY_OPEN_STATES = [
	'merged',
	'building',
	'build_failed',
	'built',
	'deploying',
	'deploy_failed'
] as const satisfies readonly TaskDeliveryState[];

/** The states **Close anyway** / **Close without deploying** accepts (S9, S20, plan §4). */
export const TASK_DELIVERY_CLOSABLE_STATES = [
	'merged',
	'build_failed',
	'built',
	'deploy_failed'
] as const satisfies readonly TaskDeliveryState[];

/**
 * `{outcome}` of a `deploy_failed` chip (FR-30): APW-06's own terminal outcome — a failed
 * Deployment, a rolled-back one and one whose rollback itself failed are three different
 * chips, and a rolled-back Deployment is never reported as a plain failure. `live_with_warnings`
 * is only ever reported when the operator turned
 * `EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES` off (APW08-G25 / `CL-08-1`).
 */
export const TASK_DELIVERY_DEPLOY_OUTCOMES = [
	'failed',
	'rolled_back',
	'rollback_failed',
	'live_with_warnings'
] as const;
export type TaskDeliveryDeployOutcome = (typeof TASK_DELIVERY_DEPLOY_OUTCOMES)[number];

/** Plan §3.4 — the follow-up budget defaults (FR-37, FR-38; APW08-G25 / `CL-08-5`). */
export const APP_FOLLOW_UPS_PER_CHANGE_MAX = 2;
export const APP_FOLLOW_UPS_OPEN_PER_WORK_MAX = 3;
/** FR-36 — how many lines of the failure log a follow-up Task quotes, at most. */
export const APP_FAILURE_LOG_TAIL_LINES = 200;
/** Plan §6 — Tasks one `app-change-delivery` tick reconciles, at most. */
export const APP_DELIVERY_RECONCILE_BATCH = 200;
/** Plan §4 — `POST /api/tasks/:id/delivery/close` `{ note? }`, at most. */
export const TASK_DELIVERY_CLOSE_NOTE_MAX = 500;

/** Plan §4's error codes for the delivery routes (one 422 code per refusal family). */
export const TASK_DELIVERY_ERROR_CODES = ['notClosable', 'followUpLimit', 'notTracked'] as const;
export type TaskDeliveryErrorCode = (typeof TASK_DELIVERY_ERROR_CODES)[number];

/** `POST /api/tasks/:id/delivery/close`. */
export interface TaskDeliveryCloseRequest {
	note?: string | null;
}

/** `POST /api/tasks/:id/delivery/follow-up` — the S22 Inbox item's **Try once more**. */
export interface TaskDeliveryFollowUpRequest {
	escalationId: string;
}

/** `202` answer of `POST /api/tasks/:id/delivery/follow-up`. */
export interface TaskDeliveryFollowUpResponse {
	taskId: string;
}

export interface TaskDeliveryView {
	taskId: string;
	state: TaskDeliveryState | null;
	mergeCommitSha: string | null;
	pullRequest: { number: number; url: string; base: string; mergedAt: string | null } | null;
	build: { id: string; number: number | null; status: string; commitSha: string; logsUrl: string | null } | null;
	deployment: { id: string; number: number | null; status: string; outcome: string | null } | null;
	liveUrl: string | null;
	liveWithWarnings: boolean;
	carriedByLaterChange: boolean;
	followUps: Array<{ taskId: string; slug: string; status: string; automatic: boolean }>;
	history: Array<{ state: TaskDeliveryState; at: string; activityId: string | null }>;
}

/** One agent run of the Task and what it cost (the run receipt's own lines, summed). */
export interface TaskCostRun {
	runId: string;
	/** `null` when the ledger holds no priced line for the run yet. */
	costCents: number | null;
	/** The web page of the run's receipt. */
	receiptUrl: string;
	status: string | null;
	startedAt: string | null;
}

export interface TaskCostView {
	taskId: string;
	runs: TaskCostRun[];
	/**
	 * Build minutes the Task caused (plan §3.4). Empty until per-Task Build accounting lands:
	 * an App Build is billed to the repository's own CI (`payer: 'github'`) and the ledger does
	 * not attribute managed Build minutes to a Task yet.
	 */
	builds: Array<{
		buildId: string;
		runnerMinutes: number | null;
		payer: 'github' | 'ever-works';
		costCents: number | null;
	}>;
	/** Every usage row attributed to the Task (runs and anything else), in `currency`. */
	totalCents: number | null;
	currency: string;
	/** How many of the Task's runs are listed (newest first) and whether there are more. */
	runsLimit: number;
	runsTruncated: boolean;
}

/** The Work budget's alert state for the month (EW-602 thresholds). */
export type WorkCostAlert = 'none' | '75' | '90' | '100' | 'overage';

/** FR-73 — what an App Work spent in a month against its own budget. */
export interface WorkCostRollup {
	workId: string;
	/** `YYYY-MM` (UTC). */
	month: string;
	periodStart: string;
	periodEnd: string;
	currency: string;
	spendCents: number;
	/** The Work's global monthly cap, `null` when no budget is set. */
	capCents: number | null;
	/** `capCents - spendCents`, never below zero; `null` with no cap. */
	remainingCents: number | null;
	/** Rounded percent of the cap spent; `null` with no cap. */
	percentUsed: number | null;
	allowOverage: boolean;
	alert: WorkCostAlert;
}

/** `?month=` on `GET /api/works/:id/cost`. */
export const WORK_COST_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** How many of a Task's runs `GET /api/tasks/:id/cost` lists. */
export const TASK_COST_RUNS_LIMIT = 50;
