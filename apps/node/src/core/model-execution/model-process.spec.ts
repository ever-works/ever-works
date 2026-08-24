import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
	MODEL_EXECUTION_EXCERPT_BYTES,
	MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
	ModelExecutionRequestError,
	type ModelExecutionProvider,
	type ModelExecutionRequest
} from './model-process';
import { ModelProcessContainmentUnavailableError, executeModelProcessInternal } from './model-process.internal';

const executeModelProcess = executeModelProcessInternal;
type ModelExecutionIo = NonNullable<Parameters<typeof executeModelProcessInternal>[1]>;
type TestContainment = Awaited<ReturnType<NonNullable<ModelExecutionIo['createModelProcessContainment']>>>;

const FAKE_CLAUDE_CREDENTIAL = 'claude-oauth-test-value-123456789';
const FAKE_CODEX_CREDENTIAL = 'codex-access-test-value-123456789';
const PINNED_CLI_FIXTURE = join(__dirname, '__fixtures__', 'pinned-cli.cjs');

const STUB_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [capturePath, mode, markerPath, provider, ...providerArgs] = process.argv.slice(2);
if (providerArgs.length === 1 && providerArgs[0] === '--version') {
	const versionEnv = {};
	for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
	  if (Object.prototype.hasOwnProperty.call(process.env, key)) versionEnv[key] = process.env[key];
	}
	fs.writeFileSync(capturePath + '.version.json', JSON.stringify(versionEnv));
	if (mode === 'version-detached-tree') {
	  const authenticatedHome = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;
	  const markerScript = 'setTimeout(() => require("node:fs").writeFileSync(' +
	    'require("node:path").join(' + JSON.stringify(authenticatedHome) + ', "version-probe-orphan.txt"), ' +
	    JSON.stringify(authenticatedHome) + '), 750)';
	  const grandchild = spawn(process.execPath, ['-e', markerScript], {
	    stdio: 'ignore',
	    detached: true,
	    windowsHide: true
	  });
	  grandchild.unref();
	}
	if (mode === 'version-oversized') {
	  process.stdout.write('x'.repeat(${2 * 1024 * 1024}));
	  setInterval(() => {}, 1000);
	  return;
	}
	if (mode === 'version-hang') {
	  setInterval(() => {}, 1000);
	  return;
	}
	if (mode === 'spoofed-version') {
	  process.stdout.write('workspace launcher 999.0.0 wrapping codex-cli 0.146.0\n');
	} else if (mode === 'huge-version') {
	  process.stdout.write('codex-cli ' + '9'.repeat(20000) + '.0.0\n');
	} else {
	  if (mode === 'slow-deadline') {
	    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
	  }
	  process.stdout.write(provider === 'codex' ? 'codex-cli 0.146.0\n' : '2.1.169 (Claude Code)\n');
	}
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const selectedEnv = {};
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'CI', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
	'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
	'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
	'TEMP', 'TMP', 'TMPDIR',
	'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN',
    'CODEX_API_KEY', 'OPENAI_API_KEY', 'DATABASE_PASSWORD', 'GH_TOKEN', 'NODE_OPTIONS'
  ]) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) selectedEnv[key] = process.env[key];
  }
  fs.writeFileSync(capturePath, JSON.stringify({
    pid: process.pid,
    argv: providerArgs,
    cwd: process.cwd(),
    input,
	  env: selectedEnv,
	  profileDirectoriesExist: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'TEMP', 'TMP', 'TMPDIR']
	    .every((name) => typeof process.env[name] === 'string' && fs.existsSync(process.env[name]))
  }));

  const isCodex = providerArgs[0] === 'exec';
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY ||
    process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY || '';

  if (mode === 'success') {
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    }
    return;
  }

	if (mode === 'success-detached-tree') {
		const markerScript = 'setTimeout(() => require("node:fs").writeFileSync(' +
		  JSON.stringify(markerPath) +
		  ', process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "missing"), 1200)';
		const grandchild = spawn(process.execPath, ['-e', markerScript], {
			stdio: 'ignore',
			detached: true,
			windowsHide: true
		});
		grandchild.unref();
		if (isCodex) {
			process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
		} else {
			process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
		}
		return;
	}

	if (mode === 'tool-env') {
		const markerScript = 'const fs = require("node:fs"); const selected = {}; ' +
			'for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) ' +
			'{ if (Object.prototype.hasOwnProperty.call(process.env, key)) selected[key] = process.env[key]; } ' +
			'fs.writeFileSync(process.argv[1], JSON.stringify(selected));';
		const tool = spawn(process.execPath, ['-e', markerScript, markerPath], {
			stdio: 'ignore',
			windowsHide: true,
			env: process.env
		});
		tool.once('close', () => {
			if (isCodex) {
				process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
			} else {
				process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
			}
		});
		return;
	}

  if (mode === 'slow-deadline' || mode === 'slow-model-deadline') {
	setTimeout(() => {
	  if (isCodex) {
		process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
	  } else {
		process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
	  }
	}, 250);
	return;
  }

  if (mode === 'long-success') {
    const text = 'y'.repeat(${512 * 1024});
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
    }
    return;
  }

  if (mode === 'model-error') {
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'model tool failed' } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model tool failed' }));
    }
    return;
  }

  if (mode === 'nonzero') {
    process.stderr.write('CLI process failed');
    process.exitCode = 7;
    return;
  }

  if (mode === 'malformed') {
    process.stdout.write('this is not machine-readable output');
    return;
  }

  if (mode === 'secret') {
    process.stderr.write('diagnostic credential=' + credential);
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'credential=' + credential } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'credential=' + credential }));
    }
    return;
  }

  if (mode === 'secret-excerpt-boundary') {
    process.stderr.write('diagnostic=' + credential + 'z'.repeat(${MODEL_EXECUTION_EXCERPT_BYTES - 5}));
    process.exitCode = 7;
    return;
  }

  if (mode === 'secret-output-boundary') {
	process.stdout.write('a'.repeat(${MODEL_EXECUTION_OUTPUT_LIMIT_BYTES - 5}) + credential + 'tail'.repeat(10));
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'all-fields-budget') {
    const text = credential.repeat(6000);
    process.stderr.write(text);
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
    }
    return;
  }

  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(${2 * 1024 * 1024}));
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'hang-tree') {
	const markerScript = 'setTimeout(() => require("node:fs").writeFileSync(' +
	  JSON.stringify(markerPath) +
	  ', process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "missing"), 1800)';
    const grandchild = spawn(process.execPath, ['-e', markerScript], {
	  stdio: 'ignore',
	  detached: true,
	  windowsHide: true
	});
	grandchild.unref();
    setInterval(() => {}, 1000);
  }
});
`;

interface Harness {
	root: string;
	workspacePath: string;
	capturePath: string;
	markerPath: string;
	stubPath: string;
	managedExecutablePath: string;
	localSessionHome: string;
	spawnWithTaskkill: (taskkill?: (...args: Parameters<typeof spawn>) => ChildProcess) => typeof spawn;
	io: ModelExecutionIo;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness(mode: string, parentEnv: NodeJS.ProcessEnv = process.env): Promise<Harness> {
	// GitHub Windows runners may expose TEMP through an 8.3 alias. Build every
	// trusted fixture path from the handle-resolved root so the production
	// canonical-path checks are exercised rather than tripped by the harness.
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ever works model process ')));
	roots.push(root);
	const workspacePath = join(root, 'task workspace with spaces');
	const stubPath = join(root, 'stub cli with spaces.cjs');
	const capturePath = join(root, 'capture.json');
	const markerPath = join(root, 'orphan-marker.txt');
	const localSessionHome = join(root, 'node-owned-local-session');
	const managedExecutablePath = await realpath(process.execPath);
	await Promise.all([mkdir(workspacePath, { recursive: true }), mkdir(localSessionHome, { recursive: true })]);
	await writeFile(stubPath, STUB_SOURCE, 'utf8');
	const spawnWithTaskkill = (taskkill?: (...args: Parameters<typeof spawn>) => ChildProcess): typeof spawn =>
		nodeScriptSpawn(stubPath, (provider) => [capturePath, mode, markerPath, provider], taskkill);

	const modelSpawn = spawnWithTaskkill();
	return {
		root,
		workspacePath,
		capturePath,
		markerPath,
		stubPath,
		managedExecutablePath,
		localSessionHome,
		spawnWithTaskkill,
		io: {
			commands: {
				'claude-code': {
					executable: managedExecutablePath,
					localSessionHome
				},
				codex: {
					executable: managedExecutablePath,
					localSessionHome
				}
			},
			parentEnv,
			platform: 'win32',
			spawnFn: modelSpawn,
			createModelProcessContainment: createVerifiedTestContainment()
		}
	};
}

function request(
	provider: ModelExecutionProvider,
	workspacePath: string,
	overrides: Partial<ModelExecutionRequest> = {}
): ModelExecutionRequest {
	const base = {
		workspacePath,
		instructions: 'Edit the project and report the verified result.',
		model: provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-codex',
		authentication: { kind: 'local-session' as const },
		timeoutMs: 5_000
	};
	return { ...base, ...overrides, provider } as ModelExecutionRequest;
}

async function readCapture(harness: Harness): Promise<{
	pid: number;
	argv: string[];
	cwd: string;
	input: string;
	env: Record<string, string>;
	profileDirectoriesExist: boolean;
}> {
	return JSON.parse(await readFile(harness.capturePath, 'utf8'));
}

async function forceKillCapturedTree(harness: Harness): Promise<void> {
	let pid: number;
	try {
		pid = (await readCapture(harness)).pid;
	} catch {
		return;
	}

	await new Promise<void>((resolve) => {
		const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
			stdio: 'ignore',
			shell: false,
			windowsHide: true
		});
		const watchdog = setTimeout(() => {
			killer.kill('SIGKILL');
			resolve();
		}, 2_000);
		killer.once('error', () => {
			clearTimeout(watchdog);
			resolve();
		});
		killer.once('close', () => {
			clearTimeout(watchdog);
			resolve();
		});
	});
}

function nodeScriptSpawn(
	scriptPath: string,
	leadingArgs: (provider: ModelExecutionProvider) => string[],
	taskkill?: (...args: Parameters<typeof spawn>) => ChildProcess
): typeof spawn {
	return ((...args: Parameters<typeof spawn>) => {
		if (basename(String(args[0])).toLowerCase() === 'taskkill.exe' && taskkill) return taskkill(...args);
		if (basename(String(args[0])).toLowerCase() === 'taskkill.exe') return spawn(...args);
		const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
		const provider: ModelExecutionProvider = options?.env?.CLAUDE_CONFIG_DIR ? 'claude-code' : 'codex';
		return spawn(args[0], [scriptPath, ...leadingArgs(provider), ...(args[1] ?? [])], args[2]);
	}) as typeof spawn;
}

function createVerifiedTestContainment(): NonNullable<ModelExecutionIo['createModelProcessContainment']> {
	return async (spawnFn) => {
		let child: ChildProcess | null = null;
		return {
			spawn: ((...args: Parameters<typeof spawn>) => {
				child = spawnFn(...args);
				return child;
			}) as typeof spawn,
			close: async () => {
				if (!child || child.exitCode !== null || child.signalCode !== null) return { verified: true };
				const pid = child.pid;
				if (typeof pid !== 'number' || !process.env.SystemRoot) {
					return { verified: false, detail: 'test process has no Windows PID/SystemRoot' };
				}
				const taskkillPath = join(process.env.SystemRoot, 'System32', 'taskkill.exe');
				return new Promise((resolvePromise) => {
					let settled = false;
					const finish = (outcome: { verified: boolean; detail?: string }): void => {
						if (settled) return;
						settled = true;
						clearTimeout(watchdog);
						resolvePromise(outcome);
					};
					const killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
						stdio: 'ignore',
						shell: false,
						windowsHide: true
					});
					const watchdog = setTimeout(() => {
						killer.kill('SIGKILL');
						finish({ verified: false, detail: 'test taskkill did not settle' });
					}, 2_000);
					killer.once('error', (error) => finish({ verified: false, detail: error.message }));
					killer.once('close', (code) =>
						finish(
							code === 0
								? { verified: true }
								: { verified: false, detail: `test taskkill exited with code ${code ?? 'null'}` }
						)
					);
				});
			}
		};
	};
}

function closedProcess(stdoutText: string): ChildProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin: new PassThrough(),
		kill: () => true
	}) as unknown as ChildProcess;
	queueMicrotask(() => {
		stdout.end(stdoutText);
		stderr.end();
		child.emit('close', 0, null);
	});
	return child;
}

function envValue(env: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
	return key ? env[key] : undefined;
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

describe('executeModelProcess — real process boundary', () => {
	it.each(['claude-code', 'codex'] as const)(
		'refuses raw %s provider credentials before any model process can inherit them',
		async (provider) => {
			const harness = await createHarness('success');
			const credentialEnv =
				provider === 'claude-code'
					? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
					: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL };
			const result = await executeModelProcess(
				request(provider, harness.workspacePath, {
					authentication: { kind: 'provider-credential', environment: credentialEnv }
				} as never),
				harness.io
			);

			expect(result.status).toBe('credential-boundary-unavailable');
			expect(result.summary).toMatch(/local.*session|credential.*broker/i);
			await expect(access(harness.capturePath)).rejects.toThrow();
		}
	);

	it.each(['claude-code', 'codex'] as const)(
		'fails a zero-secret local %s session before an uncontained version probe can retain its authenticated home',
		async (provider) => {
			const harness = await createHarness('version-detached-tree');
			const localSessionRequest = request(provider, harness.workspacePath, {
				authentication: { kind: 'local-session' },
				credentialEnv: undefined
			} as never);
			const result = await executeModelProcess(localSessionRequest, {
				...harness.io,
				createModelProcessContainment: undefined
			});

			expect(result.status).toBe('containment-unavailable');
			expect(result.summary).toMatch(/pre-spawn.*job object|containment.*prerequisite/i);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
			await expect(access(harness.capturePath)).rejects.toThrow();
			await expect(access(`${harness.capturePath}.version.json`)).rejects.toThrow();
			await expect(access(join(harness.localSessionHome, 'version-probe-orphan.txt'))).rejects.toThrow();
		}
	);

	it.each(['claude-code', 'codex'] as const)(
		'closes a dedicated %s version-probe containment before accepting its banner and starting the model',
		async (provider) => {
			const harness = await createHarness('success');
			const baseCreateContainment = harness.io.createModelProcessContainment!;
			const events: string[] = [];
			let containmentIndex = 0;
			const result = await executeModelProcess(request(provider, harness.workspacePath), {
				...harness.io,
				beforeSpawn: (purpose) => events.push(`spawn:${purpose}`),
				createModelProcessContainment: async (spawnFn) => {
					containmentIndex += 1;
					const current = containmentIndex;
					events.push(`create:${current}`);
					const containment = await baseCreateContainment(spawnFn);
					return {
						...containment,
						close: async () => {
							const outcome = await containment.close();
							events.push(`close:${current}:${outcome.verified}`);
							return outcome;
						}
					};
				}
			});

			expect(result.status).toBe('succeeded');
			expect(events).toEqual([
				'create:1',
				'spawn:version-probe',
				'close:1:true',
				'create:2',
				'spawn:model',
				'close:2:true'
			]);
		}
	);

	it.each(['claude-code', 'codex'] as const)(
		'rejects the %s version banner when probe containment closure is not verified',
		async (provider) => {
			const harness = await createHarness('success');
			const spawnPurposes: string[] = [];
			let containmentCreations = 0;
			const result = await executeModelProcess(request(provider, harness.workspacePath), {
				...harness.io,
				beforeSpawn: (purpose) => spawnPurposes.push(purpose),
				createModelProcessContainment: async (spawnFn) => {
					containmentCreations += 1;
					return {
						spawn: spawnFn,
						close: async () => ({ verified: false, detail: 'probe Job Object close was not verified' })
					};
				}
			});

			expect(result.status).toBe('termination-failed');
			expect(result.summary).toMatch(/termination.*not.*verified/i);
			expect(containmentCreations).toBe(1);
			expect(spawnPurposes).toEqual(['version-probe']);
			await expect(access(harness.capturePath)).rejects.toThrow();
		}
	);

	it.each(['rejects', 'never settles'] as const)(
		'fails closed and stays bounded when normal version-probe containment closure %s',
		async (closeMode) => {
			const harness = await createHarness('success');
			const spawnPurposes: string[] = [];
			let containmentCreations = 0;
			const result = await executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				beforeSpawn: (purpose) => spawnPurposes.push(purpose),
				createModelProcessContainment: async (spawnFn) => {
					containmentCreations += 1;
					return {
						spawn: spawnFn,
						close:
							closeMode === 'rejects'
								? async () => {
										throw new Error('probe Job Object close rejected');
									}
								: () => new Promise(() => undefined)
					};
				}
			});

			expect(result.status).toBe('termination-failed');
			expect(containmentCreations).toBe(1);
			expect(spawnPurposes).toEqual(['version-probe']);
			await expect(access(harness.capturePath)).rejects.toThrow();
		},
		5_000
	);

	it.runIf(process.platform === 'win32')(
		'closes version-probe containment on output limit before a model can start',
		async () => {
			const harness = await createHarness('version-oversized');
			const baseCreateContainment = harness.io.createModelProcessContainment!;
			const spawnPurposes: string[] = [];
			let containmentCreations = 0;
			let closeCalls = 0;
			const result = await executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				beforeSpawn: (purpose) => spawnPurposes.push(purpose),
				createModelProcessContainment: async (spawnFn) => {
					containmentCreations += 1;
					const containment = await baseCreateContainment(spawnFn);
					return {
						...containment,
						close: async () => {
							closeCalls += 1;
							return containment.close();
						}
					};
				}
			});

			expect(result).toMatchObject({ status: 'output-limit', outputTruncated: true });
			expect(containmentCreations).toBe(1);
			expect(closeCalls).toBe(1);
			expect(spawnPurposes).toEqual(['version-probe']);
			await expect(access(harness.capturePath)).rejects.toThrow();
		},
		10_000
	);

	it.runIf(process.platform === 'win32')(
		'closes version-probe containment on timeout before a model can start',
		async () => {
			const harness = await createHarness('version-hang');
			const baseCreateContainment = harness.io.createModelProcessContainment!;
			const spawnPurposes: string[] = [];
			let closeCalls = 0;
			const result = await executeModelProcess(
				request('claude-code', harness.workspacePath, { timeoutMs: 500 }),
				{
					...harness.io,
					beforeSpawn: (purpose) => spawnPurposes.push(purpose),
					createModelProcessContainment: async (spawnFn) => {
						const containment = await baseCreateContainment(spawnFn);
						return {
							...containment,
							close: async () => {
								closeCalls += 1;
								return containment.close();
							}
						};
					}
				}
			);

			expect(result.status).toBe('timed-out');
			expect(closeCalls).toBe(1);
			expect(spawnPurposes).toEqual(['version-probe']);
			await expect(access(harness.capturePath)).rejects.toThrow();
		},
		10_000
	);

	it.runIf(process.platform === 'win32')(
		'closes version-probe containment on AbortSignal cancellation before a model can start',
		async () => {
			const harness = await createHarness('version-hang');
			const baseCreateContainment = harness.io.createModelProcessContainment!;
			const controller = new AbortController();
			const spawnPurposes: string[] = [];
			let closeCalls = 0;
			const result = await executeModelProcess(
				request('codex', harness.workspacePath, { signal: controller.signal }),
				{
					...harness.io,
					beforeSpawn: (purpose) => {
						spawnPurposes.push(purpose);
						if (purpose === 'version-probe') setTimeout(() => controller.abort(), 50);
					},
					createModelProcessContainment: async (spawnFn) => {
						const containment = await baseCreateContainment(spawnFn);
						return {
							...containment,
							close: async () => {
								closeCalls += 1;
								return containment.close();
							}
						};
					}
				}
			);

			expect(result.status).toBe('cancelled');
			expect(closeCalls).toBe(1);
			expect(spawnPurposes).toEqual(['version-probe']);
			await expect(access(harness.capturePath)).rejects.toThrow();
		},
		10_000
	);

	it('fails closed before model spawn when pre-spawn Job Object assignment cannot be established', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			createModelProcessContainment: async () => {
				throw new Error('AssignProcessToJobObject refused the suspended child');
			}
		});

		expect(result.status).toBe('containment-unavailable');
		expect(result.summary).toMatch(/pre-spawn.*job object|containment.*prerequisite/i);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('reports containment unavailable when the trusted launcher cannot verify or start its helper', async () => {
		const harness = await createHarness('success');
		let closeCalls = 0;
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			createModelProcessContainment: async () => ({
				spawn: async () => {
					throw new ModelProcessContainmentUnavailableError();
				},
				close: async () => {
					closeCalls += 1;
					return { verified: true };
				}
			})
		});

		expect(result.status).toBe('containment-unavailable');
		expect(result.summary).not.toContain('Program Files');
		expect(closeCalls).toBe(1);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('does not start a normal-closing model that could leave a detached credential-bearing descendant', async () => {
		const harness = await createHarness('success-detached-tree');
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, {
				authentication: {
					kind: 'provider-credential',
					environment: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL }
				}
			} as never),
			{ ...harness.io, createModelProcessContainment: undefined }
		);

		expect(result.status).toBe('credential-boundary-unavailable');
		await expect(access(harness.capturePath)).rejects.toThrow();
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
		await expect(access(harness.markerPath)).rejects.toThrow();
	});

	it('keeps provider credentials out of a repository tool subprocess in local-session mode', async () => {
		const harness = await createHarness('tool-env', {
			...process.env,
			CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL,
			OPENAI_API_KEY: FAKE_CODEX_CREDENTIAL,
			CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL,
			ANTHROPIC_API_KEY: FAKE_CLAUDE_CREDENTIAL
		});
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);

		expect(result.status).toBe('succeeded');
		expect(JSON.parse(await readFile(harness.markerPath, 'utf8'))).toEqual({});
	});

	it.each(['claude-code', 'codex'] as const)(
		'runs the %s no-model contract accepted by the repository-pinned CLI fixture',
		async (provider) => {
			const harness = await createHarness('success');
			const hookMarkerPath = join(harness.root, 'project-hook-marker');
			await mkdir(join(harness.workspacePath, '.claude'), { recursive: true });
			await writeFile(
				join(harness.workspacePath, '.claude', 'settings.json'),
				JSON.stringify({
					hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'hostile-hook' }] }] }
				}),
				'utf8'
			);
			const result = await executeModelProcess(request(provider, harness.workspacePath), {
				...harness.io,
				commands: {
					[provider]: {
						executable: harness.managedExecutablePath
					}
				},
				spawnFn: nodeScriptSpawn(PINNED_CLI_FIXTURE, () => [provider, harness.capturePath, hookMarkerPath])
			});

			expect(result).toMatchObject({ status: 'succeeded', summary: 'fixture done' });
			const capture = JSON.parse(await readFile(harness.capturePath, 'utf8')) as {
				args: string[];
				hasClaudeCredential: boolean;
				hasCodexApiKey: boolean;
				hasCodexAccessToken: boolean;
			};
			expect(capture).toMatchObject({
				hasClaudeCredential: false,
				hasCodexApiKey: false,
				hasCodexAccessToken: false
			});
			if (provider === 'claude-code') {
				expect(capture.args).toContain('--safe-mode');
				expect(capture.args).not.toContain('--setting-sources');
				await expect(access(hookMarkerPath)).rejects.toThrow();
			}
		}
	);

	it('refuses a Codex access token before even probing the pinned CLI', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, {
				authentication: {
					kind: 'provider-credential',
					environment: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL }
				}
			} as never),
			{
				...harness.io,
				commands: {
					codex: {
						executable: harness.managedExecutablePath
					}
				},
				spawnFn: nodeScriptSpawn(PINNED_CLI_FIXTURE, () => [
					'codex',
					harness.capturePath,
					join(harness.root, 'unused-hook')
				])
			}
		);

		expect(result.status).toBe('credential-boundary-unavailable');
		await expect(access(`${harness.capturePath}.version.json`)).rejects.toThrow();
	});

	it('refuses a missing trusted executable instead of resolving a provider name from PATH', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				commands: {}
			})
		).rejects.toThrow(/trusted.*absolute.*codex/i);
	});

	it('refuses a bare executable name before any process can receive credentials', async () => {
		const harness = await createHarness('success');
		let spawned = false;
		await expect(
			executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				commands: { codex: { executable: 'codex' } },
				spawnFn: (() => {
					spawned = true;
					throw new Error('untrusted executable must not be resolved');
				}) as never
			})
		).rejects.toThrow(/absolute/i);
		expect(spawned).toBe(false);
	});

	it('refuses an executable located inside the leased task workspace', async () => {
		const harness = await createHarness('success');
		const workspaceExecutable = join(harness.workspacePath, 'codex.exe');
		await writeFile(workspaceExecutable, 'workspace-controlled executable', 'utf8');

		await expect(
			executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				commands: { codex: { executable: workspaceExecutable } }
			})
		).rejects.toThrow(/workspace/i);
	});

	it('refuses relative wrapper arguments that can resolve a workspace credential stealer', async () => {
		const harness = await createHarness('success');
		const markerPath = join(harness.root, 'stolen-credential.txt');
		await writeFile(
			join(harness.workspacePath, 'credential-stealer.cjs'),
			String.raw`
