/**
 * Fleet — Schedules on computers (FL-13, CONTRACTS §3.3, §4.4, §6, §7, §8,
 * §10, §10.1, R-2, R-11, R-29).
 *
 * A **Command schedule** is a Command (FL-12) that carries a cadence: a
 * command line, ONE computer and a time. Its definition is synced to the
 * machine, and the node runs it from its own timer loop — on the machine's
 * wall clock, in the machine owner's login shell, one run at a time, capped
 * at six hours — whether or not the platform is reachable, and reports the
 * runs when the link is up (CONTRACTS §6). An **Agent-session schedule**
 * (P2) is a recurring Task whose Agent is pinned to a computer (R-29); it
 * ticks on the platform because it must create a Run.
 *
 * In the unified Schedules view a Command schedule is the row
 * `node_schedule:<commandId>` (R-2: a read model, never a table).
 *
 * ## The clock
 *
 * One pure algorithm, shared by the platform (next fire, previews), the node
 * (its timer loop, the missed-run collapse) and the web (the dialog's next
 * three fires) — `Intl.DateTimeFormat` only, no dependency. Times are the
 * computer's own (`FleetNode.timeZone`):
 *
 *  - a wall time that does not exist on a spring-forward day (02:30 in
 *    Europe/Paris on the last Sunday of March) fires as far past the jump as
 *    it was scheduled before it (03:30), the way calendars do;
 *  - a wall time that happens twice on a fall-back day fires once, at the
 *    first of the two;
 *  - "every N minutes" is the cron `*\/N` of the minute field: it restarts at
 *    every hour (every 25 min = :00, :25, :50).
 *
 * ## Link (CONTRACTS §3.3, `schedule` family, consent `manage`)
 *
 * One short-lived channel per request, opened by the platform:
 *
 * ```
 *  platform                                              node
 *  { type: 'schedule.sync', params: { generation, definitions[] } } ──►  replaces its cache, re-arms the loop
 *                                   ◄──────────────────────────────────  { result: { generation, held, refused, next, timeZone } }
 *  { type: 'schedule.runs', params: { since } } ───────────────────────►  runs ended since, and the ones running
 *                                   ◄──────────────────────────────────  { result: { runs[], more, timeZone } }
 *  { type: 'schedule.runNow', params: { id, runId } } ─────────────────►  runs it now (one at a time → `busy`)
 *                                   ◄──────────────────────────────────  { result: { runId, startedAt } }
 * ```
 *
 * Pause, resume, edits, moves and deletes re-send the FULL set through
 * `schedule.sync` (the set is small; a full replace is idempotent). Every
 * node→platform shape here has a parser that answers `null` — never throws —
 * for anything it does not recognise (the node is a different release).
 */

import {
	boundFleetCommandEdge,
	FLEET_COMMAND_SANDBOX_SENTENCE,
	isFleetCommandCwd,
	isFleetCommandFailedReason,
	isFleetCommandId,
	isFleetCommandLine,
	isFleetCommandRunStatus,
	type FleetCommandFailedReason,
	type FleetCommandRunStatus
} from './fleet-commands.types.js';
import type { FleetLinkError } from './fleet-link.types.js';

// ─── Limits (CONTRACTS §6, §10, §10.1) ──────────────────────────────────────

/** A schedule's run is ended on the machine at six hours and recorded `timeout` (FR-14). */
export const FLEET_SCHEDULE_RUN_CAP_SEC = 21_600;

/** Runs whose full output the node keeps per schedule, and the history every surface lists (FR-15, FR-20). */
export const FLEET_SCHEDULE_HISTORY = 30;

/** Schedules one computer may hold (CONTRACTS §10); the 51st is `limit_exceeded` (FR-5). */
export const FLEET_SCHEDULES_PER_NODE = 50;

/** A fire missed while the node was not running runs once if the node starts within this (CONTRACTS §6, FR-16). */
export const FLEET_SCHEDULE_MISSED_GRACE_SEC = 3_600;

/** Consecutive failed runs that pause a schedule (CONTRACTS §6, FR-23). */
export const FLEET_SCHEDULE_FAILURE_PAUSE = 5;

/** Consecutive failed runs that raise `schedule-failed` under Needs a look (FR-24). */
export const FLEET_SCHEDULE_FAILURE_ALERT = 2;

/** Longest schedule name (CONTRACTS §10: 120 characters). */
export const FLEET_SCHEDULE_NAME_MAX_LENGTH = 120;

/** Longest Agent prompt of an Agent-session schedule, in UTF-8 bytes (CONTRACTS §10: 16 KiB). */
export const FLEET_SCHEDULE_PROMPT_MAX_BYTES = 16 * 1024;

/** Schedule writes one person may make per minute (CONTRACTS §10.1). */
export const FLEET_SCHEDULE_WRITES_PER_MINUTE = 30;

/** How often the platform asks every linked computer for its schedule runs (plan §10). */
export const FLEET_SCHEDULE_RECONCILE_CRON = '*/5 * * * *';

/** How long a deleted schedule's history stays readable (spec U13). */
export const FLEET_SCHEDULE_DELETED_RETENTION_DAYS = 30;

/** Runs one `schedule.runs` answer carries at most (`more: true` past it). */
export const FLEET_SCHEDULE_RUNS_PAGE = 500;

/** The breaker's "Pause all on this computer" can be undone this long (FR-22, AW-10's 15 minutes). */
export const FLEET_SCHEDULE_BREAKER_UNDO_MS = 15 * 60_000;

/** The breaker pauses at most this many schedules at once (FR-22, AW-10's cap). */
export const FLEET_SCHEDULE_BREAKER_CAP = 500;

/** `POST /api/fleet/nodes/:id/schedules/pause-all` (FL-13 P2) — what the breaker did. */
export interface FleetSchedulePauseAllResult {
	paused: number;
	/** Of those, how many had a run in flight (it finishes; nothing new starts). */
	running: number;
	/** The instant the breaker stamped (`pausedAt`), the key of its Undo. */
	breakerAt: string;
	undoUntil: string;
}

