import { describe, expect, it } from 'vitest';

import {
	describeFleetScheduleCadence,
	fleetScheduleCadenceToCron,
	fleetScheduleUnattendedCredentialSentence,
	fleetScheduleCadenceFromForm,
	fleetScheduleCatchUp,
	fleetScheduleFailureStreak,
	fleetScheduleFormFromCadence,
	fleetZonedInstant,
	formatFleetScheduleInstant,
	isFleetTimeZone,
	nextFleetScheduleFire,
	parseFleetCron,
	parseFleetScheduleCadence,
	parseFleetScheduleDefinition,
	parseFleetScheduleRunReport,
	parseFleetScheduleSyncParams,
	parseFleetScheduleSyncResult,
	previewFleetScheduleFires,
	previousFleetScheduleFire,
	type FleetScheduleCadence
} from '../fleet-schedules.types.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const daily = (time: string): FleetScheduleCadence => ({ kind: 'daily', at: time, timezone: 'node' });
const weekdays = (time: string): FleetScheduleCadence => ({ kind: 'weekdays', at: time, timezone: 'node' });
const every = (minutes: number): FleetScheduleCadence => ({
	kind: 'interval',
	expr: String(minutes),
	timezone: 'node'
});
const cron = (expr: string): FleetScheduleCadence => ({ kind: 'cron', expr, timezone: 'node' });

describe('parseFleetScheduleCadence (FR-6)', () => {
	it('accepts the four stored kinds and always runs on the node clock', () => {
		expect(parseFleetScheduleCadence({ kind: 'interval', expr: 30 }).cadence).toEqual(every(30));
		expect(parseFleetScheduleCadence({ kind: 'daily', at: '02:00' }).cadence).toEqual(daily('02:00'));
		expect(parseFleetScheduleCadence({ kind: 'weekdays', at: '08:30', timezone: 'node' }).cadence).toEqual(
			weekdays('08:30')
		);
		expect(parseFleetScheduleCadence({ kind: 'cron', expr: ' 0  9 * * 1,3 ' }).cadence).toEqual(
			cron('0 9 * * 1,3')
		);
	});

	it.each([
		['interval 0', { kind: 'interval', expr: 0 }],
		['interval 61', { kind: 'interval', expr: 61 }],
		['a 24:00 time', { kind: 'daily', at: '24:00' }],
		['a missing time', { kind: 'weekdays' }],
		['a six-field cron', { kind: 'cron', expr: '0 0 0 * * *' }],
		['a minute out of range', { kind: 'cron', expr: '61 * * * *' }],
		['a 31 February', { kind: 'cron', expr: '0 0 31 2 *' }],
		['another zone', { kind: 'daily', at: '02:00', timezone: 'utc' }],
		['an unknown kind', { kind: 'yearly' }],
		['not an object', 'daily']
	])('refuses %s with a hint', (_label, raw) => {
		const parsed = parseFleetScheduleCadence(raw);
		expect(parsed.cadence).toBeNull();
		expect(typeof parsed.error).toBe('string');
	});

	it('reads cron names, ranges, steps and 7 as Sunday', () => {
		const fields = parseFleetCron('*/20 9-17/4 * jan,DEC mon-fri,7');
		expect(fields?.minutes).toEqual([0, 20, 40]);
		expect(fields?.hours).toEqual([9, 13, 17]);
		expect(fields?.months).toEqual([1, 12]);
		expect(fields?.weekdays).toEqual([0, 1, 2, 3, 4, 5]);
		expect(fields?.weekdayRestricted).toBe(true);
		expect(fields?.dayRestricted).toBe(false);
	});
});

