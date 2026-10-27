import { describe, expect, it } from 'vitest';

import {
	FLEET_LOGS_FOLLOW_BYTES_PER_SEC,
	FLEET_LOGS_INITIAL_LINES,
	FLEET_LOGS_MAX_CHANNELS_PER_VIEWER,
	FLEET_LOGS_MAX_FILES_PER_ROOT,
	FLEET_LOGS_MAX_LINE_CHARS,
	FLEET_LOGS_MAX_MERGED_SOURCES,
	FLEET_LOGS_VIEWER_MAX_LINES,
	capFleetLogText,
	clampFleetLogsLines,
	classifyLogLevel,
	encodeFleetLogLines,
	fleetLogLevelFromSyslogPriority,
	fleetLogLevelFromWindowsEventLevel,
	fleetLogLineMatches,
	fleetLogSourceId,
	fleetLogSystemSourcesFor,
	leadingFleetLogTimestamp,
	parseFleetLogLines,
	parseFleetLogSourceId,
	parseFleetLogsChannelMessage,
	parseFleetLogsOpenParams,
	sanitizeFleetLogLine
} from '../fleet-logs.types.js';

/** Logs on computers (FL-08) — the shared vocabulary (spec FR-1 … FR-23, CONTRACTS §3.3, §10). */

describe('limits (CONTRACTS §10)', () => {
	it('pins the log rows', () => {
		expect(FLEET_LOGS_INITIAL_LINES).toBe(500);
		expect(FLEET_LOGS_FOLLOW_BYTES_PER_SEC).toBe(1024 * 1024);
		expect(FLEET_LOGS_VIEWER_MAX_LINES).toBe(5000);
		expect(FLEET_LOGS_MAX_FILES_PER_ROOT).toBe(200);
		expect(FLEET_LOGS_MAX_MERGED_SOURCES).toBe(12);
		expect(FLEET_LOGS_MAX_CHANNELS_PER_VIEWER).toBe(8);
	});
});

describe('source ids', () => {
	it('round-trips every kind', () => {
		expect(parseFleetLogSourceId(fleetLogSourceId('system', 'journal'))).toEqual({
			kind: 'system',
			key: 'journal'
		});
		expect(parseFleetLogSourceId('file:/var/log/syslog')).toEqual({ kind: 'file', key: '/var/log/syslog' });
		expect(parseFleetLogSourceId('file:C:\\ProgramData\\app\\app.log')).toEqual({
			kind: 'file',
			key: 'C:\\ProgramData\\app\\app.log'
		});
		expect(parseFleetLogSourceId('container:acme-api')).toEqual({ kind: 'container', key: 'acme-api' });
		expect(parseFleetLogSourceId('service:nginx.service')).toEqual({ kind: 'service', key: 'nginx.service' });
		expect(parseFleetLogSourceId('service:Windows Update')).toEqual({ kind: 'service', key: 'Windows Update' });
	});

	it('refuses what a machine must never be asked to open', () => {
		expect(parseFleetLogSourceId('system:shadow')).toBeNull();
		expect(parseFleetLogSourceId('file:relative/path.log')).toBeNull();
		expect(parseFleetLogSourceId('file:/var/log/\0x')).toBeNull();
		expect(parseFleetLogSourceId('container:-v')).toBeNull();
		expect(parseFleetLogSourceId('container:a;rm -rf /')).toBeNull();
		expect(parseFleetLogSourceId("service:x' -or 1")).toBeNull();
		expect(parseFleetLogSourceId('service:--user')).toBeNull();
		expect(parseFleetLogSourceId('disk:/dev/sda')).toBeNull();
		expect(parseFleetLogSourceId(`file:/${'a'.repeat(500)}`)).toBeNull();
		expect(parseFleetLogSourceId(42)).toBeNull();
	});

	it('offers the system logs each platform has', () => {
		expect(fleetLogSystemSourcesFor('linux')).toEqual(['journal', 'kernel']);
		expect(fleetLogSystemSourcesFor('darwin')).toEqual(['unified']);
		expect(fleetLogSystemSourcesFor('win32')).toEqual(['event-system', 'event-application', 'event-security']);
		expect(fleetLogSystemSourcesFor('aix')).toEqual([]);
	});
});

