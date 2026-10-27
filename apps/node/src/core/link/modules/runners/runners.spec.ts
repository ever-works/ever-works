import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetActionsRunnerDownload, FleetJobView } from '@ever-works/contracts';
import { createRunnerControlExecutor, parseRunnerControlPayload } from '../../../executors/runner-control';
import { createRunnerInstallExecutor, parseRunnerInstallPayload } from '../../../executors/runner-install';
import { canHostActionsRunners, createRunnersModule } from '../runners';
import { configureRunner, RUNNER_TOKEN_ENV, runnerConfigArgs, runnerScriptCommand } from './config';
import { assertRunnerDownloadFor, downloadRunnerArchive } from './download';
import { RunnerHostError, type RunnerExecRequest, type RunnerHostDeps, type RunnerJobClient } from './host';
import { pickNewestRunnerDiagLog } from './logs';
import { linuxSudoersCommand, runnerServiceManagerFor } from './service';
import { parseRunnerMeta, RunnerState } from './state';

/** Actions runners on computers (FL-18, plan §14) — the node's argv, download, service rules and executors. */

const TOKEN = 'AABBCCDDEEFFGGHHIIJJKKLLMMNNOO';
const RUNNER_ID = '7d0f3a52-9b1e-4c6f-8a2d-3e4f5a6b7c8d';
const OTHER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SHA = 'a'.repeat(64);

function download(overrides: Partial<FleetActionsRunnerDownload> = {}): FleetActionsRunnerDownload {
	return {
		os: 'linux',
		architecture: 'x64',
		downloadUrl:
			'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz',
		filename: 'actions-runner-linux-x64-2.321.0.tar.gz',
		sha256: SHA,
		...overrides
	};
}

