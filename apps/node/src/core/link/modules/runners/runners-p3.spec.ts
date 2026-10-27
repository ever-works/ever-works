import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetActionsRunnerDownload, FleetJobView } from '@ever-works/contracts';
import { createRunnerControlExecutor } from '../../../executors/runner-control';
import { createRunnerInstallExecutor } from '../../../executors/runner-install';
import { createRunnersModule } from '../runners';
import { RUNNER_TOKEN_ENV } from './config';
import {
	DOCKER_SOCKET,
	isPinnedRunnerImage,
	runnerContainerName,
	runnerDockerConfigArgs,
	runnerDockerRunArgs,
	runnerImageTag
} from './docker';
import { RunnerHostError, type RunnerExecRequest, type RunnerHostDeps, type RunnerJobClient } from './host';
import { RunnerState } from './state';

/** Actions runners on computers (FL-18 P3, T-27, T-28) — Docker-isolated runners and Reinstall on the node. */

const TOKEN = 'ZZYYXXWWVVUUTTSSRRQQPPOONNMM';
const RUNNER_ID = '7d0f3a52-9b1e-4c6f-8a2d-3e4f5a6b7c8d';
const IMAGE = `ghcr.io/actions/actions-runner@sha256:${'b'.repeat(64)}`;

function download(version = '2.321.0', sha256 = 'a'.repeat(64)): FleetActionsRunnerDownload {
	return {
		os: 'linux',
		architecture: 'x64',
		downloadUrl: `https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz`,
		filename: `actions-runner-linux-x64-${version}.tar.gz`,
		sha256
	};
}

describe('Docker-isolated argv (FR-27)', () => {
	const base = {
		runnerId: RUNNER_ID,
		dir: '/home/ci/.config/ever-works-node/actions-runners/build-01-1',
		image: IMAGE,
		user: '1000:1000'
	};
	const config = {
		platform: 'linux',
		url: 'https://github.com/acme/api',
		name: 'build-01-1',
		labels: ['gpu'],
		replace: false
	};

	it('registers in a throw-away container: the token is `-e NAME` with no value, never on argv', () => {
		const args = runnerDockerConfigArgs({ ...base, config });
		expect(args.slice(0, 2)).toEqual(['run', '--rm']);
		expect(args).toContain(RUNNER_TOKEN_ENV);
		expect(args.join(' ')).not.toContain(`${RUNNER_TOKEN_ENV}=`);
		expect(args).toContain('--unattended');
		expect(args).toContain('--user');
		expect(args).toContain('1000:1000');
	});

	it('runs the runner restarted by Docker, without the Docker socket unless the owner opted in', () => {
		const plain = runnerDockerRunArgs({ ...base, shareDockerDaemon: false });
		expect(plain).toEqual(
			expect.arrayContaining(['-d', '--restart', 'unless-stopped', '--name', runnerContainerName(RUNNER_ID)])
		);
		expect(plain.join(' ')).not.toContain(DOCKER_SOCKET);
		expect(plain.join(' ')).not.toContain(RUNNER_TOKEN_ENV);
		const shared = runnerDockerRunArgs({ ...base, shareDockerDaemon: true });
		expect(shared.join(' ')).toContain(`source=${DOCKER_SOCKET},target=${DOCKER_SOCKET}`);
	});

	it('only ever runs GitHub’s runner image pinned to a digest', () => {
		expect(isPinnedRunnerImage(IMAGE)).toBe(true);
		expect(isPinnedRunnerImage('ghcr.io/actions/actions-runner:2.321.0')).toBe(false);
		expect(isPinnedRunnerImage(`docker.io/library/ubuntu@sha256:${'c'.repeat(64)}`)).toBe(false);
		expect(() =>
			runnerDockerRunArgs({ ...base, image: 'ghcr.io/actions/actions-runner:latest', shareDockerDaemon: false })
		).toThrow(RunnerHostError);
		expect(runnerImageTag('2.321.0')).toBe('ghcr.io/actions/actions-runner:2.321.0');
	});
});