describe('open params', () => {
	it('reads one source, clamping the lines', () => {
		expect(parseFleetLogsOpenParams({ source: 'system:journal', lines: 9999 })).toEqual({
			sources: ['system:journal'],
			lines: 500,
			follow: false
		});
		expect(parseFleetLogsOpenParams({ source: 'system:journal', lines: 0, follow: true })).toEqual({
			sources: ['system:journal'],
			lines: 1,
			follow: true
		});
	});

	it('reads the CONTRACTS §3.3 aliases', () => {
		expect(parseFleetLogsOpenParams({ path: '/var/log/syslog' })?.sources).toEqual(['file:/var/log/syslog']);
		expect(parseFleetLogsOpenParams({ unit: 'nginx.service' })?.sources).toEqual(['service:nginx.service']);
		expect(parseFleetLogsOpenParams({ container: 'acme-api' })?.sources).toEqual(['container:acme-api']);
	});

	it('refuses a merged view with any malformed member or too many members', () => {
		expect(parseFleetLogsOpenParams({ source: 'container:a', sources: ['container:b', 'bad'] })).toBeNull();
		const many = Array.from({ length: 13 }, (_, i) => `container:c${i}`);
		expect(parseFleetLogsOpenParams({ source: many[0], sources: many })).toBeNull();
		expect(parseFleetLogsOpenParams({})).toBeNull();
	});

	it('deduplicates the merged members, source first', () => {
		expect(
			parseFleetLogsOpenParams({ source: 'container:a', sources: ['container:a', 'container:b'] })?.sources
		).toEqual(['container:a', 'container:b']);
	});

	it('clamps a line count whatever its shape', () => {
		expect(clampFleetLogsLines(undefined)).toBe(500);
		expect(clampFleetLogsLines('200')).toBe(200);
		expect(clampFleetLogsLines(-4)).toBe(1);
		expect(clampFleetLogsLines(Number.NaN)).toBe(500);
	});
});

describe('classifyLogLevel (FR-18)', () => {
	it('takes the source level first', () => {
		expect(classifyLogLevel('Fault', 'all good')).toBe('error');
		expect(classifyLogLevel('warn', 'error everywhere')).toBe('warning');
		expect(classifyLogLevel('Default', 'error everywhere')).toBe('info');
	});

	it('maps journal priorities 0–7', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(fleetLogLevelFromSyslogPriority)).toEqual([
			'error',
			'error',
			'error',
			'error',
			'warning',
			'info',
			'info',
			'info'
		]);
		expect(fleetLogLevelFromSyslogPriority('3')).toBe('error');
		expect(fleetLogLevelFromSyslogPriority(8)).toBeNull();
	});

	it('maps Windows event levels 0–5', () => {
		expect([0, 1, 2, 3, 4, 5].map(fleetLogLevelFromWindowsEventLevel)).toEqual([
			'info',
			'error',
			'error',
			'warning',
			'info',
			'info'
		]);
	});

	it('reads the text when the source has no level', () => {
		expect(classifyLogLevel(null, '09:41:07 nginx [error] upstream timed out')).toBe('error');
		expect(classifyLogLevel(null, 'level=warning msg="failed to pull"')).toBe('warning');
		expect(classifyLogLevel(null, '{"level":"error","msg":"boom"}')).toBe('error');
		expect(classifyLogLevel(null, '2026-10-21 WARN disk almost full')).toBe('warning');
		expect(classifyLogLevel(null, 'Traceback (most recent call last):')).toBe('error');
		expect(classifyLogLevel(null, 'this API is deprecated')).toBe('warning');
		expect(classifyLogLevel(null, 'Accepted publickey for ops')).toBe('info');
		expect(classifyLogLevel(null, '')).toBe('info');
	});

	it('never calls a count of zero an error', () => {
		expect(classifyLogLevel(null, 'build finished, errors: 0')).toBe('info');
		expect(classifyLogLevel(null, 'tests passed with 0 errors and 0 warnings')).toBe('info');
		expect(classifyLogLevel(null, 'summary: passed=12 failed=0')).toBe('info');
		expect(classifyLogLevel(null, 'no errors found')).toBe('info');
		expect(classifyLogLevel(null, 'errors: 3')).toBe('error');
	});
});