describe('the six forms (FR-6, ACC-FL13-03)', () => {
	it('maps every form to a stored cadence and back', () => {
		expect(fleetScheduleCadenceFromForm({ form: 'every', minutes: 15 }).cadence).toEqual(every(15));
		expect(fleetScheduleCadenceFromForm({ form: 'hourly' }).cadence).toEqual(every(60));
		expect(fleetScheduleCadenceFromForm({ form: 'daily', at: '03:00' }).cadence).toEqual(daily('03:00'));
		expect(fleetScheduleCadenceFromForm({ form: 'weekdays', at: '02:00' }).cadence).toEqual(weekdays('02:00'));
		const days = fleetScheduleCadenceFromForm({ form: 'days', days: [3, 1, 3], at: '09:05' }).cadence;
		expect(days).toEqual(cron('5 9 * * 1,3'));
		expect(fleetScheduleFormFromCadence(days!)).toEqual({ form: 'days', days: [1, 3], at: '09:05' });
		expect(fleetScheduleFormFromCadence(every(60))).toEqual({ form: 'hourly' });
		expect(fleetScheduleFormFromCadence(cron('0 2 1 * *'))).toEqual({ form: 'cron', expr: '0 2 1 * *' });
	});

	it('refuses specific days with no day', () => {
		expect(fleetScheduleCadenceFromForm({ form: 'days', days: [], at: '09:00' }).cadence).toBeNull();
	});

	it('describes each form in a few words', () => {
		expect(describeFleetScheduleCadence(every(1))).toBe('every minute');
		expect(describeFleetScheduleCadence(every(30))).toBe('every 30 min');
		expect(describeFleetScheduleCadence(every(60))).toBe('hourly');
		expect(describeFleetScheduleCadence(daily('08:30'))).toBe('daily 08:30');
		expect(describeFleetScheduleCadence(weekdays('02:00'))).toBe('weekdays 02:00');
		expect(describeFleetScheduleCadence(cron('0 9 * * 1,3'))).toBe('Mon, Wed 09:00');
		expect(describeFleetScheduleCadence(cron('0 2 1 * *'))).toBe('cron 0 2 1 * *');
	});
});

describe('nextFleetScheduleFire — on the computer clock', () => {
	it('fires daily in the computer zone', () => {
		expect(iso(nextFleetScheduleFire(daily('02:00'), 'Europe/Paris', at('2026-01-14T12:00:00Z')))).toBe(
			'2026-01-15T01:00:00.000Z'
		);
	});

	it('skips the weekend for weekdays', () => {
		// 2026-01-16 is a Friday.
		expect(iso(nextFleetScheduleFire(weekdays('02:00'), 'Europe/Paris', at('2026-01-16T12:00:00Z')))).toBe(
			'2026-01-19T01:00:00.000Z'
		);
	});

	it('is strictly after the instant it is given', () => {
		expect(iso(nextFleetScheduleFire(daily('02:00'), 'UTC', at('2026-01-15T02:00:00Z')))).toBe(
			'2026-01-16T02:00:00.000Z'
		);
	});

	it('restarts every N minutes at the hour', () => {
		expect(iso(nextFleetScheduleFire(every(30), 'UTC', at('2026-01-01T00:10:00Z')))).toBe(
			'2026-01-01T00:30:00.000Z'
		);
		expect(iso(nextFleetScheduleFire(every(25), 'UTC', at('2026-01-01T00:51:00Z')))).toBe(
			'2026-01-01T01:00:00.000Z'
		);
	});

	it('fires hourly on the hour of a 45-minute zone', () => {
		// Kathmandu is UTC+05:45: local 06:00 is 00:15Z.
		expect(iso(nextFleetScheduleFire(every(60), 'Asia/Kathmandu', at('2026-01-01T00:00:00Z')))).toBe(
			'2026-01-01T00:15:00.000Z'
		);
	});

	it('keeps a half-hour zone', () => {
		expect(iso(nextFleetScheduleFire(daily('08:30'), 'Asia/Kolkata', at('2026-06-01T00:00:00Z')))).toBe(
			'2026-06-01T03:00:00.000Z'
		);
	});

	it('moves a time a spring-forward day skips past the jump (Paris, New York)', () => {
		// 2026-03-29: Paris goes 02:00 → 03:00; 02:30 becomes 03:30 CEST = 01:30Z.
		expect(iso(nextFleetScheduleFire(daily('02:30'), 'Europe/Paris', at('2026-03-28T12:00:00Z')))).toBe(
			'2026-03-29T01:30:00.000Z'
		);
		// 2026-03-08: New York goes 02:00 → 03:00; 02:30 becomes 03:30 EDT = 07:30Z.
		expect(iso(nextFleetScheduleFire(daily('02:30'), 'America/New_York', at('2026-03-07T12:00:00Z')))).toBe(
			'2026-03-08T07:30:00.000Z'
		);
	});

	it('fires a time a fall-back day repeats once, at the first of the two', () => {
		// 2026-10-25: Paris goes 03:00 → 02:00; the first 02:30 is CEST = 00:30Z.
		expect(iso(nextFleetScheduleFire(daily('02:30'), 'Europe/Paris', at('2026-10-24T12:00:00Z')))).toBe(
			'2026-10-25T00:30:00.000Z'
		);
		// …and the next fire is the next day's, not the repeated 02:30.
		expect(iso(nextFleetScheduleFire(daily('02:30'), 'Europe/Paris', at('2026-10-25T00:30:00Z')))).toBe(
			'2026-10-26T01:30:00.000Z'
		);
	});

	it('finds a 29 February years ahead', () => {
		expect(iso(nextFleetScheduleFire(cron('0 0 29 2 *'), 'UTC', at('2026-03-01T00:00:00Z')))).toBe(
			'2028-02-29T00:00:00.000Z'
		);
	});

	it('honours cron weekdays and falls back to UTC for an unknown zone', () => {
		// 2026-01-06 is a Tuesday.
		expect(iso(nextFleetScheduleFire(cron('0 9 * * 1,3'), 'Not/AZone', at('2026-01-06T10:00:00Z')))).toBe(
			'2026-01-07T09:00:00.000Z'
		);
	});

	it('previews the next three fires', () => {
		expect(previewFleetScheduleFires(daily('02:00'), 'UTC', at('2026-01-01T03:00:00Z')).map(iso)).toEqual([
			'2026-01-02T02:00:00.000Z',
			'2026-01-03T02:00:00.000Z',
			'2026-01-04T02:00:00.000Z'
		]);
	});
});

