import { describe, expect, it } from 'vitest';

import { FLEET_LINK_CONTROL_TYPES } from '../fleet-link.types.js';
import {
	boundFleetSessionScreen,
	clampFleetSessionSize,
	FLEET_SESSION_ATTACH_ROLES,
	FLEET_SESSION_ATTACHES_PER_MINUTE,
	FLEET_SESSION_DRAIN_WARNING_SEC,
	FLEET_SESSION_END_GRACE_MS,
	FLEET_SESSION_ENDED_REASONS,
	FLEET_SESSION_KINDS,
	FLEET_SESSION_LAST_SCREEN_MAX_CHARS,
	FLEET_SESSION_LINK_VERBS,
	FLEET_SESSION_LIVE_STATES,
	FLEET_SESSION_MAX_OWNER_PER_NODE,
	FLEET_SESSION_MAX_VIEWERS,
	FLEET_SESSION_OUTCOMES,
	FLEET_SESSION_PROVIDER_CAPABILITY,
	FLEET_SESSION_RECORDING_STATES,
	FLEET_SESSION_REPLAY_LINES,
	FLEET_SESSION_SCROLLBACK_LINES,
	FLEET_SESSION_STARTABLE_PROVIDERS,
	FLEET_SESSION_STARTS_PER_MINUTE,
	FLEET_SESSION_STATES,
	fleetSessionConsentFor,
	fleetSessionOutcomeForExit,
	fleetSessionViewerPath,
	isFleetDaemonSessionId,
	isFleetSessionAttachRole,
	isFleetSessionEndedReason,
	isFleetSessionKind,
	isFleetSessionLive,
	isFleetSessionOutcome,
	isFleetSessionProvider,
	isFleetSessionRecordingState,
	isFleetSessionStartableProvider,
	isFleetSessionState,
	normalizeFleetSessionDaemonReport,
	parseFleetSessionAck,
	parseFleetSessionChannelParams,
	parseFleetSessionEvent,
	parseFleetSessionList,
	parseFleetSessionNotice,
	parseFleetSessionStartParams
} from '../fleet-sessions.types.js';

/**
 * The FL-04 session vocabulary. Every union is pinned by literal against
 * CONTRACTS §4.2 / §5.1 (a member added in code must be added in the
 * contract first), every guard refuses a foreign string, every limit is the
 * CONTRACTS §10 / §10.1 number, and every node → platform parser answers
 * `null` — never throws — for anything it does not recognise.
 */

const FOREIGN = ['', 'ENDED', 'owner ', 'other', 'nope', '__proto__', 'constructor'];

describe('session unions and guards', () => {
	it('pins every union to CONTRACTS §4.2 and §5.1', () => {
		expect(FLEET_SESSION_KINDS).toEqual(['owner', 'agent']);
		expect(FLEET_SESSION_STARTABLE_PROVIDERS).toEqual(['shell', 'claude-code', 'codex']);
		expect(FLEET_SESSION_STATES).toEqual(['starting', 'working', 'needs_you', 'done', 'idle', 'ended']);
		expect(FLEET_SESSION_OUTCOMES).toEqual(['success', 'failure', 'cancelled', 'interrupted', 'unconfirmed']);
		expect(FLEET_SESSION_ENDED_REASONS).toEqual([
			'user',
			'agent',
			'exit',
			'node-restart',
			'timeout',
			'kill-switch',
			'drain'
		]);
		expect(FLEET_SESSION_RECORDING_STATES).toEqual(['off', 'recording', 'stored']);
		expect(FLEET_SESSION_ATTACH_ROLES).toEqual(['viewer', 'driver']);
	});

	it('accepts every member and refuses foreign strings and non-strings', () => {
		const cases: Array<[(value: unknown) => boolean, readonly string[]]> = [
			[isFleetSessionKind, FLEET_SESSION_KINDS],
			[isFleetSessionState, FLEET_SESSION_STATES],
			[isFleetSessionOutcome, FLEET_SESSION_OUTCOMES],
			[isFleetSessionEndedReason, FLEET_SESSION_ENDED_REASONS],
			[isFleetSessionRecordingState, FLEET_SESSION_RECORDING_STATES],
			[isFleetSessionAttachRole, FLEET_SESSION_ATTACH_ROLES],
			[isFleetSessionStartableProvider, FLEET_SESSION_STARTABLE_PROVIDERS]
		];
		for (const [guard, members] of cases) {
			for (const member of members) expect(guard(member)).toBe(true);
			for (const foreign of FOREIGN) expect(guard(foreign)).toBe(false);
			for (const other of [null, undefined, 1, {}, []]) expect(guard(other)).toBe(false);
		}
	});

	it('admits other:<id> providers but never starts one', () => {
		expect(isFleetSessionProvider('other:aider')).toBe(true);
		expect(isFleetSessionProvider('other:')).toBe(false);
		expect(isFleetSessionProvider('other:../x')).toBe(false);
		expect(isFleetSessionStartableProvider('other:aider')).toBe(false);
	});

	it('marks only the shell as needing no CLI tag', () => {
		expect(FLEET_SESSION_PROVIDER_CAPABILITY).toEqual({
			shell: null,
			'claude-code': 'claude-code',
			codex: 'codex'
		});
	});

	it('treats every state but ended as live', () => {
		expect(FLEET_SESSION_LIVE_STATES).toEqual(['starting', 'working', 'needs_you', 'done', 'idle']);
		expect(isFleetSessionLive('ended')).toBe(false);
		expect(isFleetSessionLive('idle')).toBe(true);
	});

	it('maps the kind to its consent (CONTRACTS R-5)', () => {
		expect(fleetSessionConsentFor('owner')).toBe('manage');
		expect(fleetSessionConsentFor('agent')).toBe('work');
	});

	it('derives the exit outcome from evidence only', () => {
		expect(fleetSessionOutcomeForExit(0)).toBe('success');
		expect(fleetSessionOutcomeForExit(1)).toBe('failure');
		expect(fleetSessionOutcomeForExit(-1)).toBe('failure');
		expect(fleetSessionOutcomeForExit(null)).toBe('unconfirmed');
		expect(fleetSessionOutcomeForExit(undefined)).toBe('unconfirmed');
		expect(fleetSessionOutcomeForExit(1.5)).toBe('unconfirmed');
	});
});

