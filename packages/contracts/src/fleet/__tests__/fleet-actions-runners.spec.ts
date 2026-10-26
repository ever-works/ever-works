import { describe, expect, it } from 'vitest';
import {
	clampFleetActionsRunnerCount,
	FLEET_ACTIONS_RUNNER_ACTION_CLASS,
	FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
	fleetActionsRunnerDefaultLabels,
	fleetActionsRunnerDefaultNames,
	fleetActionsRunnerInstallSummary,
	fleetActionsRunnerModesFor,
	fleetActionsRunnerVersionOf,
	isFleetActionsRunnerDownloadUrl,
	isFleetActionsRunnerName,
	isFleetActionsRunnerStopped,
	isFleetActionsRunnerTarget,
	mergeFleetActionsRunnerState,
	normalizeFleetActionsRunnerLabels,
	pickFleetActionsRunnerDownload,
	type FleetActionsRunnerNodeFact
} from '../fleet-actions-runners.types.js';
import { parseFleetLogSourceId } from '../fleet-logs.types.js';

/** Actions runners on computers (FL-18, T-02) — the shared pure rules. */
describe('install requests', () => {
	it('clamps the count into 1 … 16 (FR-3, FR-4)', () => {
		expect(FLEET_ACTIONS_RUNNERS_MAX_PER_NODE).toBe(16);
		expect(clampFleetActionsRunnerCount(0)).toBe(1);
		expect(clampFleetActionsRunnerCount(2)).toBe(2);
		expect(clampFleetActionsRunnerCount(17)).toBe(16);
		expect(clampFleetActionsRunnerCount('3')).toBe(3);
		expect(clampFleetActionsRunnerCount('lots')).toBe(1);
	});

	it('names runners <computer>-<n>, skipping the names the computer already has', () => {
		expect(fleetActionsRunnerDefaultNames('build-01', 2)).toEqual(['build-01-1', 'build-01-2']);
		expect(fleetActionsRunnerDefaultNames('build-01', 2, ['BUILD-01-1'])).toEqual(['build-01-2', 'build-01-3']);
		expect(fleetActionsRunnerDefaultNames('Design Mac', 1)).toEqual(['Design-Mac-1']);
		expect(fleetActionsRunnerDefaultNames('', 1)).toEqual(['runner-1']);
		// A long run of dashes is trimmed in linear time (no end-anchored regex).
		expect(fleetActionsRunnerDefaultNames('build--' + '-'.repeat(50_000), 1)).toEqual(['build-1']);
		expect(fleetActionsRunnerDefaultNames('-'.repeat(50_000) + 'x', 1)).toEqual(['runner-1']);
	});

	it('accepts only GitHub-shaped names, labels and targets', () => {
		expect(isFleetActionsRunnerName('build-01-1')).toBe(true);
		expect(isFleetActionsRunnerName('-x')).toBe(false);
		expect(isFleetActionsRunnerName('a b')).toBe(false);
		expect(isFleetActionsRunnerName('..')).toBe(false);
		expect(isFleetActionsRunnerTarget('repo', 'acme/api')).toBe(true);
		expect(isFleetActionsRunnerTarget('repo', 'acme')).toBe(false);
		expect(isFleetActionsRunnerTarget('repo', 'acme/api/x')).toBe(false);
		expect(isFleetActionsRunnerTarget('org', 'acme')).toBe(true);
		expect(isFleetActionsRunnerTarget('org', 'acme/api')).toBe(false);
		expect(isFleetActionsRunnerTarget('team', 'acme')).toBe(false);
	});

	it('cleans labels: splits commas, de-duplicates, drops the ones GitHub adds, names the first bad one', () => {
		const defaults = fleetActionsRunnerDefaultLabels('linux', 'x64');
		expect(defaults).toEqual(['self-hosted', 'Linux', 'X64']);
		expect(normalizeFleetActionsRunnerLabels(['gpu, cuda', 'GPU', 'linux'], defaults)).toEqual({
			labels: ['gpu', 'cuda'],
			invalid: null
		});
		expect(normalizeFleetActionsRunnerLabels(['gpu', 'two words'], defaults).invalid).toBe('two words');
	});

	it('offers Service wherever a service manager exists, and Docker only on Linux with Docker once shipped', () => {
		expect(fleetActionsRunnerModesFor({ os: 'win32', hasServiceManager: true, hasDocker: true, dockerShipped: true })).toEqual([
			'service'
		]);
		expect(fleetActionsRunnerModesFor({ os: 'linux', hasServiceManager: true, hasDocker: true })).toEqual(['service']);
		expect(fleetActionsRunnerModesFor({ os: 'linux', hasServiceManager: true, hasDocker: true, dockerShipped: true })).toEqual([
			'service',
			'docker'
		]);
		expect(fleetActionsRunnerModesFor({ os: 'linux', hasServiceManager: false, hasDocker: false })).toEqual([]);
	});

	it('says target, count, mode, computer and that no credits are spent (FR-30)', () => {
		expect(fleetActionsRunnerInstallSummary({ count: 2, target: 'acme/api', mode: 'service', computer: 'build-01' })).toBe(
			'Installs 2 Actions runners for acme/api on build-01 as services. They run CI jobs on that computer; no credits are spent.'
		);
		expect(FLEET_ACTIONS_RUNNER_ACTION_CLASS.remove).toBe('confirm-destructive');
		expect(FLEET_ACTIONS_RUNNER_ACTION_CLASS.start).toBe('plain');
	});
});