describe('previousFleetScheduleFire and the missed-run collapse (FR-16, ACC-FL13-08)', () => {
	it('finds the last fire at or before an instant', () => {
		expect(iso(previousFleetScheduleFire(daily('02:00'), 'UTC', at('2026-01-12T02:00:00Z')))).toBe(
			'2026-01-12T02:00:00.000Z'
		);
		expect(iso(previousFleetScheduleFire(daily('02:00'), 'UTC', at('2026-01-12T01:59:00Z')))).toBe(
			'2026-01-11T02:00:00.000Z'
		);
	});

	it('runs two missed fires ONCE inside the grace window', () => {
		const result = fleetScheduleCatchUp({
			cadence: daily('02:00'),
			timeZone: 'UTC',
			sinceMs: at('2026-01-10T02:00:00Z'),
			nowMs: at('2026-01-12T02:30:00Z')
		});
		expect(iso(result.run)).toBe('2026-01-12T02:00:00.000Z');
		expect(result.skipped).toBeNull();
	});

	it('records one skipped-offline past the grace window', () => {
		const result = fleetScheduleCatchUp({
			cadence: daily('02:00'),
			timeZone: 'UTC',
			sinceMs: at('2026-01-10T02:00:00Z'),
			nowMs: at('2026-01-12T03:00:01Z')
		});
		expect(result.run).toBeNull();
		expect(iso(result.skipped)).toBe('2026-01-12T02:00:00.000Z');
	});

	it('owes nothing when no fire passed since the last one', () => {
		expect(
			fleetScheduleCatchUp({
				cadence: daily('02:00'),
				timeZone: 'UTC',
				sinceMs: at('2026-01-10T02:00:00Z'),
				nowMs: at('2026-01-10T03:00:00Z')
			})
		).toEqual({ run: null, skipped: null });
	});

	it('is exact at the grace edge', () => {
		const base = { cadence: daily('02:00'), timeZone: 'UTC', sinceMs: at('2026-01-01T00:00:00Z') };
		expect(fleetScheduleCatchUp({ ...base, nowMs: at('2026-01-01T03:00:00Z') }).run).not.toBeNull();
		expect(fleetScheduleCatchUp({ ...base, nowMs: at('2026-01-01T03:00:01Z') }).skipped).not.toBeNull();
	});
});

describe('time zones', () => {
	it('knows IANA zones and refuses anything else', () => {
		expect(isFleetTimeZone('Europe/Paris')).toBe(true);
		expect(isFleetTimeZone('UTC')).toBe(true);
		expect(isFleetTimeZone('Mars/Olympus')).toBe(false);
		expect(isFleetTimeZone('../etc/passwd')).toBe(false);
		expect(isFleetTimeZone(42)).toBe(false);
	});

	it('prints a fire on a zone clock', () => {
		expect(formatFleetScheduleInstant(at('2026-01-15T01:00:00Z'), 'Europe/Paris')).toBe('Thu 02:00');
		expect(formatFleetScheduleInstant(at('2026-01-15T01:00:00Z'), 'America/New_York')).toBe('Wed 20:00');
	});

	it('answers the first instant of a repeated minute', () => {
		expect(iso(fleetZonedInstant(2026, 10, 25, 2, 30, 'Europe/Paris'))).toBe('2026-10-25T00:30:00.000Z');
	});
});