describe('the container tag', () => {
	it('advertises actions-runner-docker only on Linux with Docker under --work', () => {
		const make = (hasDocker: boolean) =>
			createRunnersModule({
				state: new RunnerState('/nowhere'),
				exec: async () => ({ code: 0, stdout: '', stderr: '' }),
				client: () => ({}) as RunnerJobClient,
				platform: 'linux',
				arch: 'x64',
				user: 'ci',
				isRoot: () => false,
				isElevated: async () => false,
				hasSystemd: () => true,
				hasDocker: () => hasDocker,
				nodeName: 'build-01'
			});
		const env = (platform: string) => ({
			consents: { work: true, manage: false, observe: false, usageScan: false } as never,
			platform,
			nodeVersion: '1.0.0'
		});
		expect(make(true).tags?.(env('linux'))).toEqual(['actions-runner', 'actions-runner-docker']);
		expect(make(false).tags?.(env('linux'))).toEqual(['actions-runner']);
	});
});

describe('executors (P3)', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'ew-runners-p3-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function harness() {
		const reports: Array<Record<string, unknown>> = [];
		const execs: RunnerExecRequest[] = [];
		const kinds: string[] = [];
		const bodies = new Map<string, string>([
			['2.321.0', 'runner build 2.321.0'],
			['2.322.0', 'runner build 2.322.0']
		]);
		const deps: RunnerHostDeps = {
			state: new RunnerState(root),
			exec: async (request) => {
				execs.push(request);
				if (request.command === 'tar') {
					const into = request.args[request.args.indexOf('-C') + 1];
					await mkdir(into, { recursive: true });
					await writeFile(join(into, 'config.sh'), '#!/bin/sh\n');
				}
				if (request.command === 'docker' && request.args[0] === 'image')
					return { code: 0, stdout: `${IMAGE}\n`, stderr: '' };
				if (request.command.endsWith('config.sh') && request.args[0] === '--unattended') {
					await writeFile(join(request.cwd as string, '.runner'), JSON.stringify({ agentId: 42 }));
					await writeFile(
						join(request.cwd as string, '.service'),
						'actions.runner.acme-api.build-01-1.service'
					);
				}
				return { code: 0, stdout: '', stderr: '' };
			},
			client: () => ({
				mintRunnerToken: async (_runnerId, _jobId, kind) => {
					kinds.push(kind);
					return { token: TOKEN, expiresAt: null, replace: false };
				},
				reportRunnerProgress: async (_runnerId, _jobId, report) => {
					reports.push(report as Record<string, unknown>);
				}
			}),
			platform: 'linux',
			arch: 'x64',
			user: 'ci',
			isRoot: () => false,
			isElevated: async () => false,
			hasSystemd: () => true,
			hasDocker: () => true,
			uidGid: () => '1000:1000',
			fetch: (async (url: string) => {
				const version = /v(\d+\.\d+\.\d+)\//.exec(url)?.[1] ?? '2.321.0';
				return new Response(bodies.get(version) ?? '', { status: 200 });
			}) as unknown as typeof fetch,
			sleep: async () => undefined,
			now: () => Date.parse('2026-10-27T03:00:00Z'),
			nodeName: 'build-01'
		};
		const sha = (version: string) =>
			createHash('sha256')
				.update(bodies.get(version) as string)
				.digest('hex');
		const installJob = (mode: 'service' | 'docker', shareDockerDaemon = false) =>
			({
				id: 'job-1',
				leaseGeneration: 1,
				payload: {
					nodeId: 'n',
					scope: 'repo',
					target: 'acme/api',
					url: 'https://github.com/acme/api',
					mode,
					labels: ['gpu'],
					runners: [{ runnerId: RUNNER_ID, name: 'build-01-1' }],
					download: download('2.321.0', sha('2.321.0')),
					...(mode === 'docker' ? { shareDockerDaemon } : {})
				}
			}) as unknown as FleetJobView;
		return { deps, reports, execs, kinds, installJob, sha };
	}

	it('docker mode: pins the image, registers with the token in Docker’s environment only, starts the container', async () => {
		const { deps, reports, execs, installJob } = harness();
		await createRunnerInstallExecutor(deps)(installJob('docker'), new AbortController().signal);
		const docker = execs.filter((call) => call.command === 'docker');
		expect(docker.map((call) => call.args[0])).toEqual(['pull', 'image', 'run', 'rm', 'run']);
		const config = docker[2];
		expect(config.args.slice(0, 2)).toEqual(['run', '--rm']);
		expect(config.env?.[RUNNER_TOKEN_ENV]).toBe(TOKEN);
		for (const call of execs) expect([call.command, ...call.args].join(' ')).not.toContain(TOKEN);
		const run = docker[4];
		expect(run.args).toContain('unless-stopped');
		expect(run.args.join(' ')).not.toContain(DOCKER_SOCKET);
		expect(run.env).toBeUndefined();
		expect(reports.at(-1)).toMatchObject({ state: 'idle', serviceUnit: runnerContainerName(RUNNER_ID) });
		expect((await deps.state.readMeta('build-01-1'))?.image).toBe(IMAGE);
	});

	it('docker mode with the opt-in mounts the Docker socket; refused on a computer without Docker', async () => {
		const shared = harness();
		await createRunnerInstallExecutor(shared.deps)(shared.installJob('docker', true), new AbortController().signal);
		const run = shared.execs.filter((call) => call.command === 'docker').at(-1);
		expect(run?.args.join(' ')).toContain(`source=${DOCKER_SOCKET}`);

		const none = harness();
		none.deps.hasDocker = () => false;
		await expect(
			createRunnerInstallExecutor(none.deps)(none.installJob('docker'), new AbortController().signal)
		).rejects.toThrow(/cannot run container-isolated runners/);
		expect(none.kinds).toEqual([]);
	});

	it('reinstall: deregisters (remove token), installs GitHub’s new build with the same name, reports idle', async () => {
		const { deps, reports, kinds, installJob, sha } = harness();
		await createRunnerInstallExecutor(deps)(installJob('service'), new AbortController().signal);
		kinds.length = 0;
		const job = {
			id: 'job-2',
			leaseGeneration: 1,
			payload: {
				runnerId: RUNNER_ID,
				name: 'build-01-1',
				action: 'reinstall',
				download: download('2.322.0', sha('2.322.0')),
				url: 'https://github.com/acme/api',
				labels: ['gpu']
			}
		} as unknown as FleetJobView;
		const result = await createRunnerControlExecutor(deps)(job, new AbortController().signal);
		expect(result).toMatchObject({ state: 'idle', runnerVersion: '2.322.0' });
		expect(kinds).toEqual(['remove', 'register']);
		expect(reports.at(-1)).toMatchObject({ state: 'idle', runnerVersion: '2.322.0' });
		expect((await deps.state.readMeta('build-01-1'))?.runnerVersion).toBe('2.322.0');
	});

	it('reinstall refuses a registration URL that is not the runner’s own target', async () => {
		const { deps, installJob, sha } = harness();
		await createRunnerInstallExecutor(deps)(installJob('service'), new AbortController().signal);
		const job = {
			id: 'job-3',
			leaseGeneration: 1,
			payload: {
				runnerId: RUNNER_ID,
				name: 'build-01-1',
				action: 'reinstall',
				download: download('2.322.0', sha('2.322.0')),
				url: 'https://github.com/someone/else'
			}
		} as unknown as FleetJobView;
		await expect(createRunnerControlExecutor(deps)(job, new AbortController().signal)).rejects.toThrow(
			/unexpected registration URL/
		);
		expect((await deps.state.readMeta('build-01-1'))?.runnerVersion).toBe('2.321.0');
	});
});
