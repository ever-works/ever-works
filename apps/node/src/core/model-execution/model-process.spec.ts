import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
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
import {
	ModelProcessContainmentUnavailableError,
	TERMINATION_SETTLE_MS,
	executeModelProcessInternal
} from './model-process.internal';

const executeModelProcess = executeModelProcessInternal;
type ModelExecutionIo = NonNullable<Parameters<typeof executeModelProcessInternal>[1]>;
type TestContainment = Awaited<ReturnType<NonNullable<ModelExecutionIo['createModelProcessContainment']>>>;

const FAKE_CLAUDE_CREDENTIAL = 'claude-oauth-test-value-123456789';
const FAKE_CODEX_CREDENTIAL = 'codex-access-test-value-123456789';
const PINNED_CLI_FIXTURE = join(__dirname, '__fixtures__', 'pinned-cli.cjs');
/**
 * Shortened termination-safety deadline injected wherever a test asserts
 * hung-vs-result for a containment close that never settles. The production
 * 2.5 s bound stays covered by the version-probe closure test, which only
 * awaits the result; a hung-vs-result race must control the bound instead of
 * racing the real scheduler and disk against it with a sub-second margin.
 */
const TEST_TERMINATION_SETTLE_MS = 100;
/**
 * Hang detector for a shortened settle. This is still a wall-clock race: the
 * detector starts before the trusted-command realpath calls, the run-root
 * mkdtemp and its eight mkdir calls, and the real settle setTimeout, so the
 * in-race margin (detector minus settle, ~7.9 s) must dwarf the ~3.8 s of
 * non-settle overhead a 33-shard E2E storm produced on CI. Tests that use it
 * must also seam out `directoryExists` and `removeRunRoot` so the stat and the
 * up-to-750 ms bounded run-root removal never sit inside the race.
 */
const HUNG_CLOSE_DETECTION_MS = 8_000;
/** Per-test budget for a hung-close race: the detector plus room for harness setup and teardown. */
const HUNG_CLOSE_TEST_BUDGET_MS = HUNG_CLOSE_DETECTION_MS + 4_000;
/**
 * Wall-clock budget for a real two-subprocess success path (version probe +
 * model) on a saturated CI runner. Applied to the request deadline so a
 * starved runner reports the executor's own `timed-out` diagnosis, and the
 * vitest budget stays above it so that diagnosis is what the failure shows.
 */
const REAL_PROCESS_RUN_BUDGET_MS = 15_000;
/**
 * Real process-timer window left for the version probe once the injected clock
 * has been advanced to just inside the deadline. Every per-process timer is a
 * real `setTimeout` no matter what `monotonicNow` returns, so a probe overrun
 * can only be provoked with real milliseconds; a stub child that never closes
 * makes that timer the sole way the run can end, so load may delay the verdict
 * but can never hand it to a competing outcome.
 */
const PROBE_OVERRUN_TIMER_MS = 50;

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
		// Every real-process test that does not override this runs two real
		// Node subprocesses against it; the old 5 s default turned any 5 s
		// runner stall into a `timed-out` result under a green-looking test.
		timeoutMs: REAL_PROCESS_RUN_BUDGET_MS
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

/**
 * A stub child that closes cleanly, driving every deadline-precedence test.
 *
 * It deliberately declares NO `exitCode`/`signalCode`. A child that has already
 * exited reports a non-null `exitCode`, so `createVerifiedTestContainment`
 * short-circuits on its first line and resolves `{ verified: true }` without
 * ever reaching taskkill — that, not the length of the 2.5 s production settle
 * window, is what keeps the precedence tests off `boundedProcessTreeTermination`'s
 * real timer and makes them load-independent. Giving this stub `exitCode: null`
 * (as `hangingProcess` does, for the opposite reason) is not a cosmetic
 * "realism" fix: it sends all four precedence tests straight back to the CI
 * signature this file was repaired for — verified by mutation, 4 failed with
 * `expected 'termination-failed' to be 'timed-out'`. The invariant is pinned
 * executably by 'keeps the deadline-precedence stubs on the sides of the
 * containment short-circuit they depend on'.
 */