describe('wire shapes', () => {
	const id = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

	it('parses a definition and drops an unreadable one into `unreadable`', () => {
		const parsed = parseFleetScheduleSyncParams({
			generation: 3,
			definitions: [
				{ id, name: 'Nightly tests', command: 'pnpm test', cadence: weekdays('02:00'), timeoutSec: 99_999 },
				{ id: '00000000-0000-4000-8000-000000000000', name: 'bad', command: '', cadence: daily('01:00') }
			]
		});
		expect(parsed?.params.generation).toBe(3);
		expect(parsed?.params.definitions).toHaveLength(1);
		expect(parsed?.params.definitions[0].timeoutSec).toBe(21_600);
		expect(parsed?.unreadable).toEqual(['00000000-0000-4000-8000-000000000000']);
		expect(parseFleetScheduleDefinition({ id, name: 'x', command: 'ls', cadence: { kind: 'x' } })).toBeNull();
	});

	it('bounds the sync answer and the run report', () => {
		const result = parseFleetScheduleSyncResult({
			generation: 3,
			held: [id, 'nope'],
			refused: [{ id, error: { code: 'invalid', hint: 'outside home' } }],
			next: { [id]: '2026-01-15T01:00:00.000Z' },
			timeZone: 'Europe/Paris'
		});
		expect(result?.held).toEqual([id]);
		expect(result?.refused[0].error.code).toBe('invalid');
		expect(result?.next[id]).toBe('2026-01-15T01:00:00.000Z');
		expect(
			parseFleetScheduleRunReport({
				runId: id,
				scheduleId: id,
				startedAt: '2026-01-15T01:00:00.000Z',
				status: 'done'
			})
		).toBeNull();
		expect(
			parseFleetScheduleRunReport({
				runId: id,
				scheduleId: id,
				startedAt: '2026-01-15T01:00:00.000Z',
				endedAt: '2026-01-15T01:14:02.000Z',
				status: 'done',
				exitCode: 0,
				trigger: 'nonsense'
			})?.trigger
		).toBe('timer');
	});
});

describe('fleetScheduleFailureStreak (FR-23)', () => {
	it('counts failures at the head, passing over overlap skips', () => {
		expect(
			fleetScheduleFailureStreak([
				{ status: 'failed' },
				{ status: 'timeout' },
				{ status: 'skipped-overlap' },
				{ status: 'failed' },
				{ status: 'done' },
				{ status: 'failed' }
			])
		).toBe(3);
		expect(fleetScheduleFailureStreak([{ status: 'done' }, { status: 'failed' }])).toBe(0);
		expect(fleetScheduleFailureStreak([{ status: 'skipped-offline' }, { status: 'failed' }])).toBe(0);
	});
});

describe('Agent-session schedules (FL-13 P2)', () => {
	it('stores every cadence form as the cron a recurring Task carries', () => {
		expect(fleetScheduleCadenceToCron(every(30))).toBe('*/30 * * * *');
		expect(fleetScheduleCadenceToCron(every(60))).toBe('0 * * * *');
		expect(fleetScheduleCadenceToCron(every(1))).toBe('* * * * *');
		expect(fleetScheduleCadenceToCron(daily('08:30'))).toBe('30 8 * * *');
		expect(fleetScheduleCadenceToCron(weekdays('02:00'))).toBe('0 2 * * 1-5');
		expect(fleetScheduleCadenceToCron(cron('0 9 * * 1,3'))).toBe('0 9 * * 1,3');
		expect(fleetScheduleCadenceToCron(cron('nope'))).toBeNull();
	});

	it('carries the unattended-credential sentence verbatim (FR-26)', () => {
		expect(fleetScheduleUnattendedCredentialSentence('build-01')).toBe(
			'Runs happen on build-01 using the Claude Code or Codex sign-in — or the API key — that is set up on that computer. Ever Works keeps no copy of it. If that sign-in expires, the next run fails and this schedule appears under Needs a look until someone signs in on build-01 again.'
		);
	});
});