describe('limits (CONTRACTS §10, §10.1)', () => {
	it('equals the contract numbers', () => {
		expect(FLEET_SESSION_MAX_OWNER_PER_NODE).toBe(8);
		expect(FLEET_SESSION_MAX_VIEWERS).toBe(5);
		expect(FLEET_SESSION_SCROLLBACK_LINES).toBe(10_000);
		expect(FLEET_SESSION_REPLAY_LINES).toBe(2_000);
		expect(FLEET_SESSION_DRAIN_WARNING_SEC).toBe(60);
		expect(FLEET_SESSION_END_GRACE_MS).toBe(5_000);
		expect(FLEET_SESSION_STARTS_PER_MINUTE).toBe(10);
		expect(FLEET_SESSION_ATTACHES_PER_MINUTE).toBe(30);
	});

	it('clamps a terminal size and defaults what is missing', () => {
		expect(clampFleetSessionSize(undefined, undefined)).toEqual({ cols: 120, rows: 32 });
		expect(clampFleetSessionSize(1, 1)).toEqual({ cols: 20, rows: 5 });
		expect(clampFleetSessionSize(9999, 9999)).toEqual({ cols: 500, rows: 200 });
		expect(clampFleetSessionSize(80.4, 24.6)).toEqual({ cols: 80, rows: 25 });
		expect(clampFleetSessionSize('80', Number.NaN)).toEqual({ cols: 120, rows: 32 });
	});

	it('keeps the END of an oversized screen, from a line boundary', () => {
		const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${'x'.repeat(30)}`);
		const bounded = boundFleetSessionScreen(lines.join('\n'));
		expect(bounded.length).toBeLessThanOrEqual(FLEET_SESSION_LAST_SCREEN_MAX_CHARS);
		expect(bounded.endsWith(lines[lines.length - 1])).toBe(true);
		expect(bounded.startsWith('line ')).toBe(true);
		expect(boundFleetSessionScreen('short')).toBe('short');
	});
});

describe('ids and paths', () => {
	it('accepts only id-shaped daemon session ids', () => {
		expect(isFleetDaemonSessionId('9f2c0d1e-aaaa-4bbb-8ccc-123456789abc')).toBe(true);
		expect(isFleetDaemonSessionId('../etc/passwd')).toBe(false);
		expect(isFleetDaemonSessionId('a'.repeat(65))).toBe(false);
		expect(isFleetDaemonSessionId('')).toBe(false);
	});

	it('names the viewer socket path (CONTRACTS §3.4)', () => {
		expect(fleetSessionViewerPath('9f2c')).toBe('/ws/fleet/session/9f2c');
	});
});

describe('the session link family', () => {
	it('never collides with a link control type (extension messages route to their module)', () => {
		for (const type of ['session.event', 'session.list', 'session.ack', 'session.notice']) {
			expect((FLEET_LINK_CONTROL_TYPES as readonly string[]).includes(type)).toBe(false);
		}
		expect(FLEET_SESSION_LINK_VERBS).toContain('session.start');
		expect(FLEET_SESSION_LINK_VERBS).toContain('session.screen');
	});

	it('parses channel params and refuses a foreign kind or mode', () => {
		expect(parseFleetSessionChannelParams({ sessionId: 's1', mode: 'viewer' })).toEqual({
			sessionId: 's1',
			mode: 'viewer'
		});
		expect(parseFleetSessionChannelParams({ sessionId: 's1', mode: 'driver', kind: 'agent' })).toEqual({
			sessionId: 's1',
			mode: 'driver',
			kind: 'agent'
		});
		expect(parseFleetSessionChannelParams({ sessionId: 's1', mode: 'owner' })).toBeNull();
		expect(parseFleetSessionChannelParams({ sessionId: 's1', mode: 'viewer', kind: 'root' })).toBeNull();
		expect(parseFleetSessionChannelParams({ sessionId: '../x', mode: 'viewer' })).toBeNull();
		expect(parseFleetSessionChannelParams(null)).toBeNull();
	});

	it('parses start params, bounds the size and refuses anything shaped like a command line', () => {
		const ok = parseFleetSessionStartParams({
			kind: 'owner',
			provider: 'shell',
			cwd: '/home/dana',
			title: ' ~ ',
			cols: 9999,
			rows: 2,
			startedBy: 'user:u-1'
		});
		expect(ok).toEqual({
			kind: 'owner',
			provider: 'shell',
			cwd: '/home/dana',
			title: '~',
			cols: 500,
			rows: 5,
			startedBy: 'user:u-1'
		});
		const base = { kind: 'owner', provider: 'shell', cwd: '/x', title: 't', startedBy: 'user:u' };
		expect(parseFleetSessionStartParams({ ...base, provider: 'bash -c rm' })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, cwd: '' })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, cwd: '/x\0y' })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, title: '   ' })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, startedBy: 'root' })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, firstMessage: 'x'.repeat(4001) })).toBeNull();
		expect(parseFleetSessionStartParams({ ...base, firstMessage: '  ' })).not.toHaveProperty('firstMessage');
		expect(parseFleetSessionStartParams({ ...base, firstMessage: 'run the tests' })?.firstMessage).toBe(
			'run the tests'
		);
	});

	it('parses session.event and drops what it cannot trust', () => {
		expect(
			parseFleetSessionEvent({
				type: 'session.event',
				sessionId: 's1',
				event: 'exited',
				exitCode: 3,
				screen: 'bye',
				reason: 'user'
			})
		).toEqual({
			type: 'session.event',
			sessionId: 's1',
			event: 'exited',
			exitCode: 3,
			screen: 'bye',
			reason: 'user'
		});
		expect(parseFleetSessionEvent({ type: 'session.event', sessionId: 's1', event: 'exploded' })).toBeNull();
		expect(parseFleetSessionEvent({ type: 'session.event', sessionId: 's1', event: 'title' })).toBeNull();
		expect(
			parseFleetSessionEvent({
				type: 'session.event',
				sessionId: 's1',
				event: 'exited',
				exitCode: 'x',
				reason: 'boom'
			})
		).toEqual({ type: 'session.event', sessionId: 's1', event: 'exited' });
		expect(parseFleetSessionEvent({ type: 'session.list', sessionId: 's1', event: 'started' })).toBeNull();
		expect(parseFleetSessionEvent('session.event')).toBeNull();
	});

	it('parses session.list, keeping valid entries and the daemon report', () => {
		const list = parseFleetSessionList({
			type: 'session.list',
			daemon: { state: 'running', sessions: 2 },
			sessions: [
				{
					sessionId: 's1',
					kind: 'owner',
					provider: 'shell',
					cwd: '/x',
					title: 't',
					startedAt: '2026-10-18T09:41:00.000Z',
					alive: true,
					exitCode: null,
					cols: 80,
					rows: 24,
					viewers: 1,
					drivers: 1
				},
				{ sessionId: '../bad', kind: 'owner' }
			]
		});
		expect(list?.sessions).toHaveLength(1);
		expect(list?.daemon).toEqual({ state: 'running', sessions: 2 });
		expect(parseFleetSessionList({ type: 'session.list', sessions: [] })).toBeNull();
	});

	it('parses session.ack and notices', () => {
		expect(parseFleetSessionAck({ type: 'session.ack', sessionIds: ['s1', '../x', 's2'] })).toEqual({
			type: 'session.ack',
			sessionIds: ['s1', 's2']
		});
		expect(parseFleetSessionNotice({ type: 'session.notice', notice: 'drain', seconds: 60 })).toEqual({
			type: 'session.notice',
			notice: 'drain',
			seconds: 60
		});
		expect(parseFleetSessionNotice({ type: 'session.notice', notice: 'size', cols: 1, rows: 1 })).toEqual({
			type: 'session.notice',
			notice: 'size',
			cols: 20,
			rows: 5
		});
		expect(parseFleetSessionNotice({ type: 'session.notice', notice: 'explode' })).toBeNull();
	});
});

describe('the daemon report (heartbeat `daemon`)', () => {
	it('keeps a valid report and bounds its strings and counts', () => {
		expect(
			normalizeFleetSessionDaemonReport({
				state: 'failed',
				reason: `  could not bind the local socket${'!'.repeat(400)}`,
				sessions: -4,
				storage: 'failing',
				hooks: { spooled: 3.7, 'bad key': 1, nope: 'x' },
				extra: 'dropped'
			})
		).toEqual({
			state: 'failed',
			reason: `could not bind the local socket${'!'.repeat(400)}`.slice(0, 300),
			sessions: 0,
			storage: 'failing',
			hooks: { spooled: 3 }
		});
	});

	it('answers null for anything that is not a report', () => {
		expect(normalizeFleetSessionDaemonReport(null)).toBeNull();
		expect(normalizeFleetSessionDaemonReport({ state: 'exploded', sessions: 1 })).toBeNull();
		expect(normalizeFleetSessionDaemonReport([])).toBeNull();
	});
});

import {
	fleetAgentSessionRequiredCapabilities,
	FLEET_AGENT_SESSION_DEFAULT_PERMISSION_MODE,
	FLEET_AGENT_SESSION_LEASE_TTL_SEC,
	isFleetAgentSessionProvider,
	parseFleetAgentSessionPayload
} from '../fleet-sessions.types.js';

describe('agent-session payload (FL-04 P2)', () => {
	const UUID = '11111111-1111-4111-8111-111111111111';
	const valid = {
		fleetSessionId: UUID,
		agentId: UUID,
		agentRunId: UUID,
		nodeId: UUID,
		provider: 'claude-code',
		cwd: '/home/nina/code/app',
		title: 'fix the build',
		firstMessage: 'Fix the failing build',
		cols: 120,
		rows: 32,
		permissionMode: 'acceptEdits',
		leaseTtlSec: 300
	};

	it('reads a well-formed payload and defaults what is missing', () => {
		expect(parseFleetAgentSessionPayload(valid)).toEqual(valid);
		const bare = parseFleetAgentSessionPayload({ ...valid, permissionMode: 'bypassPermissions', leaseTtlSec: 'x' });
		expect(bare?.permissionMode).toBe(FLEET_AGENT_SESSION_DEFAULT_PERMISSION_MODE);
		expect(bare?.leaseTtlSec).toBe(FLEET_AGENT_SESSION_LEASE_TTL_SEC);
	});

	it('refuses a shell, a short or missing first message, a path-shaped id, a NUL folder', () => {
		expect(parseFleetAgentSessionPayload({ ...valid, provider: 'shell' })).toBeNull();
		expect(parseFleetAgentSessionPayload({ ...valid, firstMessage: 'hi' })).toBeNull();
		expect(parseFleetAgentSessionPayload({ ...valid, firstMessage: undefined })).toBeNull();
		expect(parseFleetAgentSessionPayload({ ...valid, fleetSessionId: '../x' })).toBeNull();
		expect(parseFleetAgentSessionPayload({ ...valid, cwd: '/tmp\0/x' })).toBeNull();
		expect(parseFleetAgentSessionPayload(null)).toBeNull();
	});

	it('requires the sessions tag and the CLI tag', () => {
		expect(isFleetAgentSessionProvider('codex')).toBe(true);
		expect(isFleetAgentSessionProvider('shell')).toBe(false);
		expect(fleetAgentSessionRequiredCapabilities('codex')).toEqual(['sessions', 'codex']);
	});
});