/** `details` of the breaker's `confirmation_required` (FR-22: the count and the runs in flight). */
export interface FleetSchedulePauseAllConfirmation {
	class: 'confirm';
	action: 'pause-all';
	nodeId: string;
	nodeName: string;
	count: number;
	running: number;
}

/** The kill switch stops the node's loop and its in-flight runs within this (FR-17). */
export const FLEET_SCHEDULE_KILL_SWITCH_STOP_MS = 10_000;

/** The source a Command schedule is in the unified Schedules view (R-2). */
export const FLEET_NODE_SCHEDULE_SOURCE = 'node_schedule' as const;

/** `node_schedule:<commandId>` — the row id of a Command schedule in the Schedules view (FR-1). */
export function fleetNodeScheduleRowId(commandId: string): string {
	return `${FLEET_NODE_SCHEDULE_SOURCE}:${commandId}`;
}

/** What a Command schedule's row and dialog say about spend (FR-29). */
export const FLEET_SCHEDULE_NO_CREDITS_SENTENCE =
	'Runs a command on your computer — it spends no model tokens or credits.';

/** The sentence every confirmation of a Command schedule carries, verbatim (FR-25). */
export const FLEET_SCHEDULE_SANDBOX_SENTENCE: typeof FLEET_COMMAND_SANDBOX_SENTENCE = FLEET_COMMAND_SANDBOX_SENTENCE;

// ─── States (CONTRACTS §4.4) ────────────────────────────────────────────────

/** Why a schedule is paused (CONTRACTS §4.4: `user · failures · breaker`). */
export const FLEET_SCHEDULE_PAUSED_REASONS = ['user', 'failures', 'breaker'] as const;

export type FleetSchedulePausedReason = (typeof FLEET_SCHEDULE_PAUSED_REASONS)[number];

export function isFleetSchedulePausedReason(value: unknown): value is FleetSchedulePausedReason {
	return typeof value === 'string' && (FLEET_SCHEDULE_PAUSED_REASONS as readonly string[]).includes(value);
}

/**
 * Where the machine's copy of a schedule stands:
 *  - `synced` — the machine applied the set this schedule is in;
 *  - `pending` — changed since, and the machine has not answered yet ("will
 *    sync when build-01 is back", spec U1);
 *  - `unsupported` — the node is older than schedules (spec U11);
 *  - `refused` — the machine refused this definition (a folder outside its
 *    allowed roots), with the reason.
 */
export const FLEET_SCHEDULE_SYNC_STATES = ['synced', 'pending', 'unsupported', 'refused'] as const;

export type FleetScheduleSyncState = (typeof FLEET_SCHEDULE_SYNC_STATES)[number];

/** NEVER RUNS reasons a machine introduces (FR-21). */
export const FLEET_SCHEDULE_NEVER_RUNS_REASONS = ['consent-missing', 'node-removed', 'node-unsupported'] as const;

export type FleetScheduleNeverRunsReason = (typeof FLEET_SCHEDULE_NEVER_RUNS_REASONS)[number];

export function isFleetScheduleNeverRunsReason(value: unknown): value is FleetScheduleNeverRunsReason {
	return typeof value === 'string' && (FLEET_SCHEDULE_NEVER_RUNS_REASONS as readonly string[]).includes(value);
}

/** What started a run on the machine. */
export const FLEET_SCHEDULE_RUN_TRIGGERS = ['timer', 'catch-up', 'run-now'] as const;

export type FleetScheduleRunTrigger = (typeof FLEET_SCHEDULE_RUN_TRIGGERS)[number];

export function isFleetScheduleRunTrigger(value: unknown): value is FleetScheduleRunTrigger {
	return typeof value === 'string' && (FLEET_SCHEDULE_RUN_TRIGGERS as readonly string[]).includes(value);
}

// ─── Cadence (CONTRACTS §4.4) ───────────────────────────────────────────────

/**
 * The stored cadence: `{ kind, expr, at, timezone: 'node' }` (CONTRACTS §4.4).
 *
 *  - `interval` — `expr` is the minutes, `'1'` … `'59'`, or `'60'` (hourly);
 *  - `daily` — `at` is `HH:MM`;
 *  - `weekdays` — Monday to Friday, `at` is `HH:MM`;
 *  - `cron` — `expr` is a five-field cron expression ("specific days" is a
 *    cron `M H * * 1,3,5`).
 *
 * Always interpreted in the computer's time zone (`timezone: 'node'`).
 */
export const FLEET_SCHEDULE_CADENCE_KINDS = ['interval', 'cron', 'daily', 'weekdays'] as const;

export type FleetScheduleCadenceKind = (typeof FLEET_SCHEDULE_CADENCE_KINDS)[number];

export interface FleetScheduleCadence {
	kind: FleetScheduleCadenceKind;
	expr?: string;
	at?: string;
	timezone: 'node';
}

/**
 * The six forms a person picks from (spec FR-6, §5.2), as the dialog and the
 * CLI hold them. {@link fleetScheduleCadenceFromForm} stores one;
 * {@link fleetScheduleFormFromCadence} reads one back for editing.
 */
export type FleetScheduleCadenceForm =
	| { form: 'every'; minutes: number }
	| { form: 'hourly' }
	| { form: 'daily'; at: string }
	| { form: 'weekdays'; at: string }
	| { form: 'days'; days: number[]; at: string }
	| { form: 'cron'; expr: string };

export const FLEET_SCHEDULE_CADENCE_FORMS = ['every', 'hourly', 'daily', 'weekdays', 'days', 'cron'] as const;

