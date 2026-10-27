import { describe, expect, it } from 'vitest';
import {
	diagnoseFleetActionsJob,
	fleetActionsJobItemId,
	fleetActionsRunnerCovers,
	isFleetActionsJobProblem,
	isFleetActionsJobUnassignable,
	normalizeFleetActionsWatchedTargets,
	FLEET_ACTIONS_MAX_WATCHED_TARGETS,
	type FleetActionsDiagnosisRunner
} from '../fleet-actions-runners.types.js';

/** Actions runners on computers (FL-18 P2, T-22, spec FR-22) — the diagnosis truth table and the watched list. */

const runner = (overrides: Partial<FleetActionsDiagnosisRunner> = {}): FleetActionsDiagnosisRunner => ({
	name: 'build-01-1',
	scope: 'repo',
	target: 'acme/api',
	labels: ['self-hosted', 'Linux', 'X64', 'gpu'],
	state: 'idle',
	...overrides
});

const job = (labels: string[] = ['self-hosted', 'linux'], repository = 'acme/api') => ({
	repository,
	labels,
	status: 'queued' as const
});

describe('diagnoseFleetActionsJob (FR-22)', () => {
	it('assignable: a matching runner is idle', () => {
		expect(diagnoseFleetActionsJob(job(), [runner()])).toEqual({ diagnosis: null, detail: null });
	});

	it('wrong-scope: no runner is registered to the repository or its organisation', () => {
		expect(diagnoseFleetActionsJob(job(['self-hosted'], 'acme/web'), [runner()])).toEqual({
			diagnosis: 'wrong-scope',
			detail: 'acme/web'
		});
		// An organisation runner covers every repository of the organisation.
		expect(
			diagnoseFleetActionsJob(job(['self-hosted'], 'acme/web'), [runner({ scope: 'org', target: 'acme' })])
				.diagnosis
		).toBeNull();
	});

	it('missing-label: names the first label no runner has (case-insensitive match)', () => {
		expect(diagnoseFleetActionsJob(job(['self-hosted', 'windows']), [runner()])).toEqual({
			diagnosis: 'missing-label',
			detail: 'windows'
		});
		expect(diagnoseFleetActionsJob(job(['SELF-HOSTED', 'GPU']), [runner()]).diagnosis).toBeNull();
	});

	it('offline-matching-runner: every matching runner is offline or stopped', () => {
		expect(diagnoseFleetActionsJob(job(), [runner({ state: 'offline' })])).toEqual({
			diagnosis: 'offline-matching-runner',
			detail: 'build-01-1'
		});
		expect(diagnoseFleetActionsJob(job(), [runner({ state: 'stopped' })]).diagnosis).toBe(
			'offline-matching-runner'
		);
	});

	it('all-busy: every online matching runner is working (not a problem)', () => {
		const result = diagnoseFleetActionsJob(job(), [runner({ state: 'working' })]);
		expect(result).toEqual({ diagnosis: 'all-busy', detail: 'build-01-1' });
		expect(isFleetActionsJobProblem(result.diagnosis)).toBe(false);
	});

	it('a job in progress has no diagnosis; removed runners do not count', () => {
		expect(diagnoseFleetActionsJob({ ...job(), status: 'in_progress' }, [])).toEqual({
			diagnosis: null,
			detail: null
		});
		expect(diagnoseFleetActionsJob(job(), [runner({ state: 'removed' })]).diagnosis).toBe('wrong-scope');
	});

	it('covers: repository exact, organisation by owner, case-insensitive', () => {
		expect(fleetActionsRunnerCovers({ scope: 'repo', target: 'Acme/API' }, 'acme/api')).toBe(true);
		expect(fleetActionsRunnerCovers({ scope: 'org', target: 'ACME' }, 'acme/web')).toBe(true);
		expect(fleetActionsRunnerCovers({ scope: 'org', target: 'acme' }, 'acmeco/web')).toBe(false);
	});
});

describe('job-unassignable (FR-24)', () => {
	const now = new Date('2026-10-26T10:00:00Z');
	it('after five minutes queued with a problem diagnosis only', () => {
		expect(
			isFleetActionsJobUnassignable({
				status: 'queued',
				diagnosis: 'missing-label',
				queuedAt: '2026-10-26T09:55:00Z',
				now
			})
		).toBe(true);
		expect(
			isFleetActionsJobUnassignable({
				status: 'queued',
				diagnosis: 'missing-label',
				queuedAt: '2026-10-26T09:56:00Z',
				now
			})
		).toBe(false);
		expect(
			isFleetActionsJobUnassignable({
				status: 'queued',
				diagnosis: 'all-busy',
				queuedAt: '2026-10-26T09:00:00Z',
				now
			})
		).toBe(false);
		expect(
			isFleetActionsJobUnassignable({
				status: 'in_progress',
				diagnosis: 'wrong-scope',
				queuedAt: '2026-10-26T09:00:00Z',
				now
			})
		).toBe(false);
	});

	it('one item id per job', () => {
		expect(fleetActionsJobItemId('Acme/API', 42)).toBe('fleet-actions-job:acme/api:42:unassignable');
	});
});

describe('normalizeFleetActionsWatchedTargets (FR-21)', () => {
	it('keeps valid targets, de-duplicated case-insensitively', () => {
		expect(
			normalizeFleetActionsWatchedTargets([
				{ scope: 'repo', target: ' acme/api ' },
				{ scope: 'repo', target: 'ACME/api' },
				{ scope: 'org', target: 'acme' }
			])
		).toEqual([
			{ scope: 'repo', target: 'acme/api' },
			{ scope: 'org', target: 'acme' }
		]);
	});

	it('refuses anything that is not a target, and more than the cap', () => {
		expect(normalizeFleetActionsWatchedTargets([{ scope: 'repo', target: 'not-a-repo' }])).toBeNull();
		expect(normalizeFleetActionsWatchedTargets('acme/api')).toBeNull();
		const many = Array.from({ length: FLEET_ACTIONS_MAX_WATCHED_TARGETS + 1 }, (_, i) => ({
			scope: 'repo',
			target: `acme/r${i}`
		}));
		expect(normalizeFleetActionsWatchedTargets(many)).toBeNull();
	});
});
