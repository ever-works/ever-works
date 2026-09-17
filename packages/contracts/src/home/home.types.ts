/**
 * Home (AW-19) — wire types for the morning read on the dashboard root.
 *
 * Home owns no data. The summary is one composed, read-only projection of
 * surfaces that already exist — the My Decisions queue, the Runs ledger, the
 * schedule aggregation, the Costs summary and the Live Feed — returned in one
 * response with a status per block, so a block that could not be read says so
 * instead of looking empty.
 *
 * Like the Live Feed contract, the summary carries STRUCTURE rather than
 * English: kinds, counts, instants and typed pointers. The web owns the words
 * and the routes. The only route strings on the wire are the schedule rows'
 * `href`, which the schedule aggregation already produces for its own view.
 */

import type { FeedEntryDto } from '../feed/feed.types.js';

/** Every read block of the morning stack, in default display order. */
export const HOME_BLOCK_IDS = ['needsYou', 'glance', 'today', 'thisWeek', 'workingNow', 'recentActivity'] as const;
export type HomeBlockId = (typeof HOME_BLOCK_IDS)[number];

// ── Caps and thresholds shared by the API and the web ─────────────────────

/** Decision rows previewed on Home; the header always carries the exact total. */
export const HOME_DECISIONS_PREVIEW = 5;
/** Rows of the "Also broken" sub-list. */
export const HOME_ALSO_BROKEN_MAX = 6;
/** Schedules that already fired today. */
export const HOME_TODAY_RAN_MAX = 3;
/** Schedules still due today before the overflow link. */
export const HOME_TODAY_DUE_MAX = 6;
/** Running Runs listed in Working now. */
export const HOME_WORKING_NOW_MAX = 5;
/** Entries of the recent-activity tail. */
export const HOME_ACTIVITY_MAX = 8;
/** Decision titles are cut to this many characters on the server. */
export const HOME_TITLE_MAX_CHARS = 120;
/** Recent-activity lines are cut to this many characters. */
export const HOME_ACTIVITY_MAX_CHARS = 120;
/** A Run's reported activity line is cut to this many characters. */
export const HOME_RUN_ACTIVITY_MAX_CHARS = 100;
/** A schedule owner's name is cut to this many characters. */
export const HOME_SCHEDULE_NAME_MAX_CHARS = 60;
/** Hard maximum of the composer. */
export const HOME_COMPOSER_MAX_CHARS = 2000;
/** The composer counter appears from this many characters. */
export const HOME_COMPOSER_COUNTER_FROM_CHARS = 1800;
/** Minimum trimmed length the composer submits. */
export const HOME_COMPOSER_MIN_CHARS = 3;
/** A Task title derived from the composer text never exceeds this. */
export const HOME_TASK_TITLE_MAX_CHARS = 80;
/** Success chips kept under the composer. */
export const HOME_COMPOSER_CHIPS_MAX = 3;
/** How long a success chip stays, in milliseconds. */
export const HOME_COMPOSER_CHIP_TTL_MS = 60_000;
/** A decision open this long is overdue (danger tone, header suffix). */
export const HOME_OVERDUE_HOURS = 72;
/** A decision open this long turns the waiting chip amber. */
export const HOME_WAITING_WARN_HOURS = 24;
/** A Run executing this long carries the neutral `long run` chip. */
export const HOME_LONG_RUN_MINUTES = 30;
/** A Run executing this long carries the amber `still going` chip. */
export const HOME_STILL_GOING_MINUTES = 120;
/** Background refresh cadence while the page is visible. */
export const HOME_REFRESH_MS = 60_000;
/** Independent time budget of each block inside one summary build. */
export const HOME_BLOCK_BUDGET_MS = 1500;
/** A summary may be served from a cache this fresh for the same user, scope and timezone. */
export const HOME_CACHE_TTL_MS = 10_000;
/** The rolling spend window of the This-week panel. */
export const HOME_SPEND_WINDOW_DAYS = 7;
/** Counters are exact up to this value and render `999+` beyond it. */
export const HOME_COUNTER_MAX = 999;
/** Cap bar turns amber at this percentage. */
export const HOME_CAP_WARN_PERCENT = 80;
/** Cap bar turns danger at this percentage. */
export const HOME_CAP_DANGER_PERCENT = 100;
/** Accounts younger than this many days see `Your workspace` expanded by default. */
export const HOME_NEW_ACCOUNT_DAYS = 7;

// ── Blocks ────────────────────────────────────────────────────────────────

export type HomeBlockStatus = 'ok' | 'failed';

/**
 * Why a block failed. A message KEY, never provider or database text:
 * `timeout` — the block exceeded its budget; `unavailable` — its source is not
 * wired in this deployment; `error` — its source threw.
 */
export type HomeBlockErrorKey = 'timeout' | 'unavailable' | 'error';