export type FleetScheduleCadenceFormName = (typeof FLEET_SCHEDULE_CADENCE_FORMS)[number];

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` on a 24-hour clock. */
export function isFleetScheduleClockTime(value: unknown): value is string {
	return typeof value === 'string' && HH_MM.test(value);
}

/** One parsed cron expression: the values each field allows. */
export interface FleetCronFields {
	minutes: number[];
	hours: number[];
	days: number[];
	months: number[];
	/** 0 = Sunday … 6 = Saturday (7 is read as 0). */
	weekdays: number[];
	/** The day-of-month field is not `*` (cron OR semantics when both are restricted). */
	dayRestricted: boolean;
	weekdayRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseCronValue(token: string, names: readonly string[] | null, offset: number): number | null {
	if (/^\d{1,2}$/.test(token)) return Number(token);
	if (names) {
		const index = names.indexOf(token.toLowerCase());
		if (index >= 0) return index + offset;
	}
	return null;
}

/** One cron field as the sorted values it allows, or null when it is malformed or out of range. */
function parseCronField(
	field: string,
	min: number,
	max: number,
	names: readonly string[] | null = null,
	nameOffset = 0
): number[] | null {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		if (part.length === 0) return null;
		const [range, stepText, extra] = part.split('/');
		if (extra !== undefined) return null;
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d{1,2}$/.test(stepText)) return null;
			step = Number(stepText);
			if (step < 1) return null;
		}
		let from: number;
		let to: number;
		if (range === '*') {
			from = min;
			to = max;
		} else if (range.includes('-')) {
			const [a, b, more] = range.split('-');
			if (more !== undefined) return null;
			const start = parseCronValue(a, names, nameOffset);
			const end = parseCronValue(b, names, nameOffset);
			if (start === null || end === null) return null;
			from = start;
			to = end;
		} else {
			const single = parseCronValue(range, names, nameOffset);
			if (single === null) return null;
			from = single;
			// `5/15` means "from 5, every 15" (to the end of the range).
			to = stepText !== undefined ? max : single;
		}
		if (from < min || to > max || from > to) return null;
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return [...values].sort((a, b) => a - b);
}

/** Parse a five-field cron expression (`minute hour day month weekday`), or null. */
export function parseFleetCron(expr: unknown): FleetCronFields | null {
	if (typeof expr !== 'string' || expr.length > 120) return null;
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const minutes = parseCronField(fields[0], 0, 59);
	const hours = parseCronField(fields[1], 0, 23);
	const days = parseCronField(fields[2], 1, 31);
	const months = parseCronField(fields[3], 1, 12, MONTH_NAMES, 1);
	const rawWeekdays = parseCronField(fields[4], 0, 7, WEEKDAY_NAMES, 0);
	if (!minutes || !hours || !days || !months || !rawWeekdays) return null;
	const weekdays = [...new Set(rawWeekdays.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
	return {
		minutes,
		hours,
		days,
		months,
		weekdays,
		dayRestricted: fields[2] !== '*' && !fields[2].startsWith('*/'),
		weekdayRestricted: fields[4] !== '*' && !fields[4].startsWith('*/')
	};
}

/** True when no day the cron names exists in any month it names, in any year (a 31 February). */
function cronNeverFires(fields: FleetCronFields): boolean {
	if (!fields.dayRestricted || fields.weekdayRestricted) return false;
	const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return fields.months.every((month) => fields.days.every((day) => day > longest[month - 1]));
}

/**
 * Read a cadence off the wire or a form, or say why not (spec FR-6, FR-28
 * `invalid`). Never throws. `timezone` is always `'node'`.
 */
export function parseFleetScheduleCadence(raw: unknown): {
	cadence: FleetScheduleCadence | null;
	error: string | null;
} {
	const refuse = (error: string) => ({ cadence: null, error });
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('choose when it runs');
	const record = raw as Record<string, unknown>;
	if (record.timezone !== undefined && record.timezone !== 'node') {
		return refuse("a schedule runs on the computer's own clock");
	}
	switch (record.kind) {
		case 'interval': {
			const minutes = typeof record.expr === 'number' ? record.expr : Number(record.expr);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
				return refuse('every N minutes takes 1 to 59 minutes (or hourly)');
			}
			return { cadence: { kind: 'interval', expr: String(minutes), timezone: 'node' }, error: null };
		}
		case 'daily':
		case 'weekdays': {
			if (!isFleetScheduleClockTime(record.at)) return refuse('the time is HH:MM on a 24-hour clock');
			return { cadence: { kind: record.kind, at: record.at, timezone: 'node' }, error: null };
		}
		case 'cron': {
			const expr = typeof record.expr === 'string' ? record.expr.trim().replace(/\s+/g, ' ') : '';
			const fields = parseFleetCron(expr);
			if (!fields) return refuse('a cron expression has five fields: minute hour day month weekday');
			if (cronNeverFires(fields)) return refuse('that cron expression names a day that never comes');
			return { cadence: { kind: 'cron', expr, timezone: 'node' }, error: null };
		}
		default:
			return refuse('choose when it runs');
	}
}

/** True when `raw` is a cadence the platform and the node accept. */
export function isValidFleetScheduleCadence(raw: unknown): raw is FleetScheduleCadence {
	return parseFleetScheduleCadence(raw).cadence !== null;
}

/** The stored cadence for one of the six forms (spec FR-6), or the reason it is not one. */
export function fleetScheduleCadenceFromForm(form: FleetScheduleCadenceForm): {
	cadence: FleetScheduleCadence | null;
	error: string | null;
} {
	switch (form.form) {
		case 'every':
			return parseFleetScheduleCadence({ kind: 'interval', expr: form.minutes });
		case 'hourly':
			return parseFleetScheduleCadence({ kind: 'interval', expr: 60 });
		case 'daily':
			return parseFleetScheduleCadence({ kind: 'daily', at: form.at });
		case 'weekdays':
			return parseFleetScheduleCadence({ kind: 'weekdays', at: form.at });
		case 'days': {
			if (!isFleetScheduleClockTime(form.at))
				return { cadence: null, error: 'the time is HH:MM on a 24-hour clock' };
			const days = [...new Set(form.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort(
				(a, b) => a - b
			);
			if (days.length === 0) return { cadence: null, error: 'pick at least one day' };
			const [hour, minute] = form.at.split(':').map(Number);
			return parseFleetScheduleCadence({ kind: 'cron', expr: `${minute} ${hour} * * ${days.join(',')}` });
		}
		case 'cron':
			return parseFleetScheduleCadence({ kind: 'cron', expr: form.expr });
		default:
			return { cadence: null, error: 'choose when it runs' };
	}
}

/** The form a stored cadence is edited in (a cron `M H * * d,d` reads back as specific days). */
export function fleetScheduleFormFromCadence(cadence: FleetScheduleCadence): FleetScheduleCadenceForm {
	switch (cadence.kind) {
		case 'interval': {
			const minutes = Number(cadence.expr);
			return minutes >= 60 ? { form: 'hourly' } : { form: 'every', minutes };
		}
		case 'daily':
			return { form: 'daily', at: cadence.at ?? '00:00' };
		case 'weekdays':
			return { form: 'weekdays', at: cadence.at ?? '00:00' };
		case 'cron':
		default: {
			const days = specificDaysOf(cadence.expr ?? '');
			if (days) return { form: 'days', days: days.days, at: days.at };
			return { form: 'cron', expr: cadence.expr ?? '' };
		}
	}
}

/** `M H * * d,d,…` with single minute and hour → the specific days and the time, else null. */
function specificDaysOf(expr: string): { days: number[]; at: string } | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return null;
	if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1]) || !/^[0-7](,[0-7])*$/.test(parts[4])) return null;
	const minute = Number(parts[0]);
	const hour = Number(parts[1]);
	if (minute > 59 || hour > 23) return null;
	const days = [...new Set(parts[4].split(',').map((day) => (Number(day) === 7 ? 0 : Number(day))))].sort(
		(a, b) => a - b
	);
	return { days, at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The cadence in a few words (English; the web renders its own keys from
 * {@link fleetScheduleFormFromCadence}): `every 30 min`, `hourly`,
 * `daily 08:30`, `weekdays 02:00`, `Mon, Wed 02:00`, `cron 0 2 1 * *`.
 */
export function describeFleetScheduleCadence(cadence: FleetScheduleCadence): string {
	const form = fleetScheduleFormFromCadence(cadence);
	switch (form.form) {
		case 'every':
			return form.minutes === 1 ? 'every minute' : `every ${form.minutes} min`;
		case 'hourly':
			return 'hourly';
		case 'daily':
			return `daily ${form.at}`;
		case 'weekdays':
			return `weekdays ${form.at}`;
		case 'days':
			return form.days.length === 7
				? `daily ${form.at}`
				: `${form.days.map((day) => DAY_LABELS[day]).join(', ')} ${form.at}`;
		case 'cron':
		default:
			return `cron ${(form as { expr: string }).expr}`;
	}
}

/** The cadence as one canonical string (the Schedules view's `cadenceRaw`). */
export function fleetScheduleCadenceRaw(cadence: FleetScheduleCadence): string {
	switch (cadence.kind) {
		case 'interval':
			return `every ${cadence.expr} min`;
		case 'daily':
			return `daily ${cadence.at}`;
		case 'weekdays':
			return `weekdays ${cadence.at}`;
		case 'cron':
		default:
			return cadence.expr ?? '';
	}
}

/** What each cadence fires on, as cron fields. */
function cadenceFields(cadence: FleetScheduleCadence): FleetCronFields | null {
	const all = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
	const base = {
		days: all(1, 31),
		months: all(1, 12),
		weekdays: all(0, 6),
		dayRestricted: false,
		weekdayRestricted: false
	};
	switch (cadence.kind) {
		case 'interval': {
			const minutes = Number(cadence.expr);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return null;
			if (minutes >= 60) return { ...base, minutes: [0], hours: all(0, 23) };
			const allowed: number[] = [];
			for (let minute = 0; minute < 60; minute += minutes) allowed.push(minute);
			return { ...base, minutes: allowed, hours: all(0, 23) };
		}
		case 'daily':
		case 'weekdays': {
			if (!isFleetScheduleClockTime(cadence.at)) return null;
			const [hour, minute] = cadence.at.split(':').map(Number);
			if (cadence.kind === 'daily') return { ...base, minutes: [minute], hours: [hour] };
			return { ...base, minutes: [minute], hours: [hour], weekdays: [1, 2, 3, 4, 5], weekdayRestricted: true };
		}
		case 'cron':
			return parseFleetCron(cadence.expr);
		default:
			return null;
	}
}

// ─── Time zones ─────────────────────────────────────────────────────────────

const ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
	const cached = formatters.get(zone);
	if (cached) return cached;
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		if (formatters.size > 200) formatters.clear();
		formatters.set(zone, formatter);
		return formatter;
	} catch {
		return null;
	}
}

/** An IANA time zone this runtime knows (`Europe/Paris`, `UTC`). */
export function isFleetTimeZone(value: unknown): value is string {
	return typeof value === 'string' && ZONE_PATTERN.test(value) && formatterFor(value) !== null;
}

/** The zone a schedule runs in: the computer's, else UTC when it never reported one. */
export function fleetScheduleZone(timeZone: string | null | undefined): string {
	return isFleetTimeZone(timeZone) ? timeZone : 'UTC';
}

/** The wall-clock fields of an instant in a zone. */
export interface FleetZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 0 = Sunday. */
	weekday: number;
}

export function fleetZonedParts(ms: number, zone: string): FleetZonedParts {
	const formatter = formatterFor(zone) ?? formatterFor('UTC');
	const parts: Record<string, number> = {};
	for (const part of formatter!.formatToParts(new Date(ms))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	const hour = parts.hour === 24 ? 0 : parts.hour;
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour,
		minute: parts.minute,
		second: parts.second,
		weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
	};
}

/** The zone's offset from UTC at an instant, in ms (Paris in summer: +7 200 000). */
function zoneOffsetMs(ms: number, zone: string): number {
	const floored = Math.floor(ms / 1000) * 1000;
	const p = fleetZonedParts(floored, zone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - floored;
}

/**
 * The instant a wall-clock minute happens in a zone. A minute that happens
 * twice (fall-back) answers the first; one that does not exist (spring
 * forward) answers the instant as far past the jump as the minute was
 * scheduled before it.
 */
export function fleetZonedInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	zone: string
): number {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const offsets = [
		...new Set([
			zoneOffsetMs(wall - 86_400_000, zone),
			zoneOffsetMs(wall, zone),
			zoneOffsetMs(wall + 86_400_000, zone)
		])
	];
	let best: number | null = null;
	for (const offset of offsets) {
		const candidate = wall - offset;
		const back = fleetZonedParts(candidate, zone);
		if (
			back.year === year &&
			back.month === month &&
			back.day === day &&
			back.hour === hour &&
			back.minute === minute &&
			(best === null || candidate < best)
		) {
			best = candidate;
		}
	}
	if (best !== null) return best;
	// A gap: the offset in force BEFORE the jump is the smaller one.
	return wall - Math.min(...offsets);
}

// ─── Next and previous fire ─────────────────────────────────────────────────

/** How far the clock looks for a fire: eight years and a day covers a 29 February across 2100. */
const MAX_SEARCH_DAYS = 366 * 8 + 1;

function dayMatches(fields: FleetCronFields, month: number, day: number, weekday: number): boolean {
	if (!fields.months.includes(month)) return false;
	if (fields.dayRestricted && fields.weekdayRestricted) {
		return fields.days.includes(day) || fields.weekdays.includes(weekday);
	}
	if (fields.dayRestricted) return fields.days.includes(day);
	if (fields.weekdayRestricted) return fields.weekdays.includes(weekday);
	return true;
}

/**
 * The first fire strictly after `afterMs` on the computer's clock, as epoch
 * ms, or null when the cadence never fires again (or is malformed). Pure;
 * `zone` defaults to UTC when it is not one this runtime knows.
 */
export function nextFleetScheduleFire(
	cadence: FleetScheduleCadence,
	timeZone: string | null | undefined,
	afterMs: number
): number | null {
	const fields = cadenceFields(cadence);
	if (!fields || !Number.isFinite(afterMs)) return null;
	const zone = fleetScheduleZone(timeZone);
	const startMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
	const start = fleetZonedParts(startMs, zone);
	for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
		const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!dayMatches(fields, month, day, date.getUTCDay())) continue;
		for (const hour of fields.hours) {
			if (offset === 0 && hour < start.hour) continue;
			for (const minute of fields.minutes) {
				if (offset === 0 && hour === start.hour && minute < start.minute) continue;
				const at = fleetZonedInstant(year, month, day, hour, minute, zone);
				if (at > afterMs) return at;
			}
		}
	}
	return null;
}

/**
 * The last fire at or before `atMs` on the computer's clock, or null. What
 * the node reads when it starts: the fire it may have missed (FR-16).
 */
export function previousFleetScheduleFire(
	cadence: FleetScheduleCadence,
	timeZone: string | null | undefined,
	atMs: number
): number | null {
	const fields = cadenceFields(cadence);
	if (!fields || !Number.isFinite(atMs)) return null;
	const zone = fleetScheduleZone(timeZone);
	const end = fleetZonedParts(Math.floor(atMs / 60_000) * 60_000, zone);
	const hours = [...fields.hours].reverse();
	const minutes = [...fields.minutes].reverse();
	for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
		const date = new Date(Date.UTC(end.year, end.month - 1, end.day - offset));
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!dayMatches(fields, month, day, date.getUTCDay())) continue;
		for (const hour of hours) {
			if (offset === 0 && hour > end.hour) continue;
			for (const minute of minutes) {
				if (offset === 0 && hour === end.hour && minute > end.minute) continue;
				const at = fleetZonedInstant(year, month, day, hour, minute, zone);
				if (at <= atMs) return at;
			}
		}
	}
	return null;
}

/** The next `count` fires after `afterMs` (the dialog's preview, spec §5.2: three). */
export function previewFleetScheduleFires(
	cadence: FleetScheduleCadence,
	timeZone: string | null | undefined,
	afterMs: number,
	count = 3
): number[] {
	const out: number[] = [];
	let cursor = afterMs;
	for (let index = 0; index < Math.max(0, Math.min(10, count)); index += 1) {
		const next = nextFleetScheduleFire(cadence, timeZone, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next;
	}
	return out;
}

/**
 * What a node that was not running owes a schedule when it starts (FR-16,
 * CONTRACTS §6): the latest fire after `sinceMs` (exclusive — the last fire
 * it handled, or when it first received the definition) and at or before
 * `nowMs`. Several missed fires collapse to that ONE:
 *
 *  - within the grace window → `run` it once now, `scheduledFor` that fire;
 *  - past it → record it `skipped-offline`, once.
 *
 * Both null when nothing was missed.
 */
export function fleetScheduleCatchUp(input: {
	cadence: FleetScheduleCadence;
	timeZone: string | null | undefined;
	sinceMs: number;
	nowMs: number;
	graceSec?: number;
}): { run: number | null; skipped: number | null } {
	const grace = (input.graceSec ?? FLEET_SCHEDULE_MISSED_GRACE_SEC) * 1000;
	const latest = previousFleetScheduleFire(input.cadence, input.timeZone, input.nowMs);
	if (latest === null || latest <= input.sinceMs) return { run: null, skipped: null };
	if (input.nowMs - latest <= grace) return { run: latest, skipped: null };
	return { run: null, skipped: latest };
}

/** `Tue 02:00` — an instant on a zone's clock, as every surface prints a fire. */
export function formatFleetScheduleInstant(ms: number, timeZone: string | null | undefined): string {
	const zone = fleetScheduleZone(timeZone);
	const p = fleetZonedParts(ms, zone);
	return `${DAY_LABELS[p.weekday]} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** True when the two zones show different wall times at this instant (spec §5.1: the viewer's time in parentheses). */
export function fleetScheduleZonesDiffer(
	a: string | null | undefined,
	b: string | null | undefined,
	atMs: number
): boolean {
	return formatFleetScheduleInstant(atMs, a) !== formatFleetScheduleInstant(atMs, b);
}

// ─── Definitions on the machine (CONTRACTS §3.3 `schedule.sync`) ────────────

/** One Command schedule as the node caches and runs it. */
export interface FleetScheduleDefinition {
	/** The Command id. */
	id: string;
	name: string;
	/** As typed (the node needs the real line; the platform stores a redacted copy when it tripped the scanner). */
	command: string;
	/** Absent = the machine owner's home folder. */
	cwd?: string;
	cadence: FleetScheduleCadence;
	/** Always {@link FLEET_SCHEDULE_RUN_CAP_SEC}. */
	timeoutSec: number;
	/** ISO instant the platform last changed it. */
	revision: string;
}

/** True for a schedule name: 1 … 120 characters, no line break. */
export function isFleetScheduleName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.trim().length <= FLEET_SCHEDULE_NAME_MAX_LENGTH &&
		!/[\0\r\n]/.test(value)
	);
}

