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

/**
 * APW-08 T27 — `201` answer of `POST /api/tasks/:id/delivery/fix-task` (**Create a fix Task**):
 * the fix Task for the change's CURRENT failure. `created: false` = one was already filed for that
 * failure (automatically or by an earlier click) and that one is answered — one per failure.
 */
export interface TaskDeliveryFixTaskResponse {
	taskId: string;
	slug: string | null;
	created: boolean;
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
	/**
	 * APW-08 T27 (S20) — the section offers **Deploy now**: the change is `built`, the App Work
	 * deploys somewhere (its target is not None) and auto-deploy is off, so nothing will deploy it
	 * unless a person does. Absent on answers from a build without this field (= not offered).
	 */
	canDeployNow?: boolean;
}

/**
 * APW-08 T24 — the `GET /api/tasks?deliveryState=` token for a change that is not merged yet
 * (spec §6.1 **Waiting to merge**): no delivery state and an open (or draft) pull request.
 * Never a value of `tasks.deliveryState`, so it cannot collide with one.
 */
export const TASK_DELIVERY_FILTER_WAITING = 'waiting' as const;

/** One token of `GET /api/tasks?deliveryState=` (comma-separated). */
export type TaskDeliveryStateFilter = TaskDeliveryState | typeof TASK_DELIVERY_FILTER_WAITING;

/** Every token `GET /api/tasks?deliveryState=` accepts. */
export const TASK_DELIVERY_STATE_FILTERS: readonly TaskDeliveryStateFilter[] = [
	TASK_DELIVERY_FILTER_WAITING,
	...TASK_DELIVERY_STATES
];

/**
 * The App Work Tasks tab's **Delivery** select (spec §6.1): each option and the `deliveryState`
 * tokens it sends. Every delivery state belongs to exactly one option, so "Any" is the only way
 * to see every Task. `merged` waits for a Build and `built` waits for a Deployment, so each sits
 * with the step it waits on.
 */
export const TASK_DELIVERY_FILTER_GROUPS = {
	waiting: [TASK_DELIVERY_FILTER_WAITING],
	building: ['merged', 'building'],
	deploying: ['built', 'deploying'],
	live: ['live'],
	failed: ['build_failed', 'deploy_failed'],
	closed: ['closed_without_deploy']
} as const satisfies Record<string, readonly TaskDeliveryStateFilter[]>;
export type TaskDeliveryFilterGroup = keyof typeof TASK_DELIVERY_FILTER_GROUPS;

/**
 * APW-08 T24 — what `GET /api/tasks?includeDelivery=true` attaches to a row as `delivery` (plan
 * §4), `null` for a Task the chain does not track. The board chip's inputs, nothing more.
 */
export interface TaskDeliveryEmbed {
	state: TaskDeliveryState;
	/** The live Deployment's URL, only in `live`. */
	liveUrl: string | null;
	/** APW-06's failure outcome of the deciding Deployment, only in `deploy_failed`. */
	outcome: TaskDeliveryDeployOutcome | null;
	liveWithWarnings: boolean;
	carriedByLaterChange: boolean;
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
	/**
	 * APW-08 T48 (FR-70, ACC-08-34) — the containment the Task's latest Fleet run got, beside the
	 * run receipts: its execution path, whether the isolated home applied, every downgrade the node
	 * declared, and whether the owner allows that node's downgrade. `null` for a Task with no
	 * recorded Fleet run (every non-App Task, every cloud-only Task). Optional so an answer from a
	 * build without the field reads as "no record".
	 */
	containment?: TaskRunContainmentView | null;
	/**
	 * APW-08 T12 (S33, FR-12) — the Fleet nodes whose own latest containment report holds this
	 * Task's NEXT run (`needs_input`) until the owner allows the node: what the Task shows with
	 * `appRules.containmentDowngrade` and **Allow on this machine**, even before any run of it
	 * exists. Empty when nothing holds it; absent on a non-App Task.
	 */
	containmentHolds?: TaskRunContainmentView[];
}

/**
 * APW-08 FR-70 (plan §3.4) — what a Fleet run reported about its own containment, read through
 * `normalizeFleetAgentTaskContainment` (every coercion toward LESS containment) and narrowed to
 * what the Task page shows. Containment controls environment variables only: it is not a
 * filesystem boundary and carries no egress control (FR-12).
 */
export interface AppWorkRunContainment {
	executionPath: 'hardened' | 'ordinary';
	isolatedHome: boolean;
	downgrades: Array<{ control: string; reason: string }>;
	/** True when isolatedHome is false or an `isolated-home` downgrade is present. */
	needsOwnerAllowance: boolean;
}

/**
 * APW-08 T48 — one node's containment as the Task's Cost view shows it: the plan §3.4 record plus
 * where it came from and the owner's allowance for that node (the EW-807-style per-node store,
 * `POST /api/works/:id/app-runs/allow-containment`).
 */
export interface TaskRunContainmentView extends AppWorkRunContainment {
	/** The run that reported it; `null` = the node's latest report, not a run of this Task. */
	runId: string | null;
	/** The Fleet node that ran (or would run) it; `null` when the record names none. */
	nodeId: string | null;
	nodeName: string | null;
	/** ISO time of the report; `null` when unknown — and for a node that never reported one. */
	reportedAt: string | null;
	/** False when the node has never reported a readable containment record (treated as a downgrade). */
	reported: boolean;
	/** The Work owner allows this node's downgrade for this App Work (withdrawable). */
	allowedByOwner: boolean;
	/**
	 * The signed-in viewer enrolled this node, so **Allow on this machine** / **Withdraw** are
	 * theirs to press (the route answers 404 for anyone else's node). False for a node the
	 * record does not name.
	 */
	viewerOwnsNode?: boolean;
	/** With {@link allowedByOwner}: the `isolated-home` reason the owner accepted (S33). */
	acceptedDowngrade?: string | null;
}

/**
 * APW-08 T48 — one allowance in the per-Work store (`works.appRunContainmentAllowances`), shaped
 * like the EW-807 allow-list: one entry per node, added only by an explicit owner action, removed
 * by withdrawing it, never implied by another node or another Work.
 */
export interface AppRunContainmentAllowance {
	nodeId: string;
	/** ISO time the owner allowed it. */
	allowedAt: string;
	/** The user who allowed it. */
	allowedBy: string;
	/** The `isolated-home` reason the owner accepted, as the node reported it then (display only). */
	acceptedDowngrade: string | null;
}

/** Most allowances one App Work keeps — one per enrolled node, far above any real fleet. */
export const APP_RUN_CONTAINMENT_ALLOWANCES_MAX = 100;

/** `POST /api/works/:id/app-runs/allow-containment` (plan §4) — `204` on success. */
export interface AppRunAllowContainmentRequest {
	nodeId: string;
	allow: boolean;
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