function closedProcess(stdoutText: string): ChildProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin: new PassThrough(),
		// No exitCode/signalCode here on purpose — see the note above before adding them.
		kill: () => true
	}) as unknown as ChildProcess;
	// Close on a later macrotask, not a microtask: `runProcess` awaits the
	// (synchronous) containment spawn before it attaches its listeners, and a
	// microtask queued inside the spawn call would emit 'close' into nobody.
	// A real child also closes only after its stdio has ended.
	setImmediate(() => {
		stdout.end(stdoutText);
		stderr.end();
		setImmediate(() => child.emit('close', 0, null));
	});
	return child;
}

/**
 * A stub child that never closes, so the only way out of `runProcess` is its
 * per-process timer. It reports itself alive (`exitCode`/`signalCode` null) the
 * way a real hung child does, which is what makes the termination path — not a
 * lucky exit — the thing under test. That pair is exactly what `closedProcess`
 * must never grow: the two stubs sit on opposite sides of the
 * `createVerifiedTestContainment` short-circuit deliberately, so consolidating
 * them re-arms the deadline-precedence flake.
 */
function hangingProcess(): ChildProcess {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		exitCode: null,
		signalCode: null,
		kill: () => true
	}) as unknown as ChildProcess;
}

function envValue(env: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
	return key ? env[key] : undefined;
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

// Residual wall-clock sensitivity (documented, deliberately NOT loosened):
// the real-taskkill tests — three it.runIf(win32) ones plus two plain tests
// whose expected status is platform-conditional — keep a REAL taskkill inside
// the 2.5 s production settle: 'closes version-probe
// containment on output limit/timeout/AbortSignal', 'kills the whole spawned
// process tree on timeout', 'fails closed when the containment boundary
// cannot verify descendant termination', 'terminates and reports output
// that exceeds the hard byte bound' and 'redacts a credential fragment cut
// by the raw output ceiling' — can still flip to termination-failed when a
// taskkill spawn stalls > 2.5 s. They run on CI via
// .github/workflows/windows-job-launcher.yml (windows-2022) and all passed in
// isolation; the real kill path IS their subject, so stubbing it would remove
// what they prove. Everything else in this describe now runs against the
// REAL_PROCESS_RUN_BUDGET_MS request budget and the 30 s vitest budget.
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
		// The never-settling branch deliberately consumes the 2.5 s production
		// termination-safety deadline on top of a real version-probe subprocess
		// and temp-directory cleanup, so it gets the real-process budget plus
		// headroom rather than a 10 s figure a 5 s runner stall could exhaust.
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
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

			const result = await executeModelProcess(
				request(provider, harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
				harness.io
			);

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
		},
		// Two real Node subprocesses plus temp-directory work: pure runner
		// starvation (a 33-shard E2E storm stalled this at >9 s) is the only
		// thing that can slow it, so the budget is derived from that mechanism.
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
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
	])(
		'drops any non-plain proxy URL in %s from both version and model processes',
		async (name, value) => {
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
		},
		// Two real subprocesses on the real-process request budget: the vitest
		// budget stays above it so a starved runner shows `timed-out`, not an
		// opaque vitest timeout.
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
	);

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
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
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
					// Wall-clock race: the 1 s model budget, the settle timer, and
					// the real run-root removal (up to 3 x 250 ms, kept real so the
					// isolated run root never leaks) all sit inside the detector
					// below, so the test owns the settle bound and the detector
					// keeps a multi-second margin over that mechanism.
					terminationSettleMs: TEST_TERMINATION_SETTLE_MS,
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
						setTimeout(() => resolve({ kind: 'deadline' }), HUNG_CLOSE_DETECTION_MS)
					)
				]);

				expect(outcome.kind).toBe('result');
				if (outcome.kind === 'result') {
					expect(outcome.result.status).toBe('termination-failed');
					expect(outcome.result.summary).toMatch(/did not settle before its safety deadline/);
				}
			} finally {
				await forceKillCapturedTree(harness);
				if (execution) {
					await Promise.race([execution, new Promise((resolve) => setTimeout(resolve, 2_000))]);
				}
			}
		},
		HUNG_CLOSE_TEST_BUDGET_MS
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
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
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

	it(
		'does not hang when isolated run-directory cleanup never settles',
		async () => {
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
					// covers the complete real two-subprocess execution as well, so
					// the detector sits above the real-process request budget (plus
					// the bounded cleanup): a starved runner surfaces the executor
					// 'timed-out' diagnosis, while an unbounded cleanup still trips
					// the detector.
					new Promise<{ kind: 'hung' }>((resolve) =>
						setTimeout(() => resolve({ kind: 'hung' }), REAL_PROCESS_RUN_BUDGET_MS + 2_000)
					)
				]);

				expect(outcome.kind).toBe('resolved');
				if (outcome.kind === 'resolved') {
					expect(outcome.result).toMatchObject({ status: 'succeeded', cleanupFailed: true });
				}
			} finally {
				if (cleanupPath) await rm(cleanupPath, { recursive: true, force: true });
			}
		},
		REAL_PROCESS_RUN_BUDGET_MS + 5_000
	);
});