export function parseFleetScheduleDefinition(value: unknown): FleetScheduleDefinition | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.id) || !isFleetScheduleName(record.name) || !isFleetCommandLine(record.command)) {
		return null;
	}
	const { cadence } = parseFleetScheduleCadence(record.cadence);
	if (!cadence) return null;
	const timeoutSec =
		typeof record.timeoutSec === 'number' && Number.isFinite(record.timeoutSec)
			? Math.min(FLEET_SCHEDULE_RUN_CAP_SEC, Math.max(1, Math.floor(record.timeoutSec)))
			: FLEET_SCHEDULE_RUN_CAP_SEC;
	const definition: FleetScheduleDefinition = {
		id: record.id.toLowerCase(),
		name: record.name.trim(),
		command: record.command,
		cadence,
		timeoutSec,
		revision: typeof record.revision === 'string' && record.revision.length <= 40 ? record.revision : ''
	};
	if (record.cwd !== undefined && record.cwd !== null) {
		if (!isFleetCommandCwd(record.cwd)) return null;
		definition.cwd = record.cwd.trim();
	}
	return definition;
}

/** The link verbs of the `schedule` family (CONTRACTS §3.3). */
export const FLEET_SCHEDULE_LINK_VERBS = ['schedule.sync', 'schedule.runs', 'schedule.runNow'] as const;

