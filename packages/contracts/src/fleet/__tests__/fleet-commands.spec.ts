import { describe, expect, it } from 'vitest';

import {
	clampFleetCommandTimeout,
	FleetCommandEdgeBuffer,
	fleetCommandCliExitCode,
	fleetCommandRunEndFor,
	fleetCommandStateFor,
	fleetCommandUtf8Length,
	FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
	FLEET_COMMAND_FAILED_REASONS,
	FLEET_COMMAND_MAX_OUTPUT_BYTES,
	FLEET_COMMAND_MAX_TIMEOUT_SEC,
	FLEET_COMMAND_RECENT,
	FLEET_COMMAND_RUN_STATUSES,
	FLEET_COMMAND_STATES,
	FLEET_COMMAND_STORED_EDGE_BYTES,
	isFleetCommandFailedReason,
	isFleetCommandLine,
	isFleetCommandRunStatus,
	isFleetCommandState,
	parseFleetCommandChannelParams,
	parseFleetCommandNodeMessage,
	parseFleetCommandRunParams,
	summarizeFleetCommandRuns
} from '../fleet-commands.types.js';

const RUN = '33333333-3333-4333-8333-333333333333';
const COMMAND = '44444444-4444-4444-8444-444444444444';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('FL-12 constants (CONTRACTS §10)', () => {
	it('match the contract', () => {
		expect(FLEET_COMMAND_DEFAULT_TIMEOUT_SEC).toBe(600);
		expect(FLEET_COMMAND_MAX_TIMEOUT_SEC).toBe(3600);
		expect(FLEET_COMMAND_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
		expect(FLEET_COMMAND_STORED_EDGE_BYTES).toBe(64 * 1024);
		expect(FLEET_COMMAND_RECENT).toBe(8);
	});

	it('every union has its list and guard', () => {
		for (const state of FLEET_COMMAND_STATES) expect(isFleetCommandState(state)).toBe(true);
		for (const status of FLEET_COMMAND_RUN_STATUSES) expect(isFleetCommandRunStatus(status)).toBe(true);
		for (const reason of FLEET_COMMAND_FAILED_REASONS) expect(isFleetCommandFailedReason(reason)).toBe(true);
		expect(isFleetCommandState('nope')).toBe(false);
		expect(isFleetCommandFailedReason('timeout')).toBe(false);
	});
});

describe('bounds', () => {
	it('clamps the timeout and defaults junk', () => {
		expect(clampFleetCommandTimeout(0)).toBe(1);
		expect(clampFleetCommandTimeout(99_999)).toBe(3600);
		expect(clampFleetCommandTimeout('10')).toBe(600);
	});

	it('measures UTF-8 and refuses NUL', () => {
		expect(fleetCommandUtf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
		expect(isFleetCommandLine('uptime')).toBe(true);
		expect(isFleetCommandLine('a\0b')).toBe(false);
		expect(isFleetCommandLine('   ')).toBe(false);
	});
});

describe('FleetCommandEdgeBuffer', () => {
	it('keeps everything while it fits in head + tail', () => {
		const buffer = new FleetCommandEdgeBuffer(4);
		buffer.push(bytes('abc'));
		buffer.push(bytes('defgh'));
		expect(buffer.snapshot()).toEqual({ head: 'abcdefgh', tail: '', truncated: false, bytes: 8 });
	});

	it('keeps exactly the first and last edge bytes once larger', () => {
		const buffer = new FleetCommandEdgeBuffer(4);
		for (const chunk of ['ab', 'cdef', 'g', 'hijk', 'lm']) buffer.push(bytes(chunk));
		expect(buffer.snapshot()).toEqual({ head: 'abcd', tail: 'jklm', truncated: true, bytes: 13 });
	});

	it('handles a chunk larger than the edge', () => {
		const buffer = new FleetCommandEdgeBuffer(4);
		buffer.push(bytes('0123456789'));
		expect(buffer.snapshot()).toEqual({ head: '0123', tail: '6789', truncated: true, bytes: 10 });
	});

	it('wraps the ring many times', () => {
		const buffer = new FleetCommandEdgeBuffer(3);
		const text = 'the quick brown fox jumps over the lazy dog';
		for (const char of text) buffer.push(bytes(char));
		const snapshot = buffer.snapshot();
		expect(snapshot.head).toBe('the');
		expect(snapshot.tail).toBe('dog');
		expect(snapshot.bytes).toBe(text.length);
	});
});

describe('run ends', () => {
	it('maps the node end to status and reason', () => {
		expect(fleetCommandRunEndFor(0, undefined)).toEqual({ status: 'done', failedReason: null });
		expect(fleetCommandRunEndFor(2, undefined)).toEqual({ status: 'failed', failedReason: null });
		expect(fleetCommandRunEndFor(124, 'timeout')).toEqual({ status: 'timeout', failedReason: null });
		expect(fleetCommandRunEndFor(137, 'kill-switch')).toEqual({ status: 'failed', failedReason: 'kill-switch' });
	});

	it('summarises, settles and answers the CLI exit code (FR-19)', () => {
		const runs = [
			{ status: 'done' as const, durationMs: 800 },
			{ status: 'failed' as const, durationMs: 1200 }
		];
		expect(summarizeFleetCommandRuns(runs)).toMatchObject({ total: 2, succeeded: 1, failed: 1, longestMs: 1200 });
		expect(fleetCommandStateFor(runs)).toBe('failed');
		expect(fleetCommandStateFor([{ status: 'running' }, { status: 'done' }])).toBe('running');
		expect(fleetCommandCliExitCode([{ status: 'done' }])).toBe(0);
		expect(fleetCommandCliExitCode([{ status: 'done' }, { status: 'failed' }])).toBe(1);
		expect(fleetCommandCliExitCode([{ status: 'failed' }, { status: 'timeout' }])).toBe(124);
	});
});

describe('link messages', () => {
	it('parses the channel and run params', () => {
		expect(parseFleetCommandChannelParams({ commandId: COMMAND, nodeId: 'n1', runId: RUN })).toEqual({
			commandId: COMMAND,
			nodeId: 'n1',
			runId: RUN
		});
		expect(parseFleetCommandChannelParams({ commandId: 'x', nodeId: 'n1', runId: RUN })).toBeNull();
		expect(parseFleetCommandRunParams({ runId: RUN, command: 'ls', timeoutSec: 600, cwd: '~/code' })).toEqual({
			runId: RUN,
			command: 'ls',
			timeoutSec: 600,
			cwd: '~/code'
		});
		expect(parseFleetCommandRunParams({ runId: RUN, command: 'ls', timeoutSec: 3601 })).toBeNull();
	});

	it('parses node messages and drops anything else', () => {
		expect(parseFleetCommandNodeMessage({ type: 'command.truncated', runId: RUN, bytes: 10 })).toEqual({
			type: 'command.truncated',
			runId: RUN,
			bytes: 10
		});
		expect(
			parseFleetCommandNodeMessage({
				type: 'command.output',
				runId: RUN,
				head: 'hi',
				tail: '',
				truncated: false,
				capped: false,
				bytes: 2,
				exitCode: 0,
				reason: 'drain',
				detail: 'first\nsecond',
				kept: true
			})
		).toMatchObject({ reason: 'drain', detail: 'first', kept: true, exitCode: 0 });
		expect(parseFleetCommandNodeMessage({ type: 'command.run', runId: RUN })).toBeNull();
		expect(parseFleetCommandNodeMessage({ type: 'command.output', runId: 'nope' })).toBeNull();
	});
});