describe('lines on the wire', () => {
	it('round-trips NDJSON and skips torn records', () => {
		const lines = [
			{ ts: '2026-10-21T09:41:02.000Z', level: 'info' as const, text: 'a', src: 0, redactions: 0 },
			{ ts: null, level: 'error' as const, text: 'b', src: 1, redactions: 2 }
		];
		const payload = `${encodeFleetLogLines(lines)}{"ts":`;
		expect(parseFleetLogLines(payload)).toEqual(lines);
	});

	it('sanitises a foreign record', () => {
		expect(sanitizeFleetLogLine({ text: 'x', level: 'loud', src: 99, redactions: -1, ts: 'never' })).toEqual({
			ts: null,
			level: 'info',
			text: 'x',
			src: 0,
			redactions: 0
		});
		expect(sanitizeFleetLogLine({ level: 'info' })).toBeNull();
	});

	it('cuts a long line and marks the cut', () => {
		const cut = capFleetLogText('x'.repeat(FLEET_LOGS_MAX_LINE_CHARS + 10));
		expect(cut).toHaveLength(FLEET_LOGS_MAX_LINE_CHARS);
		expect(cut.endsWith('…')).toBe(true);
	});

	it('reads a leading timestamp', () => {
		expect(leadingFleetLogTimestamp('2026-10-21T09:41:02Z boot')).toBe('2026-10-21T09:41:02.000Z');
		expect(leadingFleetLogTimestamp('2026-10-21 09:41:02,123 INFO x')).toBe('2026-10-21T09:41:02.123Z');
		expect(leadingFleetLogTimestamp('[2026-10-21T09:41:02.123456789+02:00] x')).toBe('2026-10-21T07:41:02.123Z');
		expect(leadingFleetLogTimestamp('Oct 21 09:41:02 host sshd')).toBeNull();
	});

	it('filters case-insensitively (FR-17)', () => {
		expect(fleetLogLineMatches({ text: 'GET /health NGINX' }, 'nginx')).toBe(true);
		expect(fleetLogLineMatches({ text: 'postgres' }, 'nginx')).toBe(false);
		expect(fleetLogLineMatches({ text: 'anything' }, '')).toBe(true);
	});
});

describe('channel messages', () => {
	it('reads an initial-done with its error', () => {
		expect(
			parseFleetLogsChannelMessage({
				type: 'logs.initial-done',
				count: 3,
				redactions: 1,
				bytes: 120,
				following: true,
				error: { code: 'operation_failed', hint: 'journalctl exited 1' }
			})
		).toEqual({
			type: 'logs.initial-done',
			count: 3,
			redactions: 1,
			bytes: 120,
			scanLimited: false,
			following: true,
			error: { code: 'operation_failed', hint: 'journalctl exited 1' }
		});
	});

	it('reads notices of known kinds only', () => {
		expect(parseFleetLogsChannelMessage({ type: 'logs.notice', kind: 'dropped', count: 1240 })).toEqual({
			type: 'logs.notice',
			kind: 'dropped',
			count: 1240
		});
		expect(parseFleetLogsChannelMessage({ type: 'logs.notice', kind: 'explode' })).toBeNull();
		expect(parseFleetLogsChannelMessage({ type: 'session.notice' })).toBeNull();
	});
});