describe('runnerConfigArgs (FR-7, FR-8, FR-9)', () => {
	const base = {
		platform: 'linux',
		url: 'https://github.com/acme/api',
		name: 'build-01-1',
		labels: ['gpu'],
		replace: false
	};

	it('is unattended, names the URL, name, labels and work folder — and never a token', () => {
		const args = runnerConfigArgs(base);
		expect(args).toEqual([
			'--unattended',
			'--url',
			'https://github.com/acme/api',
			'--name',
			'build-01-1',
			'--work',
			'_work',
			'--labels',
			'gpu'
		]);
		expect(args.join(' ')).not.toContain('--token');
	});

	it('passes --replace only when the platform said the name is this runner, --runasservice only on Windows', () => {
		expect(runnerConfigArgs({ ...base, replace: true })).toContain('--replace');
		expect(runnerConfigArgs(base)).not.toContain('--replace');
		expect(runnerConfigArgs({ ...base, platform: 'win32' })).toContain('--runasservice');
		expect(runnerConfigArgs(base)).not.toContain('--runasservice');
	});

	it('refuses a name or URL a caller shaped', () => {
		expect(() => runnerConfigArgs({ ...base, name: '../etc' })).toThrow(RunnerHostError);
		expect(() => runnerConfigArgs({ ...base, url: 'https://example.com/acme/api' })).toThrow(RunnerHostError);
	});

	it('gives the token to the runner through its environment only (never argv)', async () => {
		const calls: RunnerExecRequest[] = [];
		await configureRunner(
			async (request) => {
				calls.push(request);
				return { code: 0, stdout: '', stderr: '' };
			},
			'/data/actions-runners/build-01-1',
			base,
			TOKEN
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].env?.[RUNNER_TOKEN_ENV]).toBe(TOKEN);
		expect([calls[0].command, ...calls[0].args].join(' ')).not.toContain(TOKEN);
	});

	it('refuses — never falls back to argv — when the runner build does not read the token from the environment', async () => {
		await expect(
			configureRunner(
				async () => ({ code: 1, stdout: '', stderr: 'Enter the runner registration token:' }),
				'/data/r',
				base,
				TOKEN
			)
		).rejects.toThrow(/did not read its token from the environment/);
	});

	it('starts Windows scripts through cmd.exe with the script relative to the runner folder', () => {
		expect(
			runnerScriptCommand('win32', 'C:\\r\\a', 'config', ['--x'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
		).toEqual({
			command: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/c', 'config.cmd', '--x']
		});
	});
});

describe('runner download (FR-6, U6)', () => {
	it('accepts only GitHub release assets for THIS machine with a checksum', () => {
		expect(assertRunnerDownloadFor(download(), 'linux', 'x64').filename).toBe(
			'actions-runner-linux-x64-2.321.0.tar.gz'
		);
		expect(() =>
			assertRunnerDownloadFor(
				download({ downloadUrl: 'https://example.com/actions/runner/releases/download/x.tar.gz' }),
				'linux',
				'x64'
			)
		).toThrow(/not a GitHub release asset/);
		expect(() => assertRunnerDownloadFor(download({ sha256: 'nope' }), 'linux', 'x64')).toThrow(/no checksum/);
		expect(() => assertRunnerDownloadFor(download(), 'darwin', 'arm64')).toThrow(/not this computer/);
	});

	describe('with a folder', () => {
		let root: string;
		beforeEach(async () => {
			root = await mkdtemp(join(tmpdir(), 'ew-runners-'));
		});
		afterEach(async () => {
			await rm(root, { recursive: true, force: true });
		});

		const fetchOf = (body: string) =>
			(async () =>
				new Response(body, {
					status: 200,
					headers: { 'content-length': String(body.length) }
				})) as unknown as typeof fetch;

		it('keeps an archive whose SHA-256 matches', async () => {
			const body = 'runner build bytes';
			const sha = createHash('sha256').update(body).digest('hex');
			const path = await downloadRunnerArchive(
				{ state: new RunnerState(root), fetch: fetchOf(body) },
				download({ sha256: sha }),
				new AbortController().signal
			);
			expect(await readFile(path, 'utf8')).toBe(body);
		});

		it('deletes a mismatching archive and names the file (nothing is extracted)', async () => {
			await expect(
				downloadRunnerArchive(
					{ state: new RunnerState(root), fetch: fetchOf('tampered') },
					download(),
					new AbortController().signal
				)
			).rejects.toThrow('checksum mismatch for actions-runner-linux-x64-2.321.0.tar.gz — nothing was installed');
			await expect(
				readFile(join(root, '.downloads', 'actions-runner-linux-x64-2.321.0.tar.gz'))
			).rejects.toThrow();
		});
	});
});

describe('service rules (FR-9, U3, U4)', () => {
	it('knows a service manager per OS (none on a Linux without systemd)', () => {
		expect(runnerServiceManagerFor('linux', true)).toBe('systemd');
		expect(runnerServiceManagerFor('linux', false)).toBeNull();
		expect(runnerServiceManagerFor('darwin', false)).toBe('launchd');
		expect(runnerServiceManagerFor('win32', false)).toBe('windows');
		expect(canHostActionsRunners('freebsd', false)).toBe(false);
	});

	it('the sudoers command is narrow: only svc.sh under this node’s runners folder', () => {
		const command = linuxSudoersCommand('ci', '/home/ci/.config/ever-works-node/actions-runners');
		expect(command).toContain('ci ALL=(root) NOPASSWD: /home/ci/.config/ever-works-node/actions-runners/*/svc.sh');
		expect(command).toContain('/etc/sudoers.d/ever-works-actions-runners');
	});

	it('the module tags actions-runner only under --work with a service manager', () => {
		const module = createRunnersModule({
			state: new RunnerState('/nowhere'),
			exec: async () => ({ code: 0, stdout: '', stderr: '' }),
			client: () => ({}) as RunnerJobClient,
			platform: 'linux',
			arch: 'x64',
			user: 'ci',
			isRoot: () => false,
			isElevated: async () => false,
			hasSystemd: () => true,
			nodeName: 'build-01'
		});
		const env = (work: boolean, platform = 'linux') => ({
			consents: { work, manage: false, observe: false, usageScan: false } as never,
			platform,
			nodeVersion: '1.0.0'
		});
		expect(module.tags?.(env(true))).toEqual(['actions-runner']);
		expect(module.tags?.(env(false))).toEqual([]);
		expect(Object.keys(module.machineVerbs ?? {})).toEqual(['runner.list', 'runner.status']);
		expect(module.machineVerbs?.['runner.list'].stateChanging).toBe(false);
	});
});

describe('runner state and logs', () => {
	it('reads only well-formed meta (never a token field)', () => {
		const meta = parseRunnerMeta(
			JSON.stringify({
				runnerId: RUNNER_ID,
				name: 'build-01-1',
				scope: 'repo',
				target: 'acme/api',
				labels: ['gpu'],
				mode: 'service'
			})
		);
		expect(meta?.name).toBe('build-01-1');
		expect(parseRunnerMeta('{"runnerId":"x","name":"../../etc","scope":"repo","target":"a/b"}')).toBeNull();
		expect(() => new RunnerState('/r').dir('..')).toThrow();
	});

	it('picks the newest diagnostic log', () => {
		expect(
			pickNewestRunnerDiagLog([
				{ name: 'Runner_20261026-090000-utc.log', mtimeMs: 1 },
				{ name: 'Worker_20261026-100000-utc.log', mtimeMs: 9 },
				{ name: 'Runner_20261026-100000-utc.log', mtimeMs: 5 }
			])
		).toBe('Runner_20261026-100000-utc.log');
		expect(pickNewestRunnerDiagLog([])).toBeNull();
	});
});

describe('payload parsing (never trusted from the platform)', () => {
	const job = (payload: Record<string, unknown>): FleetJobView =>
		({ id: 'job-1', payload, leaseGeneration: 1 }) as unknown as FleetJobView;

	it('runner-install: a repository, its URL, unique valid names, no token field', () => {
		const parsed = parseRunnerInstallPayload(
			job({
				nodeId: 'n',
				scope: 'repo',
				target: 'acme/api',
				url: 'https://github.com/acme/api',
				mode: 'service',
				labels: ['gpu', 'not a label'],
				runners: [{ runnerId: RUNNER_ID, name: 'build-01-1' }],
				download: download(),
				token: 'smuggled'
			})
		);
		expect(parsed.labels).toEqual(['gpu']);
		expect(JSON.stringify(parsed)).not.toContain('smuggled');
		expect(() =>
			parseRunnerInstallPayload(
				job({
					nodeId: 'n',
					scope: 'repo',
					target: 'acme/api',
					url: 'https://evil.example/acme/api',
					mode: 'service',
					runners: []
				})
			)
		).toThrow(/registration URL/);
	});

	it('runner-control: a runner id, a valid name, a known act', () => {
		expect(parseRunnerControlPayload(job({ runnerId: RUNNER_ID, name: 'build-01-1', action: 'stop' })).action).toBe(
			'stop'
		);
		expect(() =>
			parseRunnerControlPayload(job({ runnerId: RUNNER_ID, name: 'build-01-1', action: 'format' }))
		).toThrow();
	});
});

describe('executors (T-14)', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'ew-runners-exec-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function harness(options: { sudo: boolean; platform?: string }) {
		const reports: Array<{ runnerId: string; report: Record<string, unknown> }> = [];
		const execs: RunnerExecRequest[] = [];
		let tokens = 0;
		const body = 'runner build bytes';
		const sha = createHash('sha256').update(body).digest('hex');
		const deps: RunnerHostDeps = {
			state: new RunnerState(root),
			exec: async (request) => {
				execs.push(request);
				if (request.command === 'sudo' && !options.sudo)
					return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
				if (request.command === 'tar') {
					const into = request.args[request.args.indexOf('-C') + 1];
					await mkdir(into, { recursive: true });
					await writeFile(join(into, 'config.sh'), '#!/bin/sh\n');
				}
				if (request.command.endsWith('config.sh') && request.args[0] === '--unattended') {
					const dir = request.cwd as string;
					await writeFile(join(dir, '.runner'), JSON.stringify({ agentId: 42 }));
					await writeFile(join(dir, '.service'), 'actions.runner.acme-api.build-01-1.service');
				}
				return { code: 0, stdout: '', stderr: '' };
			},
			client: () => ({
				mintRunnerToken: async () => {
					tokens += 1;
					return { token: TOKEN, expiresAt: null, replace: false };
				},
				reportRunnerProgress: async (runnerId, _jobId, report) => {
					reports.push({ runnerId, report: report as Record<string, unknown> });
				}
			}),
			platform: options.platform ?? 'linux',
			arch: 'x64',
			user: 'ci',
			isRoot: () => false,
			isElevated: async () => false,
			hasSystemd: () => true,
			fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
			sleep: async () => undefined,
			now: () => Date.parse('2026-10-26T10:00:00Z'),
			nodeName: 'build-01'
		};
		const installJob = {
			id: 'job-1',
			leaseGeneration: 1,
			payload: {
				nodeId: 'n',
				scope: 'repo',
				target: 'acme/api',
				url: 'https://github.com/acme/api',
				mode: 'service',
				labels: ['gpu'],
				runners: [{ runnerId: RUNNER_ID, name: 'build-01-1' }],
				download: download({ sha256: sha })
			}
		} as unknown as FleetJobView;
		return { deps, reports, execs, installJob, tokens: () => tokens };
	}

	it('install: phases in order, the token only in the child environment, idle at the end', async () => {
		const { deps, reports, execs, installJob, tokens } = harness({ sudo: true });
		await createRunnerInstallExecutor(deps)(installJob, new AbortController().signal);
		expect(reports.map((entry) => entry.report.phase).filter(Boolean)).toEqual([
			'downloading',
			'verifying',
			'awaiting-token',
			'registering',
			'installing-service',
			'starting',
			'done'
		]);
		expect(reports.at(-1)?.report).toMatchObject({ state: 'idle', githubRunnerId: 42 });
		expect(tokens()).toBe(1);
		for (const call of execs) expect([call.command, ...call.args].join(' ')).not.toContain(TOKEN);
		expect(execs.filter((call) => call.env?.[RUNNER_TOKEN_ENV] === TOKEN)).toHaveLength(1);
		expect(JSON.stringify(reports)).not.toContain(TOKEN);
		expect((await deps.state.readMeta('build-01-1'))?.configured).toBe(true);
	});

	it('install without passwordless sudo: refused root_required with the exact command BEFORE a token is asked for', async () => {
		const { deps, reports, installJob, tokens } = harness({ sudo: false });
		await expect(createRunnerInstallExecutor(deps)(installJob, new AbortController().signal)).rejects.toThrow(
			/needs passwordless sudo.*sudo tee \/etc\/sudoers\.d\/ever-works-actions-runners/
		);
		expect(tokens()).toBe(0);
		expect(reports.at(-1)?.report).toMatchObject({ state: 'failed' });
		expect(await deps.state.readMeta('build-01-1')).toBeNull();
	});

	it('control refuses a folder that belongs to another runner row', async () => {
		const { deps } = harness({ sudo: true });
		await deps.state.writeMeta({
			runnerId: OTHER_ID,
			name: 'build-01-1',
			scope: 'repo',
			target: 'acme/api',
			labels: [],
			mode: 'service',
			runnerVersion: null,
			sha256: null,
			configured: true,
			serviceUnit: null,
			installedAt: null
		});
		const job = {
			id: 'job-2',
			leaseGeneration: 1,
			payload: { runnerId: RUNNER_ID, name: 'build-01-1', action: 'remove' }
		} as unknown as FleetJobView;
		await expect(createRunnerControlExecutor(deps)(job, new AbortController().signal)).rejects.toThrow(
			/belongs to another runner/
		);
		expect((await deps.state.readMeta('build-01-1'))?.runnerId).toBe(OTHER_ID);
	});

	it('remove: uninstall, deregister with a remove token (environment only), delete exactly its folder', async () => {
		const { deps, reports, execs, installJob } = harness({ sudo: true });
		await createRunnerInstallExecutor(deps)(installJob, new AbortController().signal);
		await mkdir(join(root, 'neighbour'), { recursive: true });
		const before = execs.length;
		const job = {
			id: 'job-3',
			leaseGeneration: 1,
			payload: { runnerId: RUNNER_ID, name: 'build-01-1', action: 'remove' }
		} as unknown as FleetJobView;
		const result = await createRunnerControlExecutor(deps)(job, new AbortController().signal);
		expect(result).toMatchObject({ state: 'removed', deregistered: true });
		const removeCalls = execs.slice(before);
		expect(removeCalls.some((call) => call.args.includes('uninstall'))).toBe(true);
		const deregister = removeCalls.find((call) => call.args[0] === 'remove');
		expect(deregister?.env?.[RUNNER_TOKEN_ENV]).toBe(TOKEN);
		expect(reports.at(-1)?.report).toMatchObject({ state: 'removed', deregistered: true });
		expect(await deps.state.readMeta('build-01-1')).toBeNull();
		// Exactly its folder: a neighbour under the runners folder is untouched.
		expect((await stat(join(root, 'neighbour'))).isDirectory()).toBe(true);
		await expect(stat(join(root, 'build-01-1'))).rejects.toThrow();
	});
});
