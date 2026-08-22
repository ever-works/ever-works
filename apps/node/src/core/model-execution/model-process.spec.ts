import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
	MODEL_EXECUTION_EXCERPT_BYTES,
	MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
	ModelExecutionRequestError,
	executeModelProcess,
	type ModelExecutionIo,
	type ModelExecutionProvider,
	type ModelExecutionRequest
} from './model-process';

const FAKE_CLAUDE_CREDENTIAL = 'claude-oauth-test-value-123456789';
const FAKE_CODEX_CREDENTIAL = 'codex-access-test-value-123456789';
const PINNED_CLI_FIXTURE = join(__dirname, '__fixtures__', 'pinned-cli.cjs');

const STUB_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [capturePath, mode, markerPath, provider, ...providerArgs] = process.argv.slice(2);
if (providerArgs.length === 1 && providerArgs[0] === '--version') {
  process.stdout.write(provider === 'codex' ? 'codex-cli 0.146.0\n' : '2.1.76 (Claude Code)\n');
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
	  profileDirectoriesExist: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME']
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
    process.stdout.write('a'.repeat(${MODEL_EXECUTION_OUTPUT_LIMIT_BYTES - 5}) + credential + 'tail');
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
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(markerPath) + ', "orphaned"), 1800)'], {
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
	io: ModelExecutionIo;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness(mode: string, parentEnv: NodeJS.ProcessEnv = process.env): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'ever works model process '));
	roots.push(root);
	const workspacePath = join(root, 'task workspace with spaces');
	const stubPath = join(root, 'stub cli with spaces.cjs');
	const capturePath = join(root, 'capture.json');
	const markerPath = join(root, 'orphan-marker.txt');
	await mkdir(workspacePath, { recursive: true });
	await writeFile(stubPath, STUB_SOURCE, 'utf8');

	return {
		root,
		workspacePath,
		capturePath,
		markerPath,
		io: {
			commands: {
				'claude-code': {
					executable: process.execPath,
					prefixArgs: [stubPath, capturePath, mode, markerPath, 'claude-code']
				},
				codex: {
					executable: process.execPath,
					prefixArgs: [stubPath, capturePath, mode, markerPath, 'codex']
				}
			},
			parentEnv
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
		credentialEnv:
			provider === 'claude-code'
				? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
				: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL },
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

function modelBoundarySpawn(taskkill?: (...args: Parameters<typeof spawn>) => ChildProcess): typeof spawn {
	return ((...args: Parameters<typeof spawn>) => {
		const commandArgs = args[1];
		if (Array.isArray(commandArgs) && commandArgs.at(-1) === '--version') {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const stdin = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdout,
				stderr,
				stdin,
				kill: () => true
			}) as unknown as ChildProcess;
			queueMicrotask(() => {
				stdout.end(commandArgs.includes('claude-code') ? '2.1.76 (Claude Code)\n' : 'codex-cli 0.146.0\n');
				stderr.end();
				child.emit('close', 0, null);
			});
			return child;
		}
		if (args[0] === 'taskkill.exe' && taskkill) return taskkill(...args);
		return spawn(...args);
	}) as typeof spawn;
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
		'runs the %s no-model contract accepted by the repository-pinned CLI fixture',
		async (provider) => {
			const harness = await createHarness('success');
			const credentialEnv: Record<string, string> =
				provider === 'claude-code'
					? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
					: { OPENAI_API_KEY: FAKE_CODEX_CREDENTIAL };
			const result = await executeModelProcess(request(provider, harness.workspacePath, { credentialEnv }), {
				...harness.io,
				commands: {
					[provider]: {
						executable: process.execPath,
						prefixArgs: [PINNED_CLI_FIXTURE, provider, harness.capturePath]
					}
				}
			});

			expect(result).toMatchObject({ status: 'succeeded', summary: 'fixture done' });
		}
	);

	it('reports the pinned Codex access-token contract as incompatible before a model run', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			commands: {
				codex: {
					executable: process.execPath,
					prefixArgs: [PINNED_CLI_FIXTURE, 'codex', harness.capturePath]
				}
			}
		});

		expect(result.status).toBe('incompatible-cli');
		expect(result.summary).toMatch(/0\.120\.0.*CODEX_ACCESS_TOKEN/i);
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
			expect(capture.cwd).toBe(harness.workspacePath);
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
				XDG_CACHE_HOME: `C:\\${ambientMarker}\\cache`
			});

			const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
			const capture = await readCapture(harness);
			const configHome = provider === 'claude-code' ? capture.env.CLAUDE_CONFIG_DIR : capture.env.CODEX_HOME;
			const runRoot = dirname(configHome);
			const isolatedHome = envValue(capture.env, 'HOME');

			expect(result.status).toBe('succeeded');
			expect(isolatedHome).toBeTruthy();
			expect(envValue(capture.env, 'USERPROFILE')).toBe(isolatedHome);
			expect(isWithin(runRoot, isolatedHome!)).toBe(true);
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

	it('builds the supported non-interactive Claude Code argv and grants only its selected credential', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				options: { effort: 'high', maxBudgetUsd: 5, permissionMode: 'acceptEdits' }
			}),
			harness.io
		);
		const capture = await readCapture(harness);
		expect(capture.argv).toEqual([
			'--print',
			'--output-format',
			'json',
			'--no-session-persistence',
			'--setting-sources',
			'project',
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
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_CLAUDE_CREDENTIAL);
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CLAUDE_CONFIG_DIR).toBeTruthy();
	});

	it('builds the supported non-interactive Codex argv and grants only its selected credential', async () => {
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
			'--sandbox',
			'workspace-write',
			'--model',
			'gpt-5.6-codex',
			'--',
			'-'
		]);
		expect(capture.env.CODEX_ACCESS_TOKEN).toBe(FAKE_CODEX_CREDENTIAL);
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_HOME).toBeTruthy();
	});

	it('maps a selected OpenAI platform key to the Codex exec-only credential name', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('codex', harness.workspacePath, {
				credentialEnv: { OPENAI_API_KEY: FAKE_CODEX_CREDENTIAL }
			}),
			harness.io
		);
		const capture = await readCapture(harness);

		expect(capture.env.CODEX_API_KEY).toBe(FAKE_CODEX_CREDENTIAL);
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
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
		expect(result).toMatchObject({ status: 'output-limit', outputTruncated: true });
		expect(Buffer.byteLength(result.stdoutExcerpt ?? '', 'utf8')).toBeLessThanOrEqual(
			MODEL_EXECUTION_OUTPUT_LIMIT_BYTES
		);
	});

	it('redacts the selected credential from parsed output and diagnostics', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(request('claude-code', harness.workspacePath), harness.io);
		const serialized = JSON.stringify(result);
		expect(result.status).toBe('succeeded');
		expect(serialized).not.toContain(FAKE_CLAUDE_CREDENTIAL);
		expect(serialized).toContain('[redacted]');
	});

	it('never exempts a short selected credential from diagnostic redaction', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'xy' }
			}),
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

		expect(result.status).toBe('output-limit');
		expect(result.stdoutExcerpt).not.toMatch(new RegExp(`${FAKE_CLAUDE_CREDENTIAL.slice(0, 5)}$`, 'u'));
	});

	it('shares one post-redaction 8 KiB serialized budget across every terminal text field', async () => {
		const harness = await createHarness('all-fields-budget');
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'ZX' }
			}),
			harness.io
		);
		const serialized = JSON.stringify(result);

		expect(result.status).toBe('succeeded');
		expect(serialized).not.toContain('ZX');
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it('bounds a successful model summary independently of the parser input ceiling', async () => {
		const harness = await createHarness('long-success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);

		expect(result.status).toBe('succeeded');
		expect(Buffer.byteLength(result.summary ?? '', 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it('kills the whole spawned process tree on timeout so no grandchild survives', async () => {
		const harness = await createHarness('hang-tree');
		const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
			...harness.io,
			spawnFn: modelBoundarySpawn()
		});
		expect(result.status, result.summary).toBe('timed-out');
		expect((await readCapture(harness)).pid).toBeGreaterThan(0);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		await expect(access(harness.markerPath)).rejects.toThrow();
	}, 10_000);

	it('fails closed when Windows taskkill exits nonzero and a descendant survives', async () => {
		const harness = await createHarness('hang-tree');
		try {
			const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
				...harness.io,
				platform: 'win32',
				spawnFn: modelBoundarySpawn(() =>
					spawn(process.execPath, ['-e', 'process.exit(5)'], {
						stdio: 'ignore',
						shell: false,
						windowsHide: true
					})
				)
			});

			expect(result.status).toBe('termination-failed');
			expect(result.summary).toMatch(/process tree.*not.*verified/i);
			expect((await readCapture(harness)).pid).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			await expect(access(harness.markerPath)).resolves.toBeUndefined();
		} finally {
			await forceKillCapturedTree(harness);
		}
	}, 10_000);

	it('bounds a hung Windows taskkill and never reports successful cancellation', async () => {
		const harness = await createHarness('hang-tree');
		const fakeKiller = new EventEmitter() as ChildProcess;
		fakeKiller.kill = () => true;
		let execution: Promise<Awaited<ReturnType<typeof executeModelProcess>>> | null = null;
		try {
			execution = executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
				...harness.io,
				platform: 'win32',
				spawnFn: modelBoundarySpawn(() => fakeKiller)
			});

			const outcome = await Promise.race([
				execution.then((result) => ({ kind: 'result' as const, result })),
				new Promise<{ kind: 'deadline' }>((resolve) => setTimeout(() => resolve({ kind: 'deadline' }), 4_000))
			]);

			expect(outcome.kind).toBe('result');
			if (outcome.kind === 'result') expect(outcome.result.status).toBe('termination-failed');
		} finally {
			await forceKillCapturedTree(harness);
			if (execution) {
				await Promise.race([execution, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			}
		}
	}, 10_000);

	it('withholds credentials from taskkill and redacts a tree-killer failure', async () => {
		const harness = await createHarness('hang-tree');
		let killerEnv: NodeJS.ProcessEnv | undefined;
		try {
			const result = await executeModelProcess(request('codex', harness.workspacePath, { timeoutMs: 1_000 }), {
				...harness.io,
				platform: 'win32',
				spawnFn: modelBoundarySpawn((...args) => {
					killerEnv = (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
					throw new Error(`killer diagnostic ${FAKE_CODEX_CREDENTIAL}`);
				})
			});

			expect(result.status).toBe('termination-failed');
			expect(envValue(killerEnv as Record<string, string>, 'CODEX_ACCESS_TOKEN')).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(FAKE_CODEX_CREDENTIAL);
		} finally {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			await forceKillCapturedTree(harness);
		}
	}, 10_000);

	it('kills the process tree and reports cancellation when its AbortSignal fires', async () => {
		const harness = await createHarness('hang-tree');
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, { signal: controller.signal }),
			{ ...harness.io, spawnFn: modelBoundarySpawn() }
		);
		expect(result.status).toBe('cancelled');
	});

	it('fails closed when cancellation races with spawn and tree termination cannot be verified', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				spawnFn: ((...args: Parameters<typeof spawn>) => {
					controller.abort();
					return spawn(...args);
				}) as typeof spawn
			}
		);

		expect(result.status).toBe('termination-failed');
	});

	it('distinguishes an executable spawn failure', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			commands: { codex: { executable: join(harness.root, 'missing cli.exe') } }
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
});

describe('executeModelProcess — request refusal', () => {
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
					credentialEnv: {
						CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL,
						ANTHROPIC_API_KEY: 'anthropic-api-test-value-123456789'
					}
				}),
				harness.io
			)
		).rejects.toBeInstanceOf(ModelExecutionRequestError);
	});

	it('refuses a credential belonging to the other provider', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request('codex', harness.workspacePath, {
					credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
				}),
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
});