export type FleetScheduleLinkVerb = (typeof FLEET_SCHEDULE_LINK_VERBS)[number];

export function isFleetScheduleLinkVerb(value: unknown): value is FleetScheduleLinkVerb {
	return typeof value === 'string' && (FLEET_SCHEDULE_LINK_VERBS as readonly string[]).includes(value);
}

/** `schedule.sync` params: the FULL set of this computer's enabled Command schedules. */
export interface FleetScheduleSyncParams {
	/** Grows by one on every change of the set (CONTRACTS §4.4 `syncGeneration`). */
	generation: number;
	definitions: FleetScheduleDefinition[];
}

/** Node side: the sync params, or null. A definition the node cannot read is skipped and listed in `refused`. */
export function parseFleetScheduleSyncParams(
	value: unknown
): { params: FleetScheduleSyncParams; unreadable: string[] } | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.generation !== 'number' || !Number.isInteger(record.generation) || record.generation < 0) {
		return null;
	}
	if (!Array.isArray(record.definitions) || record.definitions.length > FLEET_SCHEDULES_PER_NODE * 2) return null;
	const definitions: FleetScheduleDefinition[] = [];
	const unreadable: string[] = [];
	for (const raw of record.definitions) {
		const definition = parseFleetScheduleDefinition(raw);
		if (definition) {
			if (!definitions.some((existing) => existing.id === definition.id)) definitions.push(definition);
		} else {
			const id = (raw as { id?: unknown } | null)?.id;
			if (isFleetCommandId(id)) unreadable.push(id.toLowerCase());
		}
	}
	return { params: { generation: record.generation, definitions }, unreadable };
}

