import { describe, expect, it } from 'vitest';

import {
	buildFleetTaskFirstMessage,
	defaultFleetHandoffCheckoutMode,
	FLEET_HANDOFF_REASONS,
	FLEET_TASK_FIRST_MESSAGE_EXCERPT_MAX,
	fleetHandoffAgentCli,
	fleetHandoffReasonForRefusal,
	isFleetHandoffReason,
	judgeFleetHandoffComputer,
	parseFleetTaskSourceLink,
	type FleetHandoffComputerFacts
} from '../fleet-task-handoff.types.js';
import { FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH } from '../fleet-sessions.types.js';

const facts = (patch: Partial<FleetHandoffComputerFacts> = {}): FleetHandoffComputerFacts => ({
	nodeId: 'n-1',
	nodeName: 'build-01',
	refusal: null,
	pinnedNodeId: null,
	pinnedNodeName: null,
	agentName: 'Nina',
	liveAgentSessions: 0,
	slots: 2,
	...patch
});

describe('the closed set of reasons (FL-15 spec FR-2)', () => {
	it('names every reason the dialog can show', () => {
		expect([...FLEET_HANDOFF_REASONS]).toEqual([
			'offline',
			'needs-work',
			'missing-cli',
			'no-slot',
			'not-pinned',
			'kill-switch',
			'no-access'
		]);
		expect(isFleetHandoffReason('offline')).toBe(true);
		expect(isFleetHandoffReason('elsewhere')).toBe(false);
	});

	it('maps every FL-04 start refusal onto one reason', () => {
		expect(fleetHandoffReasonForRefusal('kill_switch')).toBe('kill-switch');
		expect(fleetHandoffReasonForRefusal('consent_missing')).toBe('needs-work');
		expect(fleetHandoffReasonForRefusal('unreachable')).toBe('offline');
		expect(fleetHandoffReasonForRefusal('busy')).toBe('offline');
		expect(fleetHandoffReasonForRefusal('unsupported_on_node')).toBe('missing-cli');
		expect(fleetHandoffReasonForRefusal('limit_exceeded')).toBe('no-slot');
		expect(fleetHandoffReasonForRefusal('permission_denied')).toBe('no-access');
		expect(fleetHandoffReasonForRefusal('internal')).toBeNull();
	});
});

describe('judgeFleetHandoffComputer (spec FR-2, FR-3, U1–U6)', () => {
	it('selects a computer nothing refuses', () => {
		expect(judgeFleetHandoffComputer(facts())).toEqual({ selectable: true, reason: null, hint: null });
	});

	it('puts the kill switch before everything, the pin included', () => {
		const verdict = judgeFleetHandoffComputer(
			facts({ refusal: { code: 'kill_switch', hint: 'clear it' }, pinnedNodeId: 'n-2', pinnedNodeName: 'build-02' })
		);
		expect(verdict.reason).toBe('kill-switch');
	});

	it('keeps only the pinned computer selectable and names where the pin changes', () => {
		const other = judgeFleetHandoffComputer(facts({ pinnedNodeId: 'n-2', pinnedNodeName: 'build-02' }));
		expect(other.selectable).toBe(false);
		expect(other.reason).toBe('not-pinned');
		expect(other.hint).toBe("Nina is pinned to build-02. Change that on Nina's Capabilities tab.");
		const pinned = judgeFleetHandoffComputer(facts({ pinnedNodeId: 'n-1', pinnedNodeName: 'build-01' }));
		expect(pinned.selectable).toBe(true);
	});

	it('carries the start rule hint for consent, CLI and reachability refusals', () => {
		const consent = judgeFleetHandoffComputer(
			facts({ refusal: { code: 'consent_missing', hint: 'needs --work on build-01' } })
		);
		expect(consent).toEqual({ selectable: false, reason: 'needs-work', hint: 'needs --work on build-01' });
		const cli = judgeFleetHandoffComputer(
			facts({ refusal: { code: 'unsupported_on_node', hint: 'Claude Code is not installed on build-01' } })
		);
		expect(cli.reason).toBe('missing-cli');
	});

	it('refuses a computer whose agent slots are full, and judges no limit when it is unknown', () => {
		const full = judgeFleetHandoffComputer(facts({ liveAgentSessions: 2, slots: 2 }));
		expect(full.reason).toBe('no-slot');
		expect(full.hint).toBe('build-01 is running 2 of 2 agent sessions');
		expect(judgeFleetHandoffComputer(facts({ liveAgentSessions: 9, slots: null })).selectable).toBe(true);
	});
});