describe('downloads', () => {
	const downloads = [
		{ os: 'linux', architecture: 'x64', downloadUrl: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz', filename: 'actions-runner-linux-x64-2.321.0.tar.gz', sha256: 'a'.repeat(64) },
		{ os: 'win', architecture: 'x64', downloadUrl: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip', filename: 'actions-runner-win-x64-2.321.0.zip', sha256: 'b'.repeat(64) }
	];

	it('picks the build for the node and reads its version', () => {
		expect(pickFleetActionsRunnerDownload(downloads, 'win32', 'x64')?.sha256).toBe('b'.repeat(64));
		expect(pickFleetActionsRunnerDownload(downloads, 'darwin', 'arm64')).toBeNull();
		expect(fleetActionsRunnerVersionOf(downloads[0].filename)).toBe('2.321.0');
	});

	it('accepts only GitHub release assets of the runner', () => {
		expect(isFleetActionsRunnerDownloadUrl(downloads[0].downloadUrl)).toBe(true);
		expect(isFleetActionsRunnerDownloadUrl('http://github.com/actions/runner/releases/download/x.tar.gz')).toBe(false);
		expect(isFleetActionsRunnerDownloadUrl('https://evil.example/actions/runner/releases/download/x.tar.gz')).toBe(false);
		expect(isFleetActionsRunnerDownloadUrl('https://github.com/someone/runner/releases/download/x.tar.gz')).toBe(false);
		expect(isFleetActionsRunnerDownloadUrl('https://user:pw@github.com/actions/runner/releases/download/x')).toBe(false);
	});
});

describe('mergeFleetActionsRunnerState (FR-13, FR-17)', () => {
	const fact = (over: Partial<FleetActionsRunnerNodeFact> = {}): FleetActionsRunnerNodeFact => ({
		runnerId: 'r',
		name: 'build-01-1',
		scope: 'repo',
		target: 'acme/api',
		mode: 'service',
		serviceState: 'running',
		serviceUnit: null,
		runnerVersion: '2.321.0',
		githubRunnerId: 7,
		configured: true,
		...over
	});
	const base = { state: 'idle' as const, stoppedByOwner: false, nodeName: 'build-01' };

	it('lets GitHub win when it was read', () => {
		expect(mergeFleetActionsRunnerState({ ...base, github: { id: 7, name: 'x', status: 'online', busy: true } }).state).toBe('working');
		expect(mergeFleetActionsRunnerState({ ...base, github: { id: 7, name: 'x', status: 'online', busy: false }, node: fact({ serviceState: 'stopped' }) }).state).toBe('idle');
		expect(mergeFleetActionsRunnerState({ ...base, github: { id: 7, name: 'x', status: 'offline', busy: false } }).state).toBe('offline');
		expect(mergeFleetActionsRunnerState({ ...base, stoppedByOwner: true, github: { id: 7, name: 'x', status: 'offline', busy: false } }).state).toBe('stopped');
	});

	it('names a disagreement instead of hiding it', () => {
		const onlyNode = mergeFleetActionsRunnerState({ ...base, githubMissing: true, node: fact() });
		expect(onlyNode.state).toBe('unknown');
		expect(onlyNode.discrepancy).toBe('build-01 has it, GitHub does not list it');
		const onlyGithub = mergeFleetActionsRunnerState({ ...base, github: { id: 7, name: 'x', status: 'online', busy: false }, nodeMissing: true });
		expect(onlyGithub.state).toBe('unknown');
		expect(onlyGithub.discrepancy).toBe('GitHub lists it, build-01 does not');
	});

	it('falls back to the node service without GitHub, and leaves installs and failures alone', () => {
		expect(mergeFleetActionsRunnerState({ ...base, state: 'working', node: fact() }).state).toBe('working');
		expect(mergeFleetActionsRunnerState({ ...base, node: fact({ serviceState: 'stopped' }) }).state).toBe('offline');
		expect(mergeFleetActionsRunnerState({ ...base, state: 'installing', github: { id: 7, name: 'x', status: 'online', busy: false } }).state).toBe('installing');
		expect(mergeFleetActionsRunnerState({ ...base, state: 'failed', node: fact() }).state).toBe('failed');
		expect(mergeFleetActionsRunnerState({ ...base }).state).toBe('idle');
	});
});

describe('isFleetActionsRunnerStopped (FR-19, U12)', () => {
	const now = new Date('2026-10-21T10:00:00Z');
	it('raises after five minutes offline while the computer is online, never for an owner stop', () => {
		const input = { state: 'offline' as const, stoppedByOwner: false, nodeOnline: true, installedAt: null, now };
		expect(isFleetActionsRunnerStopped({ ...input, lastSeenAt: '2026-10-21T09:54:00Z' })).toBe(true);
		expect(isFleetActionsRunnerStopped({ ...input, lastSeenAt: '2026-10-21T09:57:00Z' })).toBe(false);
		expect(isFleetActionsRunnerStopped({ ...input, stoppedByOwner: true, lastSeenAt: '2026-10-21T09:00:00Z' })).toBe(false);
		expect(isFleetActionsRunnerStopped({ ...input, nodeOnline: false, lastSeenAt: '2026-10-21T09:00:00Z' })).toBe(false);
		expect(isFleetActionsRunnerStopped({ ...input, state: 'stopped', lastSeenAt: '2026-10-21T09:00:00Z' })).toBe(false);
	});
});

describe('the runner log source (FR-18)', () => {
	it('parses runner:<name> and refuses a path', () => {
		expect(parseFleetLogSourceId('runner:build-01-1')).toEqual({ kind: 'runner', key: 'build-01-1' });
		expect(parseFleetLogSourceId('runner:../etc')).toBeNull();
		expect(parseFleetLogSourceId('runner:a/b')).toBeNull();
	});
});