export const HOME_BLOCK_ERROR_KEYS: readonly HomeBlockErrorKey[] = ['timeout', 'unavailable', 'error'];

export interface HomeBlock<T> {
	status: HomeBlockStatus;
	/** Set when `status === 'failed'`. */
	errorKey?: HomeBlockErrorKey;
	/** Null exactly when the block failed — a failure is never an empty list. */
	data: T | null;
}

/** The Inbox kinds that ask the human to decide. */
export type HomeDecisionKind = 'question' | 'approval' | 'escalation';

export interface HomeDecisionOption {
	id: string;
	label: string;
}

/** One previewed decision: the head of the My Decisions queue. */
export interface HomeDecisionRow {
	/** The Inbox item id — the web opens it in My Decisions. */
	id: string;
	kind: HomeDecisionKind;
	/** Plain text, already cut to {@link HOME_TITLE_MAX_CHARS}. */
	title: string;
	agentName: string | null;
	createdAt: string;
	/** Milliseconds between `createdAt` and the summary's `computedAt`. */
	waitingMs: number;
	/** A parked Run or a blocked Task sits behind this decision. */
	blocking: boolean;
	/** The item's choices when it carries between 1 and 3 of them, else null. */
	options: HomeDecisionOption[] | null;
}

export interface HomeDecisions {
	/** At most {@link HOME_DECISIONS_PREVIEW}, in the My Decisions order. */
	rows: HomeDecisionRow[];
	/** Every open decision — never capped by the preview. */
	total: number;
	/** Open decisions waiting {@link HOME_OVERDUE_HOURS} hours or more. */
	overdueCount: number;
	/** Open decisions with a parked Run or a blocked Task behind them. */
	blockingCount: number;
}

/** The four time-bounded counters. Exact numbers; the web renders `999+`. */
export interface HomeGlance {
	/** Open decisions. */
	needsYou: number;
	/** Runs executing and not waiting on a human. */
	workingNow: number;
	/** Runs completed in today's window of the Runs ledger. */
	doneToday: number;
	/** Runs failed in today's window of the Runs ledger. */
	failedToday: number;
}

/** Every schedule kind the platform aggregates. None is ever dropped. */
export type HomeScheduleKind =
	| 'recurring_task'
	| 'agent_heartbeat'
	| 'work_schedule'
	| 'mission_tick'
	| 'source_validation'
	| 'data_sync'
	| 'inbound_trigger';

export const HOME_SCHEDULE_KINDS: readonly HomeScheduleKind[] = [
	'recurring_task',
	'agent_heartbeat',
	'work_schedule',
	'mission_tick',
	'source_validation',
	'data_sync',
	'inbound_trigger'
];

/** Disabled and ended schedules never reach Home; paused and errored ones do. */
export type HomeScheduleStatus = 'active' | 'paused' | 'error';

export interface HomeScheduleRow {
	/** The schedule aggregation's stable key. */
	id: string;
	kind: HomeScheduleKind;
	/** The owning entity's name, cut to {@link HOME_SCHEDULE_NAME_MAX_CHARS}. */
	name: string;
	/** Dashboard route of the owning entity, as the schedule aggregation reports it. */
	href: string;
	/** When it ran (`state: 'ran'`) or is due (`state: 'due'`). */
	at: string;
	state: 'ran' | 'due';
	status: HomeScheduleStatus;
}

export interface HomeToday {
	/** At most {@link HOME_TODAY_RAN_MAX}, earliest first. */
	ran: HomeScheduleRow[];
	/** At most {@link HOME_TODAY_DUE_MAX}, soonest first. */
	due: HomeScheduleRow[];
	/** Every schedule still due today, including those past the preview. */
	dueTotal: number;
}

export interface HomeSpendAccountCap {
	/** Spend this billing period across every scope of the account. */
	periodSpendCents: number;
	/** Null when no account-wide cap is set. */
	periodCapCents: number | null;
	percentUsed: number | null;
	blocked: boolean;
	allowOverage: boolean;
}

export interface HomeSpend {
	/** Always {@link HOME_SPEND_WINDOW_DAYS}. */
	windowDays: number;
	/** Spend in the rolling window, in the active scope only. */
	totalCents: number;
	currency: string;
	/** Runs in the same window and scope. */
	runsCount: number;
	/** Null when there were no runs — never a fabricated zero. */
	avgPerRunCents: number | null;
	/** Which scope the headline covers; the web supplies the Organization's name. */
	scope: { kind: 'organization' | 'personal' };
	/** Account-wide by definition. Never combined with the scoped numbers above. */
	accountCap: HomeSpendAccountCap;
	/** False only when the account has never recorded spend in any scope. */
	everSpent: boolean;
}