/** The node's answer to `schedule.sync`. */
export interface FleetScheduleSyncResult {
	/** The generation the machine applied. */
	generation: number;
	/** The ids the machine now holds and runs. */
	held: string[];
	/** Definitions it refused, with why (a folder outside its allowed roots → `invalid`). */
	refused: Array<{ id: string; error: FleetLinkError }>;
	/** The next fire the machine computed for each held id (ISO, or null) — the UI prefers it (plan §15). */
	next: Record<string, string | null>;
	/** The machine's zone as it computed them. */
	timeZone: string | null;
}

const isIsoInstant = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

function parseLinkError(value: unknown): FleetLinkError | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.code !== 'string' || typeof record.hint !== 'string') return null;
	return { code: record.code as FleetLinkError['code'], hint: record.hint.slice(0, 300) };
}

/** Platform side: the node's sync answer, bounded, or null. */
export function parseFleetScheduleSyncResult(value: unknown): FleetScheduleSyncResult | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.generation !== 'number' || !Number.isInteger(record.generation)) return null;
	const held = Array.isArray(record.held)
		? record.held.filter((id): id is string => isFleetCommandId(id)).map((id) => id.toLowerCase())
		: [];
	const refused: FleetScheduleSyncResult['refused'] = [];
	if (Array.isArray(record.refused)) {
		for (const entry of record.refused.slice(0, FLEET_SCHEDULES_PER_NODE * 2)) {
			const id = (entry as { id?: unknown } | null)?.id;
			const error = parseLinkError((entry as { error?: unknown } | null)?.error);
			if (isFleetCommandId(id) && error) refused.push({ id: id.toLowerCase(), error });
		}
	}
	const next: Record<string, string | null> = {};
	if (typeof record.next === 'object' && record.next !== null && !Array.isArray(record.next)) {
		for (const [id, at] of Object.entries(record.next as Record<string, unknown>)) {
			if (isFleetCommandId(id)) next[id.toLowerCase()] = isIsoInstant(at) ? at : null;
		}
	}
	return {
		generation: record.generation,
		held,
		refused,
		next,
		timeZone: isFleetTimeZone(record.timeZone) ? record.timeZone : null
	};
}

/** `schedule.runs` params: runs that ended at or after `since` (ISO; null = every run the machine keeps). */
export interface FleetScheduleRunsParams {
	since: string | null;
}

export function parseFleetScheduleRunsParams(value: unknown): FleetScheduleRunsParams {
	const since = (value as { since?: unknown } | null)?.since;
	return { since: isIsoInstant(since) ? since : null };
}

/** One run the machine made, as it reports it (head and tail on finish; CONTRACTS §6). */
export interface FleetScheduleRunReport {
	/** A uuid: the node's own for a timer run, the platform's for a Run now. */
	runId: string;
	/** The Command id. */
	scheduleId: string;
	/** The fire this run belongs to (ISO), null for Run now. */
	scheduledFor: string | null;
	/** ISO, the machine's clock. */
	startedAt: string;
	/** ISO, null while it runs. */
	endedAt: string | null;
	status: FleetCommandRunStatus;
	failedReason: FleetCommandFailedReason | null;
	exitCode: number | null;
	head: string;
	tail: string;
	truncated: boolean;
	capped: boolean;
	bytes: number;
	/** The machine kept the full output (one of its last 30). */
	kept: boolean;
	trigger: FleetScheduleRunTrigger;
}