// Every deadline- and cancellation-precedence test below asserts WHICH terminal
// status wins, so none of them may let a real subprocess race a real timer for
// that answer. The injected `monotonicNow` supplies only the numbers; each
// per-process timer is still a real `setTimeout`
// (model-process.internal.ts:1311), so a 1 s request budget armed a REAL 1 s
// window around the version-probe subprocess. A saturated 33-shard runner needs
// about that long just to boot and exit a bare Node process, so the probe was
// killed, its containment close could not prove the tree dead, and
// `resolveCliVersionProbe` (internal.ts:1039) short-circuited the whole run into
// `toTerminalResult`, where `terminationFailure` (internal.ts:1553) outranks
// `termination` (internal.ts:1563). That reddened #2297, #2303, #2304 and #2305
// on 2026-09-03, always as `expected 'termination-failed' to be 'timed-out'`.
// The precedence is correct — an agent whose credential-bearing tree cannot be
// proven dead must not be reported as a routine, retryable timeout — and it is
// not what these tests are for, so the precedence tests now drive closed stubs
// (`closedProcess`) on the real-process request budget and the fake clock is the
// only thing that moves a deadline.
//
// No coverage moved. The probe-overrun precedence those tests were accidentally
// racing is now pinned on both sides, deterministically, by 'a proven /
// unprovable kill ... when the version probe overruns its budget' below: its
// stub child never closes, so the process timer is the only possible outcome and
// load can only make the verdict later, never different. The
// `termination-failed` status itself stays pinned by 'fails closed and stays
// bounded when an acquired but unused containment close rejects / never
// settles', the 2.5 s production bound by the `terminationSettleMs` clamp table,
// and the real taskkill by the tests named above the 'real process boundary'
// describe, where the real kill IS the subject — but on windows-2022 only.
// The `lint-and-test` ubuntu job that went red here has never run a real
// process-tree kill: the it.runIf(win32) tests skip outright, and the two plain
// ones return at `!process.env.SystemRoot` in `createVerifiedTestContainment`
// before taskkill.exe is spawned (which is why their expected status is
// platform-conditional). So on ubuntu the precedence coverage is the
// deterministic pair below — previously ubuntu had it only by accident, through
// the flake itself. Anyone tempted to stub more of the win32 describe should
// weigh that against .github/workflows/windows-job-launcher.yml, which is the
// only job where the real kill actually runs.
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

	// Executable guard for the one unstated fact the four precedence tests below
	// rest on. Their determinism is not a margin, it is a branch: `closedProcess`
	// reports an exited child, so the containment close returns verified without
	// touching taskkill or the 2.5 s settle timer, while `hangingProcess` reports
	// a live one and cannot be verified. Adding `exitCode: null` to
	// `closedProcess` reproduces the original CI failure on all four
	// (`expected 'termination-failed' to be 'timed-out'`), so the invariant is
	// asserted here rather than left to a comment a refactor can out-run.
	it('keeps the deadline-precedence stubs on the sides of the containment short-circuit they depend on', async () => {
		const createContainment = createVerifiedTestContainment();
		const exited = await createContainment((() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn);
		await exited.spawn('node', [], {});
		const alive = await createContainment((() => hangingProcess()) as typeof spawn);
		await alive.spawn('node', [], {});
		const neverSpawned = await createContainment((() => closedProcess('')) as typeof spawn);

		await expect(exited.close()).resolves.toEqual({ verified: true });
		await expect(neverSpawned.close()).resolves.toEqual({ verified: true });
		// Never a real taskkill: the stub carries no pid, so this is the same
		// verdict on ubuntu and windows-2022.
		await expect(alive.close()).resolves.toMatchObject({ verified: false });
	});

	it('rechecks the monotonic deadline immediately before the credentialed model spawn', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let spawnCount = 0;
		const spawnPurposes: string[] = [];
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
			{
				...harness.io,
				monotonicNow: () => monotonicTime,
				beforeSpawn: (purpose) => {
					spawnPurposes.push(purpose);
					if (purpose === 'model') monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
				},
				// The recheck under test is reached only after a clean probe, so
				// the probe is a stub that closes without a subprocess and the
				// request budget is the real-process one: a 1 s budget armed a
				// real 1 s timer around a real probe child and the resulting
				// unprovable kill reported termination-failed instead.
				spawnFn: (() => {
					spawnCount += 1;
					return closedProcess('codex-cli 0.146.0\n');
				}) as typeof spawn
			}
		);

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
		expect(spawnCount).toBe(1);
		// Without this the run could satisfy both assertions above by dying at
		// the version probe and never reaching the recheck this test names.
		expect(spawnPurposes).toEqual(['version-probe', 'model']);
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('makes the absolute deadline win when a contained model closes after its budget', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let containmentCount = 0;
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
			{
				...harness.io,
				monotonicNow: () => monotonicTime,
				// The close event is what this test is about, and a stub emits the
				// same one through the same handler without putting two real
				// subprocesses under two real sub-second timers: with a 1 s budget
				// either child could overrun, and the unprovable kill that followed
				// reported termination-failed instead of the deadline.
				spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
				createModelProcessContainment: async (spawnFn) => {
					const containment = await baseCreateContainment(spawnFn);
					containmentCount += 1;
					// The first containment owns the version probe. Advance the fake
					// deadline only for the credentialed model process this test names;
					// attaching to both made the outcome depend on probe close ordering.
					if (containmentCount === 1) return containment;
					return {
						...containment,
						spawn: (async (...args: Parameters<TestContainment['spawn']>) => {
							const child = await containment.spawn(...args);
							child.once('close', () => {
								monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
							});
							return child;
						}) as TestContainment['spawn']
					};
				}
			}
		);

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
		expect(containmentCount).toBe(2);
	});

	it('makes the absolute deadline win when containment close consumes the remaining budget', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		const spawnPurposes: string[] = [];
		const baseCreateContainment = harness.io.createModelProcessContainment!;
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
			{
				...harness.io,
				monotonicNow: () => monotonicTime,
				beforeSpawn: (purpose) => spawnPurposes.push(purpose),
				// The clock under test is the injected monotonic one, but the
				// version probe's own timer and the pre-spawn deadline timers are
				// real. A real probe subprocess inside a real 1 s budget flipped
				// this to termination-failed under CPU load (2 of 7 runs): the
				// probe timer fired first and its taskkill then overran the
				// settle bound. So the probe is a stub that closes without a
				// subprocess, and the request budget is the real-process one so
				// the remaining real timers around trusted-command and run-root
				// preparation are not sub-second either.
				spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
				createModelProcessContainment: async (spawnFn) => {
					const containment = await baseCreateContainment(spawnFn);
					return {
						...containment,
						close: async () => {
							const outcome = await containment.close();
							monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
							return outcome;
						}
					};
				}
			}
		);

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
		// The probe closed normally (exit 0) and only the close moved the clock
		// past the deadline; a probe that timed out on its own real timer would
		// carry a null exit code, and the model must never have been spawned.
		expect(result.exitCode).toBe(0);
		expect(spawnPurposes).toEqual(['version-probe']);
	});

	it.each([
		['a proven kill still reports the deadline', { verified: true }, 'timed-out', /exceeded its wall-clock limit/],
		[
			'an unprovable kill outranks the deadline',
			{ verified: false, detail: 'test taskkill exited with code 128' },
			'termination-failed',
			/termination was not verified: test taskkill exited with code 128/
		]
	] as const)('%s when the version probe overruns its budget', async (_shape, closeOutcome, status, summary) => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let closeCalls = 0;
		const spawnPurposes: string[] = [];
		let deferredRunRoot: string | undefined;
		try {
			const result = await executeModelProcess(
				request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
				{
					...harness.io,
					monotonicNow: () => monotonicTime,
					directoryExists: async () => true,
					removeRunRoot: async (path) => {
						deferredRunRoot = path;
					},
					// Filesystem preparation keeps the full real-process budget —
					// every preparation step is wrapped in a real deadline timer, so
					// a small request budget would starve the setup rather than the
					// probe. Only once the probe is about to spawn does the injected
					// clock leave PROBE_OVERRUN_TIMER_MS, which is exactly what
					// `runProcess` arms its real per-process timer with.
					beforeSpawn: (purpose) => {
						spawnPurposes.push(purpose);
						if (purpose === 'version-probe') {
							monotonicTime = REAL_PROCESS_RUN_BUDGET_MS - PROBE_OVERRUN_TIMER_MS;
						}
					},
					spawnFn: (() => hangingProcess()) as typeof spawn,
					createModelProcessContainment: async (spawnFn) => ({
						spawn: (executable, arguments_, options) => spawnFn(executable, [...arguments_], options),
						close: async () => {
							closeCalls += 1;
							return closeOutcome;
						}
					})
				}
			);

			expect(result.status).toBe(status);
			expect(result.summary).toMatch(summary);
			// This is the pair the flaky deadline tests used to decide by accident:
			// the overrun must actually request the process-tree kill, and only an
			// unprovable kill may displace the deadline the run asked for.
			expect(closeCalls).toBe(1);
			expect(result.exitCode).toBeNull();
			// A probe that had to be killed never reaches the credentialed model.
			expect(spawnPurposes).toEqual(['version-probe']);
		} finally {
			if (deferredRunRoot) await rm(deferredRunRoot, { recursive: true, force: true });
		}
	});

	it('closes containment acquired exactly as the absolute budget expires before model spawn', async () => {
		const harness = await createHarness('success');
		let monotonicTime = 0;
		let closeCalls = 0;
		let modelSpawned = false;
		// Same family as the tests above, caught before it could redden a run:
		// the injected clock only moves at containment acquisition, so with a 1 s
		// budget every preparation step before that (validate, trusted command,
		// run-root realpath + mkdtemp + mkdirs — internal.ts:316-413) sat inside
		// a REAL 1 s `withinExecutionDeadline` timer. Overrunning any of them
		// ends the run before acquisition, leaving `expected 0 to be 1` on
		// closeCalls. The fake clock jump is what proves the deadline here, so
		// the real number only has to be too large for a real timer to pre-empt.
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
			{
				...harness.io,
				monotonicNow: () => monotonicTime,
				spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
				createModelProcessContainment: async () => {
					monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
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
			}
		);

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
			let deferredRunRoot: string | undefined;
			try {
				const execution = executeModelProcess(
					request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
					{
						...harness.io,
						monotonicNow: () => monotonicTime,
						// The hang detector below starts before the trusted-command
						// and run-root filesystem preparation, while the settle timer
						// only starts after it. Racing the production 2.5 s bound
						// against a 3.5 s detector left <1 s for that I/O and failed
						// on a saturated runner (CI job 100564258206: 6285 ms). The
						// test owns the bound and keeps the workspace stat and the
						// bounded run-root removal (up to 3 x 250 ms) out of the
						// race; what still races is the realpath/mkdtemp/mkdir
						// preparation and the real settle timer.
						terminationSettleMs: TEST_TERMINATION_SETTLE_MS,
						directoryExists: async () => true,
						removeRunRoot: async (path) => {
							deferredRunRoot = path;
						},
						spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
						createModelProcessContainment: async () => {
							monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
							return {
								spawn: (() => {
									throw new Error('model must not spawn after the deadline');
								}) as typeof spawn,
								close
							};
						}
					}
				);
				let hangDetector: NodeJS.Timeout | undefined;
				const outcome = await Promise.race([
					execution.then((result) => ({ kind: 'result' as const, result })),
					new Promise<{ kind: 'hung' }>((resolvePromise) => {
						hangDetector = setTimeout(() => resolvePromise({ kind: 'hung' }), HUNG_CLOSE_DETECTION_MS);
					})
				]).finally(() => clearTimeout(hangDetector));

				expect(outcome.kind).toBe('result');
				if (outcome.kind === 'result') {
					expect(outcome.result.status).toBe('termination-failed');
					expect(outcome.result.summary).toMatch(
						closeMode === 'rejects'
							? /close failed: unused containment close rejected/
							: /did not settle before its safety deadline/
					);
				}
				expect(closeCalls).toBe(1);
				expect(deferredRunRoot).toBeDefined();
			} finally {
				if (deferredRunRoot) await rm(deferredRunRoot, { recursive: true, force: true });
			}
		},
		HUNG_CLOSE_TEST_BUDGET_MS
	);

	it.each([
		['larger than the production bound', 60_000],
		['NaN', Number.NaN],
		['negative', -1],
		['Infinity', Number.POSITIVE_INFINITY]
	])(
		'never lets a %s terminationSettleMs seam value extend the production safety deadline',
		async (_shape, requestedSettleMs) => {
			const harness = await createHarness('success');
			let monotonicTime = 0;
			let closeCalls = 0;
			const closeTiming: { startedAt?: number } = {};
			let deferredRunRoot: string | undefined;
			try {
				const execution = executeModelProcess(
					request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
					{
						...harness.io,
						monotonicNow: () => monotonicTime,
						// The seam's only safety property: it may shorten the production
						// termination-safety deadline but can never extend it. Unclamped,
						// 60 s would extend it and NaN / -1 / Infinity would arm a
						// degenerate ~1 ms timer, so the same never-settling close must
						// be abandoned at exactly the production bound in every row.
						terminationSettleMs: requestedSettleMs,
						directoryExists: async () => true,
						removeRunRoot: async (path) => {
							deferredRunRoot = path;
						},
						spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
						createModelProcessContainment: async () => {
							monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
							return {
								spawn: (() => {
									throw new Error('model must not spawn after the deadline');
								}) as typeof spawn,
								close: () => {
									closeCalls += 1;
									closeTiming.startedAt = performance.now();
									return new Promise(() => undefined);
								}
							};
						}
					}
				);
				let hangDetector: NodeJS.Timeout | undefined;
				const outcome = await Promise.race([
					execution.then((result) => ({ kind: 'result' as const, result })),
					new Promise<{ kind: 'hung' }>((resolvePromise) => {
						hangDetector = setTimeout(() => resolvePromise({ kind: 'hung' }), HUNG_CLOSE_DETECTION_MS);
					})
				]).finally(() => clearTimeout(hangDetector));
				const settledAt = performance.now();

				expect(outcome.kind).toBe('result');
				if (outcome.kind === 'result') {
					expect(outcome.result.status).toBe('termination-failed');
					expect(outcome.result.summary).toMatch(/did not settle before its safety deadline/);
				}
				expect(closeCalls).toBe(1);
				expect(closeTiming.startedAt).toBeDefined();
				// Measured from the close call (the settle timer is armed in the
				// same tick, immediately before it) to the result. That window
				// holds only the settle timer and microtasks - the workspace stat
				// and the run-root removal are seamed out above - so it is the
				// production bound itself: the lower edge tolerates Node firing a
				// timer up to ~1 ms early, and the upper edge leaves 1.5 s for
				// event-loop delay on a loaded runner (no I/O sits in the window).
				// An unclamped 60 s timer or a degenerate 1 ms timer both land far
				// outside it.
				const settleWindowMs = settledAt - (closeTiming.startedAt ?? settledAt);
				expect(settleWindowMs).toBeGreaterThanOrEqual(TERMINATION_SETTLE_MS - 50);
				expect(settleWindowMs).toBeLessThan(4_000);
				expect(deferredRunRoot).toBeDefined();
			} finally {
				if (deferredRunRoot) await rm(deferredRunRoot, { recursive: true, force: true });
			}
		},
		HUNG_CLOSE_TEST_BUDGET_MS
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
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: REAL_PROCESS_RUN_BUDGET_MS }),
			{
				...harness.io,
				monotonicNow: () => monotonicTime,
				// The launcher under test rejects before it ever calls the base
				// spawn, so the version probe was the only real subprocess here —
				// and under a 1 s budget its real timer, not this launcher, decided
				// the status. A closed stub leaves the launcher as the only path to
				// a terminal result.
				spawnFn: (() => closedProcess('codex-cli 0.146.0\n')) as typeof spawn,
				createModelProcessContainment: async (spawnFn) => {
					const containment = await baseCreateContainment(spawnFn);
					containmentCount += 1;
					if (containmentCount === 1) return containment;
					return {
						...containment,
						spawn: async () => {
							monotonicTime = REAL_PROCESS_RUN_BUDGET_MS + 1;
							throw new Error('trusted broker stopped after deadline');
						}
					};
				}
			}
		);

		expect(result.status).toBe('timed-out');
		expect(result.summary).toMatch(/wall-clock/i);
		// Without this the run could satisfy both assertions above by failing at
		// the version probe and never reaching the launcher this test names.
		expect(containmentCount).toBe(2);
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