export interface HomeRunningRow {
	runId: string;
	agentId: string;
	/** Null when the Agent row no longer exists. */
	agentName: string | null;
	/** The line the Run last reported, cut to {@link HOME_RUN_ACTIVITY_MAX_CHARS}. */
	activity: string | null;
	startedAt: string | null;
	/** Milliseconds between `startedAt` and the summary's `computedAt`. */
	elapsedMs: number;
}

export interface HomeWorkingNow {
	/** Longest-running first, at most {@link HOME_WORKING_NOW_MAX}. */
	rows: HomeRunningRow[];
	total: number;
}

export interface HomeRecentActivity {
	/** The newest Live Feed entries, newest first, at most {@link HOME_ACTIVITY_MAX}. */
	entries: FeedEntryDto[];
}

/** The local calendar day the time-bounded blocks were computed over. */
export interface HomeDayWindow {
	/** `YYYY-MM-DD` in `timezone`. */
	date: string;
	/** Inclusive start instant (ISO, UTC). */
	from: string;
	/** Exclusive end instant (ISO, UTC). */
	to: string;
}

/**
 * The composed morning read. A block that was not asked for (`?blocks=`) is
 * absent rather than empty.
 */
export interface HomeSummaryDto {
	computedAt: string;
	/** The IANA timezone the day boundaries were computed in. */
	timezone: string;
	/** True when no usable timezone was known and UTC was used instead. */
	timezoneFallback: boolean;
	day: HomeDayWindow;
	needsYou?: HomeBlock<HomeDecisions>;
	glance?: HomeBlock<HomeGlance>;
	today?: HomeBlock<HomeToday>;
	thisWeek?: HomeBlock<HomeSpend>;
	workingNow?: HomeBlock<HomeWorkingNow>;
	recentActivity?: HomeBlock<HomeRecentActivity>;
}

// ── Pure helpers shared by both sides ─────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Whether `value` names a timezone the runtime can compute a day in. The rule
 * is "the runtime can format in it" rather than a fixed list, so current IANA
 * names (`Europe/Kyiv`) and `UTC` / `GMT` are accepted even where the runtime's
 * canonical list still spells them differently. It matches the Runs ledger's
 * window resolver, so Home and the ledger read "today" alike.
 */
export function isHomeTimezone(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export function isHomeBlockId(value: unknown): value is HomeBlockId {
	return typeof value === 'string' && (HOME_BLOCK_IDS as readonly string[]).includes(value);
}

/**
 * Parse a `blocks` selection from a CSV string or a string array. Returns the
 * de-duplicated ids in {@link HOME_BLOCK_IDS} order, or `null` when any entry
 * is not a block id (the caller refuses the request rather than guessing).
 */
export function parseHomeBlockIds(value: unknown): HomeBlockId[] | null {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
	if (!raw) return null;
	const wanted = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== 'string') return null;
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		if (!isHomeBlockId(trimmed)) return null;
		wanted.add(trimmed);
	}
	return HOME_BLOCK_IDS.filter((id) => wanted.has(id));
}

/**
 * One line of plain text no longer than `max` characters: whitespace runs
 * collapse to one space and a cut ends in a single `…`. Null for empty input.
 */
export function truncateHomeText(value: string | null | undefined, max: number): string | null {
	if (typeof value !== 'string') return null;
	const line = value.replace(/\s+/g, ' ').trim();
	if (line.length === 0) return null;
	if (line.length <= max) return line;
	return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Tone of a decision's waiting chip: neutral under 24 h, amber from 24 h, danger from 72 h. */
export function homeWaitingTone(waitingMs: number): 'neutral' | 'warning' | 'danger' {
	if (waitingMs >= HOME_OVERDUE_HOURS * HOUR_MS) return 'danger';
	if (waitingMs >= HOME_WAITING_WARN_HOURS * HOUR_MS) return 'warning';
	return 'neutral';
}

/** Whether a decision waiting this long counts as overdue. */
export function isHomeDecisionOverdue(waitingMs: number): boolean {
	return waitingMs >= HOME_OVERDUE_HOURS * HOUR_MS;
}

/** The staleness chip of a running Run: none, `long run` from 30 min, `still going` from 120 min. */
export function homeRunChip(elapsedMs: number): 'longRun' | 'stillGoing' | null {
	if (elapsedMs >= HOME_STILL_GOING_MINUTES * MINUTE_MS) return 'stillGoing';
	if (elapsedMs >= HOME_LONG_RUN_MINUTES * MINUTE_MS) return 'longRun';
	return null;
}

/** Tone of the account-wide cap bar: neutral below 80 %, amber from 80 %, danger from 100 %. */
export function homeCapTone(percentUsed: number): 'neutral' | 'warning' | 'danger' {
	if (percentUsed >= HOME_CAP_DANGER_PERCENT) return 'danger';
	if (percentUsed >= HOME_CAP_WARN_PERCENT) return 'warning';
	return 'neutral';
}