/** The node's answer to `schedule.runs`. */
export interface FleetScheduleRunsResult {
	runs: FleetScheduleRunReport[];
	/** More runs ended since `since` than one answer carries. */
	more: boolean;
	timeZone: string | null;
}

const boundCount = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value)
		? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
		: 0;

/** Platform side: one run report, bounded, or null. */
export function parseFleetScheduleRunReport(value: unknown): FleetScheduleRunReport | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.runId) || !isFleetCommandId(record.scheduleId)) return null;
	if (!isIsoInstant(record.startedAt) || !isFleetCommandRunStatus(record.status)) return null;
	const endedAt = isIsoInstant(record.endedAt) ? record.endedAt : null;
	if (record.status !== 'running' && endedAt === null) return null;
	return {
		runId: record.runId.toLowerCase(),
		scheduleId: record.scheduleId.toLowerCase(),
		scheduledFor: isIsoInstant(record.scheduledFor) ? record.scheduledFor : null,
		startedAt: record.startedAt,
		endedAt,
		status: record.status,
		failedReason: isFleetCommandFailedReason(record.failedReason) ? record.failedReason : null,
		exitCode: typeof record.exitCode === 'number' && Number.isInteger(record.exitCode) ? record.exitCode : null,
		head: boundFleetCommandEdge(record.head),
		tail: boundFleetCommandEdge(record.tail),
		truncated: record.truncated === true,
		capped: record.capped === true,
		bytes: boundCount(record.bytes),
		kept: record.kept === true,
		trigger: isFleetScheduleRunTrigger(record.trigger) ? record.trigger : 'timer'
	};
}

export function parseFleetScheduleRunsResult(value: unknown): FleetScheduleRunsResult | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.runs)) return null;
	const runs: FleetScheduleRunReport[] = [];
	for (const raw of record.runs.slice(0, FLEET_SCHEDULE_RUNS_PAGE)) {
		const run = parseFleetScheduleRunReport(raw);
		if (run) runs.push(run);
	}
	return {
		runs,
		more: record.more === true || record.runs.length > FLEET_SCHEDULE_RUNS_PAGE,
		timeZone: isFleetTimeZone(record.timeZone) ? record.timeZone : null
	};
}

/** `schedule.runNow` params: the schedule and the run id the platform minted for it. */
export interface FleetScheduleRunNowParams {
	id: string;
	runId: string;
}

export function parseFleetScheduleRunNowParams(value: unknown): FleetScheduleRunNowParams | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.id) || !isFleetCommandId(record.runId)) return null;
	return { id: record.id.toLowerCase(), runId: record.runId.toLowerCase() };
}

// ─── Views and requests (what every surface reads) ──────────────────────────

/** The last run of a schedule, as its row shows it. */
export interface FleetScheduleLastRun {
	runId: string;
	status: FleetCommandRunStatus;
	failedReason: FleetCommandFailedReason | null;
	exitCode: number | null;
	scheduledFor: string | null;
	startedAt: string;
	endedAt: string | null;
}