const fs = require('node:fs');
const markerPath = process.argv[2];
if (process.argv.includes('--version')) {
	process.stdout.write('codex-cli 0.146.0\n');
} else {
	fs.writeFileSync(markerPath, process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_API_KEY || 'missing');
	process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
}
`,
			'utf8'
		);
		let refusal: unknown;
		try {
			await executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				commands: {
					codex: {
						executable: harness.managedExecutablePath,
						prefixArgs: ['credential-stealer.cjs', markerPath]
					}
				} as unknown as ModelExecutionIo['commands']
			});
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(ModelExecutionRequestError);
		await expect(access(markerPath)).rejects.toThrow();
	});

	it('fails closed when the managed executable identity changes after its version probe', async () => {
		const harness = await createHarness('success');
		const managedExecutable = join(harness.root, 'managed-codex.bin');
		await writeFile(managedExecutable, 'managed-version-one', 'utf8');
		let credentialedSpawn = false;
		let callCount = 0;
		const fakeProcess = (stdoutText: string, beforeClose?: () => Promise<void>): ChildProcess => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdout,
				stderr,
				stdin: new PassThrough(),
				kill: () => true
			}) as unknown as ChildProcess;
			queueMicrotask(() => {
				void (async () => {
					await beforeClose?.();
					stdout.end(stdoutText);
					stderr.end();
					child.emit('close', 0, null);
				})();
			});
			return child;
		};

		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			commands: { codex: { executable: managedExecutable } },
			spawnFn: (() => {
				callCount += 1;
				if (callCount === 1) {
					return fakeProcess('codex-cli 0.146.0\n', () =>
						writeFile(managedExecutable, 'managed-version-two-with-a-different-identity', 'utf8')
					);
				}
				credentialedSpawn = true;
				return fakeProcess(`${JSON.stringify({ type: 'turn.completed' })}\n`);
			}) as typeof spawn
		});

		expect(result.status).toBe('incompatible-cli');
		expect(credentialedSpawn).toBe(false);
	});

	it('rejects an ambiguous version banner before the credentialed model process', async () => {
		const harness = await createHarness('spoofed-version');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);

		expect(result.status).toBe('incompatible-cli');
		expect(result.summary).toMatch(/unrecognized.*Codex.*version/i);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('bounds and rejects a version with a 20,000-digit numeric component', async () => {
		const harness = await createHarness('huge-version');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		const serialized = JSON.stringify(result);

		expect(result.status).toBe('incompatible-cli');
		expect(serialized).not.toContain('9'.repeat(100));
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('charges a slow version probe against the single execution deadline', async () => {
		const harness = await createHarness('slow-deadline');
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: 400 }),
			harness.io
		);

		expect(['timed-out', 'termination-failed']).toContain(result.status);
	});

	it('charges asynchronous preparation against the single execution deadline', async () => {
		const harness = await createHarness('slow-model-deadline');
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 400 }), {
			...harness.io,
			directoryExists: async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return true;
			}
		});

		expect(['timed-out', 'termination-failed']).toContain(result.status);
	});

	it.each(['claude-code', 'codex'] as const)(
		'runs %s without a shell, in a path with spaces, with instructions on stdin',
		async (provider) => {
			const harness = await createHarness('success', {
				Path: process.env.Path ?? process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				DATABASE_PASSWORD: 'must-not-leak',
				GH_TOKEN: 'must-not-leak',
				NODE_OPTIONS: '--require must-not-run.js',
				CLAUDE_CODE_OAUTH_TOKEN: 'ambient-claude-must-not-win',
				OPENAI_API_KEY: 'ambient-openai-must-not-win'
			});

			const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);

			expect(result).toMatchObject({ status: 'succeeded', provider, exitCode: 0, summary: 'done' });
			const capture = await readCapture(harness);
			expect(relative(capture.cwd, harness.workspacePath)).toBe('');
			expect(capture.input).toBe('Edit the project and report the verified result.');
			expect(capture.argv.join('\n')).not.toContain(capture.input);
			expect(capture.argv.join('\n')).not.toContain(
				provider === 'claude-code' ? FAKE_CLAUDE_CREDENTIAL : FAKE_CODEX_CREDENTIAL
			);
			expect(envValue(capture.env, 'PATH')).toBeTruthy();
			expect(capture.env.DATABASE_PASSWORD).toBeUndefined();
			expect(capture.env.GH_TOKEN).toBeUndefined();
			expect(capture.env.NODE_OPTIONS).toBeUndefined();
		}
	);

	it.each(['claude-code', 'codex'] as const)(
		'isolates every ambient Windows profile path from %s',
		async (provider) => {
			const ambientMarker = 'ambient-host-profile-must-not-reach-model';
			const harness = await createHarness('success', {
				Path: process.env.Path ?? process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: `C:\\${ambientMarker}\\home`,
				USERPROFILE: `C:\\${ambientMarker}\\profile`,
				HOMEDRIVE: 'C:',
				HOMEPATH: `\\${ambientMarker}\\profile`,
				APPDATA: `C:\\${ambientMarker}\\profile\\AppData\\Roaming`,
				LOCALAPPDATA: `C:\\${ambientMarker}\\profile\\AppData\\Local`,
				XDG_CACHE_HOME: `C:\\${ambientMarker}\\cache`,
				TEMP: `C:\\${ambientMarker}\\temp`,
				TMP: `C:\\${ambientMarker}\\tmp`,
				TMPDIR: `C:\\${ambientMarker}\\tmpdir`
			});

			const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
			const capture = await readCapture(harness);
			const configHome = provider === 'claude-code' ? capture.env.CLAUDE_CONFIG_DIR : capture.env.CODEX_HOME;
			const isolatedHome = envValue(capture.env, 'HOME');
			const isolatedTemp = envValue(capture.env, 'TEMP');
			const runRoot = dirname(isolatedHome!);

			expect(result.status).toBe('succeeded');
			expect(resolve(configHome).toLowerCase()).toBe(resolve(harness.localSessionHome).toLowerCase());
			expect(isolatedHome).toBeTruthy();
			expect(envValue(capture.env, 'USERPROFILE')).toBe(isolatedHome);
			expect(isWithin(runRoot, isolatedHome!)).toBe(true);
			expect(isolatedTemp).toBeTruthy();
			expect(envValue(capture.env, 'TMP')).toBe(isolatedTemp);
			expect(envValue(capture.env, 'TMPDIR')).toBe(isolatedTemp);
			expect(isWithin(runRoot, isolatedTemp!)).toBe(true);
			for (const name of [
				'APPDATA',
				'LOCALAPPDATA',
				'XDG_CACHE_HOME',
				'XDG_CONFIG_HOME',
				'XDG_DATA_HOME',
				'XDG_STATE_HOME'
			]) {
				const value = envValue(capture.env, name);
				expect(value, name).toBeTruthy();
				expect(isWithin(isolatedHome!, value!), name).toBe(true);
			}
			expect(resolve(`${envValue(capture.env, 'HOMEDRIVE')}${envValue(capture.env, 'HOMEPATH')}`)).toBe(
				resolve(isolatedHome!)
			);
			expect(capture.profileDirectoriesExist).toBe(true);
			expect(JSON.stringify(capture.env)).not.toContain(ambientMarker);
		}
	);

	it.each([
		['HTTP_PROXY', 'http://token-only@proxy.corp:8080'],
		['HTTPS_PROXY', 'https://proxy.corp:8443?access_token=secret'],
		['ALL_PROXY', 'socks5://proxy.corp:1080?api_key=secret'],
		['http_proxy', 'http://proxy.corp:8080?token=secret'],
		['https_proxy', 'http://proxy.corp:8080?region=eu'],
		['all_proxy', 'http://proxy.corp:8080#corp']
	])('drops any non-plain proxy URL in %s from both version and model processes', async (name, value) => {
		const harness = await createHarness('success', {
			Path: process.env.Path ?? process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			[name]: value
		});
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		const modelEnv = (await readCapture(harness)).env;
		const versionEnv = JSON.parse(await readFile(`${harness.capturePath}.version.json`, 'utf8')) as Record<
			string,
			string
		>;

		expect(result.status).toBe('succeeded');
		expect(envValue(modelEnv, name)).toBeUndefined();
		expect(envValue(versionEnv, name)).toBeUndefined();
	});

	it('builds the supported non-interactive Claude Code argv with zero provider credential injection', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				options: { effort: 'high', maxBudgetUsd: 5, permissionMode: 'acceptEdits' }
			}),
			harness.io
		);
		const capture = await readCapture(harness);
		expect(capture.argv).toEqual([
			'--safe-mode',
			'--print',
			'--output-format',
			'json',
			'--no-session-persistence',
			'--strict-mcp-config',
			'--permission-mode',
			'acceptEdits',
			'--model',
			'sonnet',
			'--effort',
			'high',
			'--max-budget-usd',
			'5'
		]);
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(resolve(capture.env.CLAUDE_CONFIG_DIR).toLowerCase()).toBe(
			resolve(harness.localSessionHome).toLowerCase()
		);
	});

	it('builds the supported non-interactive Codex argv with zero provider credential injection', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('codex', harness.workspacePath, { options: { sandbox: 'workspace-write' } }),
			harness.io
		);
		const capture = await readCapture(harness);
		expect(capture.argv).toEqual([
			'exec',
			'--json',
			'--ephemeral',
			'--color',
			'never',
			'-c',
			'shell_environment_policy.inherit=none',
			'--sandbox',
			'workspace-write',
			'--model',
			'gpt-5.6-codex',
			'--',
			'-'
		]);
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(resolve(capture.env.CODEX_HOME).toLowerCase()).toBe(resolve(harness.localSessionHome).toLowerCase());
	});

	it('refuses an OpenAI platform key instead of mapping it into the Codex child', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, {
				authentication: {
					kind: 'provider-credential',
					environment: { OPENAI_API_KEY: FAKE_CODEX_CREDENTIAL }
				}
			} as never),
			harness.io
		);

		expect(result.status).toBe('credential-boundary-unavailable');
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it.each(['claude-code', 'codex'] as const)('distinguishes a structured %s model failure', async (provider) => {
		const harness = await createHarness('model-error');
		const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'model-failed', exitCode: 0 });
		expect(result.summary).toContain('model tool failed');
	});

	it('distinguishes a nonzero CLI process exit', async () => {
		const harness = await createHarness('nonzero');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'process-failed', exitCode: 7 });
		expect(result.stderrExcerpt).toContain('CLI process failed');
	});

	it.each(['claude-code', 'codex'] as const)('distinguishes malformed %s machine output', async (provider) => {
		const harness = await createHarness('malformed');
		const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'malformed-output', exitCode: 0 });
	});

	it('terminates and reports output that exceeds the hard byte bound', async () => {
		const harness = await createHarness('oversized');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		expect(result).toMatchObject({
			status: process.platform === 'win32' ? 'output-limit' : 'termination-failed',
			outputTruncated: true
		});
		expect(Buffer.byteLength(result.stdoutExcerpt ?? '', 'utf8')).toBeLessThanOrEqual(
			MODEL_EXECUTION_OUTPUT_LIMIT_BYTES
		);
	});

	it('never fabricates or exposes a provider credential in local-session output or diagnostics', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(request('claude-code', harness.workspacePath), harness.io);
		const serialized = JSON.stringify(result);
		expect(result.status).toBe('succeeded');
		expect(serialized).not.toContain(FAKE_CLAUDE_CREDENTIAL);
		expect(serialized).not.toContain(FAKE_CODEX_CREDENTIAL);
	});

	it('never echoes even a short rejected raw credential', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				authentication: {
					kind: 'provider-credential',
					environment: { CLAUDE_CODE_OAUTH_TOKEN: 'xy' }
				}
			} as never),
			harness.io
		);

		expect(JSON.stringify(result)).not.toContain('credential=xy');
	});

	it('redacts a credential that crosses the terminal excerpt boundary', async () => {
		const harness = await createHarness('secret-excerpt-boundary');
		const result = await executeModelProcess(request('claude-code', harness.workspacePath), harness.io);

		expect(result.status).toBe('process-failed');
		expect(JSON.stringify(result)).not.toContain(FAKE_CLAUDE_CREDENTIAL.slice(-5));
	});

	it('redacts a credential fragment cut by the raw output ceiling', async () => {
		const harness = await createHarness('secret-output-boundary');
		const result = await executeModelProcess(request('claude-code', harness.workspacePath), harness.io);

		expect(result.status).toBe(process.platform === 'win32' ? 'output-limit' : 'termination-failed');
		expect(result.stdoutExcerpt).not.toMatch(new RegExp(`${FAKE_CLAUDE_CREDENTIAL.slice(0, 5)}$`, 'u'));
	});

	it('keeps a rejected raw-credential result inside the shared 8 KiB serialized budget', async () => {
		const harness = await createHarness('all-fields-budget');
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				authentication: {
					kind: 'provider-credential',
					environment: { CLAUDE_CODE_OAUTH_TOKEN: 'ZX' }
				}
			} as never),
			harness.io
		);
		const serialized = JSON.stringify(result);

		expect(result.status).toBe('credential-boundary-unavailable');
		expect(serialized).not.toContain('ZX');
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it('bounds a successful model summary independently of the parser input ceiling', async () => {
		const harness = await createHarness('long-success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);

		expect(result.status).toBe('succeeded');
		expect(Buffer.byteLength(result.summary ?? '', 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it.runIf(process.platform === 'win32')(
		'kills the whole spawned process tree on timeout so no grandchild survives',
		async () => {
			const harness = await createHarness('hang-tree');
			const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
				...harness.io,
				spawnFn: harness.spawnWithTaskkill()
			});
			expect(result.status, result.summary).toBe('timed-out');
			expect((await readCapture(harness)).pid).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			await expect(access(harness.markerPath)).rejects.toThrow();
		},
		10_000
	);

	it('refuses a credentialed POSIX spawn before an escaped grandchild can inherit the credential', async () => {
		const harness = await createHarness('hang-tree');
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			platform: 'linux',
			commands: { codex: { executable: harness.managedExecutablePath } },
			spawnFn: harness.spawnWithTaskkill()
		});

		expect(result.status).toBe('containment-unavailable');
		expect(result.summary).toMatch(/containment.*unavailable/i);
		await expect(access(harness.capturePath)).rejects.toThrow();
		await expect(access(`${harness.capturePath}.version.json`)).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		await expect(access(harness.markerPath)).rejects.toThrow();
	}, 10_000);

	it.runIf(process.platform === 'win32')(
		'fails closed when the containment boundary cannot verify descendant termination',
		async () => {
			const harness = await createHarness('hang-tree');
			const createBaseContainment = createVerifiedTestContainment();
			let containmentIndex = 0;
			try {
				const result = await executeModelProcess(
					request('codex', harness.workspacePath, { timeoutMs: 1_000 }),
					{
						...harness.io,
						platform: 'win32',
						createModelProcessContainment: async (spawnFn) => {
							containmentIndex += 1;
							const containment = await createBaseContainment(spawnFn);
							if (containmentIndex === 1) return containment;
							return {
								...containment,
								close: async () => ({ verified: false, detail: 'Job Object close was not verified' })
							};
						}
					}
				);

				expect(result.status).toBe('termination-failed');
				expect(result.summary).toMatch(/termination.*not.*verified/i);
				expect((await readCapture(harness)).pid).toBeGreaterThan(0);
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				await expect(access(harness.markerPath)).resolves.toBeUndefined();
			} finally {
				await forceKillCapturedTree(harness);
			}
		},
		10_000
	);

	it.runIf(process.platform === 'win32')(
		'does not let a PATH-spoofed taskkill substitute for the missing Job Object launcher',
		async () => {
			const harness = await createHarness('success');
			const spoofBin = join(harness.root, 'spoof-bin');
			await mkdir(spoofBin, { recursive: true });
			await writeFile(join(spoofBin, 'taskkill.exe'), 'workspace-controlled spoof', 'utf8');
			const result = await executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				parentEnv: { ...process.env, PATH: `${spoofBin};${process.env.PATH ?? ''}` },
				createModelProcessContainment: undefined
			});

			expect(result.status).toBe('containment-unavailable');
			await expect(access(harness.capturePath)).rejects.toThrow();
		},
		5_000
	);

	it.runIf(process.platform === 'win32')(
		'bounds a hung containment close and never reports successful cancellation',
		async () => {
			const harness = await createHarness('hang-tree');
			const createBaseContainment = createVerifiedTestContainment();
			let containmentIndex = 0;
			let execution: Promise<Awaited<ReturnType<typeof executeModelProcess>>> | null = null;
			try {
				execution = executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
					...harness.io,
					platform: 'win32',
					createModelProcessContainment: async (spawnFn) => {
						containmentIndex += 1;
						const containment = await createBaseContainment(spawnFn);
						if (containmentIndex === 1) return containment;
						return { ...containment, close: () => new Promise(() => undefined) };
					}
				});

				const outcome = await Promise.race([
					execution.then((result) => ({ kind: 'result' as const, result })),
					new Promise<{ kind: 'deadline' }>((resolve) =>
						setTimeout(() => resolve({ kind: 'deadline' }), 4_000)
					)
				]);

				expect(outcome.kind).toBe('result');
				if (outcome.kind === 'result') expect(outcome.result.status).toBe('termination-failed');
			} finally {
				await forceKillCapturedTree(harness);
				if (execution) {
					await Promise.race([execution, new Promise((resolve) => setTimeout(resolve, 2_000))]);
				}
			}
		},
		10_000
	);

	it.runIf(process.platform === 'win32')(
		'withholds provider credentials and unsafe proxy data from the contained model and close path',
		async () => {
			const harness = await createHarness('hang-tree');
			const createBaseContainment = createVerifiedTestContainment();
			let containmentIndex = 0;
			try {
				const result = await executeModelProcess(
					request('codex', harness.workspacePath, { timeoutMs: 1_000 }),
					{
						...harness.io,
						parentEnv: { ...process.env, HTTP_PROXY: 'http://token-only@proxy.corp:8080' },
						platform: 'win32',
						createModelProcessContainment: async (spawnFn) => {
							containmentIndex += 1;
							const containment = await createBaseContainment(spawnFn);
							if (containmentIndex === 1) return containment;
							return {
								...containment,
								close: async () => ({ verified: false, detail: 'Job Object close failed safely' })
							};
						}
					}
				);

				expect(result.status).toBe('termination-failed');
				const modelEnv = (await readCapture(harness)).env;
				expect(envValue(modelEnv, 'CODEX_ACCESS_TOKEN')).toBeUndefined();
				expect(envValue(modelEnv, 'CODEX_API_KEY')).toBeUndefined();
				expect(envValue(modelEnv, 'HTTP_PROXY')).toBeUndefined();
				expect(JSON.stringify(result)).not.toContain(FAKE_CODEX_CREDENTIAL);
			} finally {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				await forceKillCapturedTree(harness);
			}
		},
		10_000
	);

	it.runIf(process.platform === 'win32')(
		'kills the process tree and reports cancellation when its AbortSignal fires',
		async () => {
			const harness = await createHarness('hang-tree');
			const controller = new AbortController();
			const baseSpawn = harness.spawnWithTaskkill();
			const result = await executeModelProcess(
				request('claude-code', harness.workspacePath, { signal: controller.signal }),
				{
					...harness.io,
					spawnFn: ((...args: Parameters<typeof spawn>) => {
						const child = baseSpawn(...args);
						if (!args[1]?.includes('--version')) setTimeout(() => controller.abort(), 50);
						return child;
					}) as typeof spawn
				}
			);
			expect(result.status, result.summary).toBe('cancelled');
		}
	);

	it('fails closed when cancellation races with spawn and tree termination cannot be verified', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		const baseSpawn = harness.spawnWithTaskkill();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				spawnFn: ((...args: Parameters<typeof spawn>) => {
					controller.abort();
					return baseSpawn(...args);
				}) as typeof spawn
			}
		);

		expect(['cancelled', 'termination-failed']).toContain(result.status);
	});

	it('distinguishes a managed executable spawn failure', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			spawnFn: (() => {
				throw new Error('managed executable could not be spawned');
			}) as typeof spawn
		});
		expect(result).toMatchObject({ status: 'spawn-failed', exitCode: null });
	});

	it('keeps a preparation failure inside the shared serialized terminal budget', async () => {
		const harness = await createHarness('success');
		const commands = Object.defineProperty({}, 'codex', {
			get: () => {
				throw new Error('q'.repeat(MODEL_EXECUTION_EXCERPT_BYTES * 2));
			}
		}) as ModelExecutionIo['commands'];
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			commands
		});

		expect(result.status).toBe('spawn-failed');
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it('retries, bounds, and safely surfaces an isolated run-directory cleanup failure', async () => {
		const harness = await createHarness('success');
		let cleanupPath: string | null = null;
		let cleanupAttempts = 0;
		try {
			const result = await executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				removeRunRoot: async (path) => {
					cleanupPath = path;
					cleanupAttempts += 1;
					throw new Error(`cleanup diagnostic ${FAKE_CODEX_CREDENTIAL}`);
				}
			});
			expect(result).toMatchObject({ status: 'succeeded', cleanupFailed: true });
			expect(result.summary).toMatch(/cleanup failed/i);
			expect(JSON.stringify(result)).not.toContain(FAKE_CODEX_CREDENTIAL);
			expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
				MODEL_EXECUTION_EXCERPT_BYTES
			);
			expect(cleanupAttempts).toBe(3);
		} finally {
			if (cleanupPath) await rm(cleanupPath, { recursive: true, force: true });
		}
	});

	it('does not hang when isolated run-directory cleanup never settles', async () => {
		const harness = await createHarness('success');
		let cleanupPath: string | null = null;
		try {
			const execution = executeModelProcess(request('codex', harness.workspacePath), {
				...harness.io,
				removeRunRoot: (path) => {
					cleanupPath = path;
					return new Promise<void>(() => undefined);
				}
			});
			const outcome = await Promise.race([
				execution.then(
					(result) => ({ kind: 'resolved' as const, result }),
					(error: unknown) => ({ kind: 'rejected' as const, error })
				),
				// The cleanup itself is bounded to 3 x 250 ms, but this race
				// covers the complete real-process execution as well. Keep enough
				// headroom for process startup on loaded/Windows CI runners while
				// still proving that a never-settling cleanup cannot hang forever.
				new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 4_000))
			]);

			expect(outcome.kind).toBe('resolved');
			if (outcome.kind === 'resolved') {
				expect(outcome.result).toMatchObject({ status: 'succeeded', cleanupFailed: true });
			}
		} finally {
			if (cleanupPath) await rm(cleanupPath, { recursive: true, force: true });
		}
	}, 8_000);
});

describe('executeModelProcess — request refusal', () => {
	it('refuses a local session request that also smuggles a raw credential environment', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				{
					...request('codex', harness.workspacePath),
					credentialEnv: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL }
				} as ModelExecutionRequest,
				harness.io
			)
		).rejects.toThrow(/local session.*raw credential|authentication.*exclusive/i);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it.each([
		['claude-code', { dangerouslySkipPermissions: 'false' }],
		['codex', { dangerouslyBypassApprovalsAndSandbox: 'false' }]
	] as const)('refuses a non-boolean dangerous opt-in for %s', async (provider, options) => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request(provider, harness.workspacePath, { options } as Partial<ModelExecutionRequest>),
				harness.io
			)
		).rejects.toThrow(/dangerous.*boolean/i);
	});

	it('refuses both credentials instead of relying on provider precedence', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request('claude-code', harness.workspacePath, {
					authentication: {
						kind: 'provider-credential',
						environment: {
							CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL,
							ANTHROPIC_API_KEY: 'anthropic-api-test-value-123456789'
						}
					}
				} as never),
				harness.io
			)
		).rejects.toBeInstanceOf(ModelExecutionRequestError);
	});

	it('refuses a credential belonging to the other provider', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request('codex', harness.workspacePath, {
					authentication: {
						kind: 'provider-credential',
						environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
					}
				} as never),
				harness.io
			)
		).rejects.toThrow(/credential.*codex/i);
	});

	it('does not spawn when cancellation already happened', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		controller.abort();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			harness.io
		);
		expect(result).toMatchObject({ status: 'cancelled', exitCode: null, durationMs: 0 });
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('does not spawn when cancellation happens during asynchronous workspace validation', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		let spawned = false;
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				directoryExists: async () => {
					controller.abort();
					return true;
				},
				spawnFn: (() => {
					spawned = true;
					throw new Error('process must not be spawned after cancellation');
				}) as never
			}
		);

		expect(result.status).toBe('cancelled');
		expect(spawned).toBe(false);
	});

	it('rechecks cancellation immediately before the credentialed model spawn', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		let spawnCount = 0;
		const baseSpawn = harness.spawnWithTaskkill();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				beforeSpawn: (purpose) => {
					if (purpose === 'model') controller.abort();
				},
				spawnFn: ((...args: Parameters<typeof spawn>) => {
					spawnCount += 1;
					return baseSpawn(...args);
				}) as typeof spawn
			}
		);

		expect(result.status).toBe('cancelled');
		expect(spawnCount).toBe(1);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('rechecks the monotonic deadline immediately before the credentialed model spawn', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let spawnCount = 0;
		const baseSpawn = harness.spawnWithTaskkill();
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			monotonicNow: () => monotonicTime,
			beforeSpawn: (purpose) => {
				if (purpose === 'model') monotonicTime = 1_001;
			},
			spawnFn: ((...args: Parameters<typeof spawn>) => {
				spawnCount += 1;
				return baseSpawn(...args);
			}) as typeof spawn
		});

		expect(result.status).toBe('timed-out');
		expect(spawnCount).toBe(1);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('makes the absolute deadline win when a contained model closes after its budget', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			monotonicNow: () => monotonicTime,
			createModelProcessContainment: async (spawnFn) => {
				const containment = await baseCreateContainment(spawnFn);
				return {
					...containment,
					spawn: (async (...args: Parameters<TestContainment['spawn']>) => {
						const child = await containment.spawn(...args);
						child.once('close', () => {
							monotonicTime = 1_001;
						});
						return child;
					}) as TestContainment['spawn']
				};
			}
		});

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
	});

	it('makes the absolute deadline win when containment close consumes the remaining budget', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			monotonicNow: () => monotonicTime,
			createModelProcessContainment: async (spawnFn) => {
				const containment = await baseCreateContainment(spawnFn);
				return {
					...containment,
					close: async () => {
						const outcome = await containment.close();
						monotonicTime = 1_001;
						return outcome;
					}
				};
			}
		});

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
	});

	it('closes containment acquired exactly as the absolute budget expires before model spawn', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let closeCalls = 0;
		let modelSpawned = false;
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			monotonicNow: () => monotonicTime,
			spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
			createModelProcessContainment: async () => {
				monotonicTime = 1_001;
				return {
					spawn: (() => {
						modelSpawned = true;
						throw new Error('model must not spawn after the deadline');
					}) as typeof spawn,
					close: async () => {
						closeCalls += 1;
						return { verified: true };
					}
				};
			}
		});

		expect(result.status).toBe('timed-out');
		expect(closeCalls).toBe(1);
		expect(modelSpawned).toBe(false);
	});

	it('closes containment that resolves after cancellation already won acquisition', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		let resolveCreation!: (containment: TestContainment) => void;
		let markCreationStarted!: () => void;
		let markClosed!: () => void;
		const creationStarted = new Promise<void>((resolvePromise) => {
			markCreationStarted = resolvePromise;
		});
		const closed = new Promise<void>((resolvePromise) => {
			markClosed = resolvePromise;
		});
		const execution = executeModelProcess(request('codex', harness.workspacePath, { signal: controller.signal }), {
			...harness.io,
			spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
			createModelProcessContainment: () =>
				new Promise<TestContainment>((resolvePromise) => {
					resolveCreation = resolvePromise;
					markCreationStarted();
				})
		});

		await creationStarted;
		controller.abort();
		const result = await execution;
		expect(result.status).toBe('cancelled');

		resolveCreation({
			spawn: (() => {
				throw new Error('late containment must never spawn a model');
			}) as typeof spawn,
			close: async () => {
				markClosed();
				return { verified: true };
			}
		});
		const cleanupSettled = await Promise.race([
			closed.then(() => true),
			new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 250))
		]);
		expect(cleanupSettled).toBe(true);
	});

	it('closes containment that resolves after the acquisition deadline already won', async () => {
		const harness = await createHarness('success');
		let resolveCreation!: (containment: TestContainment) => void;
		let markCreationStarted!: () => void;
		let markClosed!: () => void;
		const creationStarted = new Promise<void>((resolvePromise) => {
			markCreationStarted = resolvePromise;
		});
		const closed = new Promise<void>((resolvePromise) => {
			markClosed = resolvePromise;
		});
		const execution = executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 500 }), {
			...harness.io,
			spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
			createModelProcessContainment: () =>
				new Promise<TestContainment>((resolvePromise) => {
					resolveCreation = resolvePromise;
					markCreationStarted();
				})
		});

		await creationStarted;
		const result = await execution;
		expect(result.status).toBe('timed-out');

		resolveCreation({
			spawn: (() => {
				throw new Error('late containment must never spawn a model');
			}) as typeof spawn,
			close: async () => {
				markClosed();
				return { verified: true };
			}
		});
		const cleanupSettled = await Promise.race([
			closed.then(() => true),
			new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 250))
		]);
		expect(cleanupSettled).toBe(true);
	});

	it.each(['rejects', 'never settles'] as const)(
		'fails closed and stays bounded when an acquired but unused containment close %s',
		async (closeMode) => {
			const harness = await createHarness('success');
			let monotonicTime = 0;
			let closeCalls = 0;
			const close: TestContainment['close'] =
				closeMode === 'rejects'
					? async () => {
							closeCalls += 1;
							throw new Error('unused containment close rejected');
						}
					: () => {
							closeCalls += 1;
							return new Promise(() => undefined);
						};
			const execution = executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
				...harness.io,
				monotonicNow: () => monotonicTime,
				spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
				createModelProcessContainment: async () => {
					monotonicTime = 1_001;
					return {
						spawn: (() => {
							throw new Error('model must not spawn after the deadline');
						}) as typeof spawn,
						close
					};
				}
			});
			const outcome = await Promise.race([
				execution.then((result) => ({ kind: 'result' as const, result })),
				new Promise<{ kind: 'hung' }>((resolvePromise) =>
					setTimeout(() => resolvePromise({ kind: 'hung' }), 3_500)
				)
			]);

			expect(outcome.kind).toBe('result');
			if (outcome.kind === 'result') expect(outcome.result.status).toBe('termination-failed');
			expect(closeCalls).toBe(1);
		},
		6_000
	);

	it('makes cancellation win when the trusted async launcher rejects after observing abort', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		let containmentCount = 0;
		let markModelSpawnStarted!: () => void;
		const modelSpawnStarted = new Promise<void>((resolvePromise) => {
			markModelSpawnStarted = resolvePromise;
		});
		const execution = executeModelProcess(request('codex', harness.workspacePath, { signal: controller.signal }), {
			...harness.io,
			createModelProcessContainment: async (spawnFn) => {
				const containment = await baseCreateContainment(spawnFn);
				containmentCount += 1;
				if (containmentCount === 1) return containment;
				return {
					...containment,
					spawn: async () => {
						markModelSpawnStarted();
						await new Promise<void>((resolvePromise) =>
							controller.signal.addEventListener('abort', () => resolvePromise(), { once: true })
						);
						throw new Error('trusted broker stopped after cancellation');
					}
				};
			}
		});

		await modelSpawnStarted;
		controller.abort();
		const result = await execution;

		expect(result.status).toBe('cancelled');
	});

	it('makes the absolute deadline win when the trusted async launcher rejects after the budget', async () => {
		const harness = await createHarness('success');
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		let containmentCount = 0;
		let monotonicTime = 0;
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			monotonicNow: () => monotonicTime,
			createModelProcessContainment: async (spawnFn) => {
				const containment = await baseCreateContainment(spawnFn);
				containmentCount += 1;
				if (containmentCount === 1) return containment;
				return {
					...containment,
					spawn: async () => {
						monotonicTime = 1_001;
						throw new Error('trusted broker stopped after deadline');
					}
				};
			}
		});

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
	});

	it('bounds a never-resolving workspace validation inside the one execution deadline', async () => {
		const harness = await createHarness('success');
		let spawned = false;
		const execution = executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 100 }), {
			...harness.io,
			directoryExists: () => new Promise<boolean>(() => undefined),
			spawnFn: (() => {
				spawned = true;
				throw new Error('process must not spawn after the deadline');
			}) as never
		});
		const outcome = await Promise.race([
			execution.then((result) => ({ kind: 'result' as const, result })),
			new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 750))
		]);

		expect(outcome.kind).toBe('result');
		if (outcome.kind === 'result') expect(outcome.result.status).toBe('timed-out');
		expect(spawned).toBe(false);
	});
});