describe('fleetHandoffAgentCli (lane-log decision 9)', () => {
	it('drives Codex for an OpenAI Agent and Claude Code otherwise', () => {
		expect(fleetHandoffAgentCli({ aiProviderId: 'openai' })).toBe('codex');
		expect(fleetHandoffAgentCli({ aiProviderId: 'OpenAI' })).toBe('codex');
		expect(fleetHandoffAgentCli({ aiProviderId: 'anthropic' })).toBe('claude-code');
		expect(fleetHandoffAgentCli({ aiProviderId: null })).toBe('claude-code');
		expect(fleetHandoffAgentCli({})).toBe('claude-code');
	});
});

describe('parseFleetTaskSourceLink (spec S3)', () => {
	it('reads the first issue or pull-request link', () => {
		expect(parseFleetTaskSourceLink('From https://github.com/acme/api/issues/910 — please fix')).toEqual({
			provider: 'github',
			kind: 'issue',
			url: 'https://github.com/acme/api/issues/910',
			repository: 'acme/api',
			number: 910
		});
		expect(parseFleetTaskSourceLink('see https://github.com/acme/api/pull/912#discussion')?.kind).toBe('pull');
	});

	it('answers null for anything else', () => {
		expect(parseFleetTaskSourceLink('https://github.com/acme/api')).toBeNull();
		expect(parseFleetTaskSourceLink('https://example.com/acme/api/issues/1')).toBeNull();
		expect(parseFleetTaskSourceLink(null)).toBeNull();
		expect(parseFleetTaskSourceLink('https://github.com/acme/api/issues/12abc')).toBeNull();
	});
});

describe('buildFleetTaskFirstMessage (spec FR-7)', () => {
	it('names the Task, the source, the branch, the excerpt and the hand-off line', () => {
		const message = buildFleetTaskFirstMessage({
			slug: 'T-42',
			title: 'Login form drops the session cookie',
			description: 'The cookie is lost after redirect.',
			checks: ['unit tests', 'lint'],
			source: parseFleetTaskSourceLink('https://github.com/acme/api/issues/910'),
			branch: 'task/login-form-1',
			hasRepository: true
		});
		expect(message.split('\n')[0]).toBe('Fix T-42 "Login form drops the session cookie".');
		expect(message).toContain('Source: https://github.com/acme/api/issues/910');
		expect(message).toContain('Branch: task/login-form-1');
		expect(message).toContain('The cookie is lost after redirect.');
		expect(message).toContain('Acceptance: unit tests; lint');
		expect(message.endsWith('When done, commit and open a pull request.')).toBe(true);
	});

	it('caps the description excerpt and the whole message', () => {
		const message = buildFleetTaskFirstMessage({
			slug: 'T-1',
			title: 'Long',
			description: 'x'.repeat(10_000),
			hasRepository: false
		});
		const body = message.split('\n').find((line) => line.startsWith('x')) ?? '';
		expect(body.length).toBeLessThanOrEqual(FLEET_TASK_FIRST_MESSAGE_EXCERPT_MAX);
		expect(message.length).toBeLessThanOrEqual(FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH);
		expect(message.endsWith('When done, summarise what you changed.')).toBe(true);
	});

	it('switches to the review wording for a pull-request Task (P3, S4)', () => {
		const message = buildFleetTaskFirstMessage({
			slug: 'T-61',
			title: 'Review',
			source: parseFleetTaskSourceLink('https://github.com/acme/api/pull/912'),
			hasRepository: true,
			review: true
		});
		expect(message.startsWith('Review and address the comments on #912 for T-61')).toBe(true);
	});
});

describe('defaultFleetHandoffCheckoutMode (spec FR-5, U7)', () => {
	it('prefers a new worktree, then a fresh clone, then an existing checkout, then none', () => {
		expect(defaultFleetHandoffCheckoutMode({ hasRepository: true, matching: 1, others: 0 })).toBe('worktree');
		expect(defaultFleetHandoffCheckoutMode({ hasRepository: true, matching: 0, others: 3 })).toBe('clone');
		expect(defaultFleetHandoffCheckoutMode({ hasRepository: false, matching: 0, others: 2 })).toBe('existing');
		expect(defaultFleetHandoffCheckoutMode({ hasRepository: false, matching: 0, others: 0 })).toBe('none');
	});
});