/** One Command schedule (spec §5.1) — the computer tab, the CLI `--json` and the tools read it. */
export interface FleetScheduleView {
	kind: 'schedule';
	/** The Command id. */
	id: string;
	/** `node_schedule:<id>` — its id in the Schedules view and on the Schedules control routes. */
	scheduleId: string;
	name: string;
	nodeId: string;
	/** Null when the computer was removed (spec U16). */
	nodeName: string | null;
	/** The computer's IANA zone, null when it never reported one (UTC is used). */
	nodeTimeZone: string | null;
	command: string;
	commandRedacted: boolean;
	cwd: string | null;
	cadence: FleetScheduleCadence;
	/** `weekdays 02:00` (English; the web renders its own words from the cadence). */
	cadenceHuman: string;
	/** Not paused and not deleted. */
	enabled: boolean;
	pausedAt: string | null;
	pausedReason: FleetSchedulePausedReason | null;
	/** Null while paused, removed or never-runs. */
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastRun: FleetScheduleLastRun | null;
	/** A run is in flight on the machine (as last reported). */
	running: boolean;
	/** The platform holds the computer's link right now (Run now needs it, FR-19). */
	linkUp: boolean;
	/** Who asked for it (`agent` = an Agent's write a person approved, FL-13 P2). */
	requestedBy?: 'user' | 'agent';
	/** Consecutive failed runs, newest first (resets on a success). */
	failureStreak: number;
	syncState: FleetScheduleSyncState;
	/** Set with `syncState: 'refused'`. */
	syncError: FleetLinkError | null;
	/** NEVER RUNS on this machine (FR-21), with the hint naming what fixes it. */
	neverRuns: { reason: FleetScheduleNeverRunsReason; hint: string } | null;
	deletedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * `POST /api/fleet/commands` with a cadence (plan §5) — a Command schedule
 * on ONE computer (`nodeId`, or `nodeIds` with exactly one id).
 */
export interface FleetScheduleCreateRequest {
	name: string;
	nodeId?: string;
	nodeIds?: string[];
	command: string;
	/** Default: the machine owner's home folder. */
	cwd?: string;
	cadence: unknown;
	/** CONTRACTS §2.2 class `confirm`. */
	confirm?: boolean;
}

/** `PATCH /api/fleet/commands/:id` — every field but the kind; `nodeId` moves it (needs `confirm`). */
export interface FleetScheduleUpdateRequest {
	name?: string;
	nodeId?: string;
	command?: string;
	/** `null` or `''` = back to the home folder. */
	cwd?: string | null;
	cadence?: unknown;
	confirm?: boolean;
}

/** The act a schedule confirmation is for. */
export type FleetScheduleConfirmAction = 'create' | 'update' | 'move' | 'delete' | 'run';

/** `details` of a `confirmation_required` answer to a schedule write (FR-25). */
export interface FleetScheduleConfirmationDetails {
	class: 'confirm';
	action: FleetScheduleConfirmAction;
	name: string;
	/** Redacted when it tripped the secret scanner. */
	command: string;
	nodeId: string;
	nodeName: string;
	/** `PowerShell` on Windows, else `the login shell`. */
	shell: string;
	user: 'machine-owner';
	folder: string;
	cadenceHuman: string;
	nodeTimeZone: string | null;
	/** The next three fires (ISO). */
	next: string[];
	sentence: typeof FLEET_COMMAND_SANDBOX_SENTENCE;
	/** For a delete: the runs the history keeps for 30 days. */
	runCount?: number;
	/** For a move: where it goes. */
	toNodeId?: string;
	toNodeName?: string;
}

/** The skip reasons a run's history row says verbatim (spec §5.7). */
export function describeFleetScheduleSkip(status: FleetCommandRunStatus, computer: string): string | null {
	if (status === 'skipped-overlap') return 'Skipped — the previous run was still going';
	if (status === 'skipped-offline') return `Skipped — ${computer} was asleep past the grace window`;
	return null;
}

/** The hint a NEVER RUNS reason carries (spec §5.7, U2, U11, U16). */
export function fleetScheduleNeverRunsHint(reason: FleetScheduleNeverRunsReason, computer: string): string {
	switch (reason) {
		case 'consent-missing':
			return `NEVER RUNS · needs --manage — run \`ever-works-node start --manage\` on ${computer}`;
		case 'node-removed':
			return 'NEVER RUNS · computer removed — move it to another computer';
		case 'node-unsupported':
		default:
			return `NEVER RUNS · update the node on ${computer}`;
	}
}

// ─── Agent-session schedules (FL-13 P2, R-29) ───────────────────────────────

/**
 * The unattended-credential sentence an Agent-session schedule's dialog
 * carries VERBATIM in its body (spec FR-26), with the computer's name for
 * `{computer}`. The web renders its own copy from ONE i18n key
 * (`fleet.schedules.unattendedCredentialNote`); this is the API's and the CLI's.
 */
export function fleetScheduleUnattendedCredentialSentence(computer: string): string {
	return `Runs happen on ${computer} using the Claude Code or Codex sign-in — or the API key — that is set up on that computer. Ever Works keeps no copy of it. If that sign-in expires, the next run fails and this schedule appears under Needs a look until someone signs in on ${computer} again.`;
}

/** What an Agent-session schedule's row and dialog say about spend (spec §5.2). */
export const FLEET_SCHEDULE_AGENT_COST_SENTENCE = 'Each run appears in Runs with its cost like any other run.';

/**
 * The cadence as a five-field cron expression — what a recurring Task stores
 * (`recurrenceCron`), so an Agent-session schedule fires on the platform's
 * existing recurrence dispatcher (R-29: no second scheduler).
 */
export function fleetScheduleCadenceToCron(cadence: FleetScheduleCadence): string | null {
	switch (cadence.kind) {
		case 'interval': {
			const minutes = Number(cadence.expr);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return null;
			return minutes >= 60 ? '0 * * * *' : minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
		}
		case 'daily':
		case 'weekdays': {
			if (!isFleetScheduleClockTime(cadence.at)) return null;
			const [hour, minute] = cadence.at.split(':').map(Number);
			return `${minute} ${hour} * * ${cadence.kind === 'weekdays' ? '1-5' : '*'}`;
		}
		case 'cron':
			return parseFleetCron(cadence.expr) ? (cadence.expr ?? null) : null;
		default:
			return null;
	}
}

/** One Agent the Agent-session dialog offers on a computer (spec §5.2, U9). */
export interface FleetScheduleAgentOption {
	agentId: string;
	name: string;
	/** Pinned to THIS computer — the only Agents a schedule here can use. */
	pinned: boolean;
	/** Why it cannot be picked: pinned elsewhere, not pinned, or the scope has no Organization. */
	reason: 'pinnedElsewhere' | 'notPinned' | 'needsOrganization' | null;
}

/** `POST /api/fleet/nodes/:id/schedules/agent-session` (CONTRACTS §11.2). */
export interface FleetAgentSessionScheduleRequest {
	name: string;
	agentId: string;
	/** What the Agent is asked on every fire (3 … 16 KiB). */
	prompt: string;
	/** The agent CLI the session drives on the computer. */
	provider: 'claude-code' | 'codex';
	/** The checkout on that computer it works in; absent = the owner's home. */
	checkoutId?: string;
	cadence: unknown;
	confirm?: boolean;
}

/** What creating one answers: the recurring Task it is, and its row in the Schedules view. */
export interface FleetAgentSessionScheduleView {
	kind: 'agent-session';
	/** The recurring Task. */
	taskId: string;
	/** `recurring_task:<taskId>` — its row in the Schedules view (it keeps that source, FR-2). */
	scheduleId: string;
	name: string;
	nodeId: string;
	nodeName: string;
	agentId: string;
	agentName: string;
	cadence: FleetScheduleCadence;
	cadenceHuman: string;
	nextRunAt: string | null;
}

/** `details` of an Agent-session schedule's `confirmation_required` (FR-25, FR-26). */
export interface FleetAgentSessionScheduleConfirmation {
	class: 'confirm';
	action: 'create';
	kind: 'agent-session';
	name: string;
	agentName: string;
	nodeId: string;
	nodeName: string;
	provider: 'claude-code' | 'codex';
	cadenceHuman: string;
	nodeTimeZone: string | null;
	next: string[];
	/** {@link fleetScheduleUnattendedCredentialSentence}, verbatim. */
	credentialSentence: string;
	costSentence: typeof FLEET_SCHEDULE_AGENT_COST_SENTENCE;
}

/**
 * Consecutive failures at the head of a newest-first run list: a `failed`
 * or `timeout` run counts; `skipped-overlap` is neither (the previous run is
 * still going) and is passed over; anything else ends the streak (FR-23).
 */
export function fleetScheduleFailureStreak(runsNewestFirst: readonly { status: FleetCommandRunStatus }[]): number {
	let streak = 0;
	for (const run of runsNewestFirst) {
		if (run.status === 'running' || run.status === 'skipped-overlap') continue;
		if (run.status === 'failed' || run.status === 'timeout') streak += 1;
		else break;
	}
	return streak;
}
