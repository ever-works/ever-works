import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_MAX_RESULT_BYTES } from '@ever-works/contracts';
import {
	AcceptanceChecksPayloadError,
	buildNodeCheckEnv,
	CHECK_LOG_TAIL_BYTES,
	fitNodeOutcomeToResultBudget,
	normalizeChecks,
	runAcceptanceChecksJob,
	runNodeCommandStep,
	tailUtf8Bytes
} from './acceptance-checks';

/**
 * The v1 node executor.
 *
 * Two properties matter most, and neither is about happy-path plumbing:
 *
 *   1. The node's verdict rules MATCH the platform's gate runner. A node
 *      that scored checks differently would be worse than a node that
 *      ran nothing at all.
 *   2. A check subprocess sees a SCRUBBED environment. A fleet node is
 *      somebody's actual laptop, and the command it is asked to run is
 *      user-authored input.
 */

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-1',
		kind: 'acceptance-checks',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: payload as Record<string, unknown>,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

describe('runAcceptanceChecksJob — payload refusal', () => {
	const alwaysExists = { directoryExists: () => true };

	it('refuses a job with no payload', async () => {
		await expect(runAcceptanceChecksJob(job(null), alwaysExists)).rejects.toBeInstanceOf(
			AcceptanceChecksPayloadError
		);
	});

	it('refuses a job with no workspacePath', async () => {
		await expect(runAcceptanceChecksJob(job({ checks: [] }), alwaysExists)).rejects.toThrowError(/workspacePath/);
	});

	it('refuses a RELATIVE workspace — running in the wrong directory is worse than failing', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: 'relative/dir', checks: [] }), alwaysExists)
		).rejects.toThrowError(/absolute path/);
	});

	it('refuses a workspace that does not exist on this node', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: ABSOLUTE, checks: [] }), {
				directoryExists: () => false
			})
		).rejects.toThrowError(/does not exist on this node/);
	});

	it('reports gate `none` for a job with zero checks — not a pass, not a failure', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: ABSOLUTE, checks: [] }), alwaysExists)
		).resolves.toEqual({ gateStatus: 'none', results: [] });
	});
});

describe('normalizeChecks — a malformed check is refused, never skipped', () => {
	it('refuses a non-array', () => {
		expect(() => normalizeChecks('nope')).toThrowError(/must be an array/);
	});

	it('refuses a check with no id', () => {
		expect(() => normalizeChecks([{ command: 'pnpm build' }])).toThrowError(/has no id/);
	});

	it('refuses a check with no command — silently dropping it would turn red green', () => {
		expect(() => normalizeChecks([{ id: 'build' }])).toThrowError(/has no command/);
	});

	it('refuses a job carrying more checks than the ceiling', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, command: 'true' }));
		expect(() => normalizeChecks(many)).toThrowError(/ceiling/);
	});

	it('keeps the declared order and the optional fields', () => {
		const parsed = normalizeChecks([
			{ id: 'lint', command: 'pnpm lint', required: false, cwd: 'apps/web', timeoutSec: 30 },
			{ id: 'build', command: 'pnpm build' }
		]);
		expect(parsed.map((c) => c.id)).toEqual(['lint', 'build']);
		expect(parsed[0]).toMatchObject({ required: false, cwd: 'apps/web', timeoutSec: 30 });
	});
});

describe('runAcceptanceChecksJob — verdict rules mirror the platform gate runner', () => {
	const alwaysExists = { directoryExists: () => true };

	/**
	 * Minimal spawn double: emits a close with the scripted exit code.
	 * NOTE the `in` check rather than `??` — a scripted `null` means "died
	 * by signal", which is precisely one of the cases under test and must
	 * not be coalesced to 0.
	 */
	function fakeSpawn(exitCodeByCommand: Record<string, number | null>) {
		return ((command: string) => {
			const handlers = new Map<string, (arg?: unknown) => void>();
			queueMicrotask(() => {
				handlers.get('close')?.(command in exitCodeByCommand ? exitCodeByCommand[command] : 0);
			});
			return {
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => {
					handlers.set(event, handler);
				},
				kill: () => undefined
			};
		}) as never;
	}

	it('exit 0 is green, nonzero is red', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({
				workspacePath: ABSOLUTE,
				checks: [
					{ id: 'ok', command: 'passing', required: true },
					{ id: 'bad', command: 'failing', required: true }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0, failing: 1 }) }
		);

		expect(outcome.results.map((r) => r.status)).toEqual(['green', 'red']);
		expect(outcome.results[1].exitCode).toBe(1);
		expect(outcome.gateStatus).toBe('red');
	});

	it('a NON-required check can never turn the gate red', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({
				workspacePath: ABSOLUTE,
				checks: [
					{ id: 'ok', command: 'passing', required: true },
					{ id: 'advisory', command: 'failing', required: false }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0, failing: 1 }) }
		);

		expect(outcome.results[1].status).toBe('red');
		expect(outcome.gateStatus).toBe('green');
	});

	it('treats an absent `required` as required, matching the platform default', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'bad', command: 'failing' }] }),
			{ ...alwaysExists, spawnFn: fakeSpawn({ failing: 2 }) }
		);
		expect(outcome.gateStatus).toBe('red');
	});

	it('reports an unspawnable check as `error`, distinguishable from a code failure', async () => {
		const throwingSpawn = (() => {
			throw new Error('spawn ENOENT');
		}) as never;
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'broken', command: 'nope' }] }),
			{ ...alwaysExists, spawnFn: throwingSpawn }
		);
		expect(outcome.results[0].status).toBe('error');
		expect(outcome.results[0].exitCode).toBeNull();
		expect(outcome.gateStatus).toBe('red');
	});

	it('treats death by external signal (null exit code) as red, not a pass', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'killed', command: 'signalled' }] }),
			{ ...alwaysExists, spawnFn: fakeSpawn({ signalled: null }) }
		);
		expect(outcome.results[0].status).toBe('red');
	});
});

describe('runNodeCommandStep — cancellation', () => {
	it('terminates the real shell process tree and fails closed when its lease signal aborts', async () => {
		const ownedRoot = mkdtempSync(join(tmpdir(), 'ew-node-command-cancel-'));
		const readyPath = join(ownedRoot, 'ready.json');
		const markerPath = join(ownedRoot, 'grandchild-survived.txt');
		const childScript = join(ownedRoot, 'child.cjs');
		const parentScript = join(ownedRoot, 'parent.cjs');
		let pids: { parent?: number; child?: number } = {};
		try {
			writeFileSync(
				childScript,
				`const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(markerPath)},'alive'),750);setInterval(()=>{},1000);`
			);
			writeFileSync(
				parentScript,
				`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`
			);
			const controller = new AbortController();
			const command = `"${process.execPath}" "${parentScript}"`;
			const pending = runNodeCommandStep(
				{ id: 'real-tree', command, timeoutSec: 3 },
				ownedRoot,
				{},
				controller.signal
			);
			await expect.poll(() => existsSync(readyPath), { timeout: 2_500 }).toBe(true);
			pids = JSON.parse(await fs.readFile(readyPath, 'utf8')) as typeof pids;

			controller.abort(new Error('Fleet job lease was lost'));
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			expect(existsSync(markerPath)).toBe(false);
		} finally {
			for (const pid of [pids.parent, pids.child]) {
				if (!pid) continue;
				try {
					if (process.platform === 'win32') {
						execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
					} else {
						process.kill(pid, 'SIGKILL');
					}
				} catch {
					// Already terminated by the command runner.
				}
			}
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	}, 10_000);
});

describe('buildNodeCheckEnv — a check never inherits this machine', () => {
	const parent: NodeJS.ProcessEnv = {
		PATH: '/usr/bin',
		HOME: '/home/runner',
		LANG: 'en_US.UTF-8',
		LC_ALL: 'en_US.UTF-8',
		AWS_SECRET_ACCESS_KEY: 'super-secret',
		FLEET_NODE_SECRET: 'the-node-credential',
		DATABASE_URL: 'postgres://user:pw@host/db',
		MY_API_TOKEN: 'tok',
		HTTPS_PROXY: 'http://proxy:8080',
		CUSTOM_BUILD_FLAG: 'yes'
	};

	it('passes the allowlisted plumbing through', () => {
		const env = buildNodeCheckEnv(undefined, parent);
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/runner');
		expect(env.LANG).toBe('en_US.UTF-8');
		expect(env.LC_ALL).toBe('en_US.UTF-8');
		expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
	});

	it('drops secret-shaped names that were never granted', () => {
		const env = buildNodeCheckEnv(undefined, parent);
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.MY_API_TOKEN).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});

	it("never leaks the NODE'S OWN credential namespace to a check", () => {
		// The escape hatch must not be able to re-open the hole it exists
		// beside: a check must never read the secret that lets this machine
		// lease work in the first place.
		const env = buildNodeCheckEnv(['FLEET_NODE_SECRET', 'DATABASE_URL'], parent);
		expect(env.FLEET_NODE_SECRET).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});

	it('honours an explicit, non-platform-owned passthrough grant', () => {
		const env = buildNodeCheckEnv(['CUSTOM_BUILD_FLAG'], parent);
		expect(env.CUSTOM_BUILD_FLAG).toBe('yes');
	});

	it('never returns anything the parent did not explicitly earn', () => {
		const env = buildNodeCheckEnv(undefined, { ...parent, RANDOM_THING: 'leaked' });
		expect(env.RANDOM_THING).toBeUndefined();
	});

	it('injects CI=1 so watch modes do not hang a check to its timeout', () => {
		expect(buildNodeCheckEnv(undefined, parent).CI).toBe('1');
	});

	/**
	 * Self-build slice Z (EW-796) — the MCP bridge did NOT weaken this.
	 *
	 * The bridge exists precisely BECAUSE `EVER_WORKS_` can never be
	 * granted: a run credential could not be handed to the model through
	 * the environment, so it is handed to a loopback proxy instead and the
	 * model never sees it at all. These cases exist so that a future
	 * "just add one exception" cannot land quietly — an env-based bridge
	 * would have to delete a passing test, and the reviewer would see it.
	 */
	it('refuses the EVER_WORKS_ namespace even when a job explicitly grants it', () => {
		const withPlatformVars: NodeJS.ProcessEnv = {
			...parent,
			EVER_WORKS_MCP_TOKEN: 'ew_run_0123456789abcdef',
			EVER_WORKS_MCP_URL: 'https://mcp.ever.works/mcp',
			EVER_WORKS_API_KEY: 'ew_live_should-never-appear'
		};

		// Ungranted: dropped, like every other platform-owned name.
		const ungranted = buildNodeCheckEnv(undefined, withPlatformVars);
		expect(ungranted.EVER_WORKS_MCP_TOKEN).toBeUndefined();
		expect(ungranted.EVER_WORKS_MCP_URL).toBeUndefined();
		expect(ungranted.EVER_WORKS_API_KEY).toBeUndefined();

		// GRANTED explicitly: still dropped. The grant is not a bypass.
		const granted = buildNodeCheckEnv(
			['EVER_WORKS_MCP_TOKEN', 'EVER_WORKS_MCP_URL', 'EVER_WORKS_API_KEY'],
			withPlatformVars
		);
		expect(granted.EVER_WORKS_MCP_TOKEN).toBeUndefined();
		expect(granted.EVER_WORKS_MCP_URL).toBeUndefined();
		expect(granted.EVER_WORKS_API_KEY).toBeUndefined();
		// And nothing that looks like a run token survives anywhere in it.
		expect(JSON.stringify(granted)).not.toContain('ew_run_');
		expect(JSON.stringify(granted)).not.toContain('ew_live_');
	});

	it('still grants an ordinary name in the same call that refuses a platform one', () => {
		// Proving the refusal is per-NAME and not "any call with a platform
		// name in it grants nothing" — otherwise the test above would pass
		// for the wrong reason.
		const env = buildNodeCheckEnv(['EVER_WORKS_MCP_TOKEN', 'CUSTOM_BUILD_FLAG'], {
			...parent,
			EVER_WORKS_MCP_TOKEN: 'ew_run_0123456789abcdef'
		});
		expect(env.EVER_WORKS_MCP_TOKEN).toBeUndefined();
		expect(env.CUSTOM_BUILD_FLAG).toBe('yes');
	});
});

/**
 * Per-repository env grants (run secrets, self-build slice Y, EW-781).
 *
 * `NODE_PLATFORM_OWNED_ENV_PATTERN` is a PREFIX regex, and the grant that
 * opens it is an EXACT name. That asymmetry is the entire security of the
 * feature: matched by prefix, one `DATABASE_URL` grant would also hand
 * over `DATABASE_PASSWORD`. Every adjacent-name case below exists because
 * getting this wrong is silent.
 */
describe('buildNodeCheckEnv — per-repository grants open the platform-owned refusal', () => {
	const parent: NodeJS.ProcessEnv = {
		PATH: '/usr/bin',
		DATABASE_URL: 'postgres://user:pw@host/db',
		DATABASE_URL_REPLICA: 'postgres://user:pw@replica/db',
		DATABASE_HOST: 'db.internal',
		DATABASE_PASSWORD: 'pw',
		database_url_extra: 'lowercase-adjacent',
		GH_TOKEN: 'gho_realtoken',
		FLEET_NODE_SECRET: 'the-node-credential',
		EVER_WORKS_API_KEY: 'platform-key',
		PLUGIN_SECRET_ENCRYPTION_KEY: 'the-key-that-decrypts-every-tenant',
		BETTER_AUTH_SECRET: 'session-signing',
		PLATFORM_ADMIN_TOKEN: 'admin'
	};

	it('admits EXACTLY the granted name and nothing adjacent to it', () => {
		const env = buildNodeCheckEnv(undefined, parent, ['DATABASE_URL']);
		expect(env.DATABASE_URL).toBe('postgres://user:pw@host/db');
		expect(env.DATABASE_URL_REPLICA).toBeUndefined();
		expect(env.DATABASE_HOST).toBeUndefined();
		expect(env.DATABASE_PASSWORD).toBeUndefined();
		expect(env.database_url_extra).toBeUndefined();
	});

	it('admits a granted name even when the instance passthrough never mentions it', () => {
		// A grant is a permission in its own right, not a filter over the
		// instance-global list.
		expect(buildNodeCheckEnv([], parent, ['GH_TOKEN']).GH_TOKEN).toBe('gho_realtoken');
	});

	it('with NO grants, behaves exactly as it did before this slice', () => {
		const env = buildNodeCheckEnv(['DATABASE_URL', 'GH_TOKEN'], parent);
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(buildNodeCheckEnv(['DATABASE_URL'], parent, []).DATABASE_URL).toBeUndefined();
		expect(buildNodeCheckEnv(['DATABASE_URL'], parent, null).DATABASE_URL).toBeUndefined();
	});

	it.each([
		'FLEET_NODE_SECRET',
		'EVER_WORKS_API_KEY',
		'PLUGIN_SECRET_ENCRYPTION_KEY',
		'BETTER_AUTH_SECRET',
		'PLATFORM_ADMIN_TOKEN'
	])('never admits %s, however explicitly it is granted', (name) => {
		// The un-grantable core. `FLEET_`/`EVER_WORKS_` is the credential
		// that leases work on this machine; `PLUGIN_` decrypts every
		// tenant's env files; the rest sign platform sessions. Opening any
		// of them turns "read one secret" into "become the platform".
		const env = buildNodeCheckEnv([name], parent, [name]);
		expect(env[name]).toBeUndefined();
	});

	it('ignores a wildcard grant rather than expanding it', () => {
		const env = buildNodeCheckEnv(undefined, parent, ['DATABASE_*', '*']);
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.DATABASE_PASSWORD).toBeUndefined();
	});

	it('matches case-insensitively, because Windows env names are', () => {
		expect(buildNodeCheckEnv(undefined, parent, ['database_url']).DATABASE_URL).toBe('postgres://user:pw@host/db');
	});

	it('does not let a grant leak into the instance-global list for other repositories', () => {
		// Two calls, one grant set each: the second must not see the first's.
		buildNodeCheckEnv(undefined, parent, ['DATABASE_URL']);
		expect(buildNodeCheckEnv(undefined, parent, ['GH_TOKEN']).DATABASE_URL).toBeUndefined();
	});
});

describe('the CHECKOUT must not be able to choose the program (EW-807)', () => {
	/**
	 * THE control that makes an exact-match command allow-list mean
	 * anything on Windows.
	 *
	 * `spawn(command, { shell: true, cwd })` on win32 is `cmd.exe /d /s /c`,
	 * and cmd.exe resolves a bare program name from the CURRENT DIRECTORY
	 * before it consults PATH. The current directory is the checkout, whose
	 * contents are written by whoever can push to the repository and,
	 * mid-run, by the model. So a committed three-line `git.cmd` turns the
	 * character-for-character allow-listed string `git --version` into "run
	 * the attacker's program" — no shell metacharacter, no mid-run edit of
	 * the frozen set, no race.
	 */
	it('sets the cmd.exe switch that removes the implicit current directory', () => {
		const env = buildNodeCheckEnv([], { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' });
		expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
	});

	it('cannot be spelled away by the parent environment or by a grant', () => {
		const env = buildNodeCheckEnv(['NoDefaultCurrentDirectoryInExePath'], {
			PATH: '/usr/bin',
			NoDefaultCurrentDirectoryInExePath: '0',
			NODEFAULTCURRENTDIRECTORYINEXEPATH: '0'
		});
		const spellings = Object.keys(env).filter((key) => key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH');
		expect(spellings).toHaveLength(1);
		expect(env[spellings[0]]).toBe('1');
	});

	it('strips the PATH entries that mean "here" — the POSIX half of the same hole', () => {
		const separator = process.platform === 'win32' ? ';' : ':';
		const env = buildNodeCheckEnv([], {
			PATH: ['/usr/local/bin', '', '.', '/usr/bin', './', '"."'].join(separator)
		});
		expect(env.PATH?.split(separator)).toEqual(['/usr/local/bin', '/usr/bin']);
	});

	it('never leaves PATH as the empty string, which is itself "here"', () => {
		const env = buildNodeCheckEnv([], { PATH: process.platform === 'win32' ? '.;;./' : '.::./' });
		expect(env.PATH).not.toBe('');
		if (process.platform !== 'win32') expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
	});

	/**
	 * The mechanism itself, through the REAL runner and a REAL cmd.exe.
	 * Everything above asserts the env we build; this asserts that the env
	 * we build actually stops the hijack.
	 */
	it('runs the real program, not one committed at the root of the checkout (win32)', async () => {
		if (process.platform !== 'win32') {
			expect(true).toBe(true);
			return;
		}
		const root = mkdtempSync(join(tmpdir(), 'ew-hijack-'));
		// A repository could have committed exactly this file.
		writeFileSync(join(root, 'git.cmd'), '@echo off\r\necho HIJACKED-BY-REPO-FILE\r\n');
		const result = await runNodeCommandStep({ id: 'probe', command: 'git --version' }, root, {
			parentEnv: process.env
		});
		expect(result.status).toBe('green');
		expect(result.logTail ?? '').not.toContain('HIJACKED-BY-REPO-FILE');
		expect(result.logTail ?? '').toContain('git version');
	});
});

describe('runAcceptanceChecksJob — a repository selector this kind cannot honour (EW-807)', () => {
	/**
	 * `mountDir` names WHICH repository of a multi-repo run a command runs
	 * in. This job kind provisions ONE directory and holds no mount
	 * descriptor, so it cannot resolve the name. Running it in
	 * `workspacePath` anyway would grade the PRIMARY worktree and file the
	 * verdict under the name of a repository nothing executed — the
	 * wrong-repository green this slice exists to delete.
	 */
	it('refuses the job rather than running the check in the primary worktree', async () => {
		await expect(
			runAcceptanceChecksJob(
				job({
					workspacePath: ABSOLUTE,
					checks: [{ id: 'template-tests', command: 'pnpm test', mountDir: 'template' }]
				}),
				{ directoryExists: () => true }
			)
		).rejects.toThrowError(/names repository 'template'/);
	});

	it('leaves a job with no selector exactly as it was', async () => {
		const outcome = await runAcceptanceChecksJob(job({ workspacePath: ABSOLUTE, checks: [] }), {
			directoryExists: () => true
		});
		expect(outcome).toEqual({ gateStatus: 'none', results: [] });
	});
});

describe('log tails are bounded in BYTES, and the result fits the platform cap (EW-807)', () => {
	function floodingSpawn(text: string) {
		return ((): unknown => {
			const handlers = new Map<string, (arg?: unknown) => void>();
			const stdout = {
				on: (event: string, handler: (chunk: Buffer) => void) => {
					if (event === 'data') queueMicrotask(() => handler(Buffer.from(text, 'utf8')));
				},
				destroy: () => undefined
			};
			queueMicrotask(() => queueMicrotask(() => handlers.get('close')?.(0)));
			return {
				stdout,
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => {
					handlers.set(event, handler);
				},
				kill: () => undefined
			};
		}) as never;
	}

	it('keeps the tail inside its byte budget when the output is not ASCII', async () => {
		// U+2500 is ONE UTF-16 code unit and THREE UTF-8 bytes — the glyph
		// every package manager and test runner draws its trees with. Under
		// a `String.prototype.slice` window the tail was 3x its stated
		// budget, and the budget is what keeps the job result under the
		// platform's hard 256 KiB cap.
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'noisy', command: 'noisy' }] }),
			{ directoryExists: () => true, spawnFn: floodingSpawn('\u2500'.repeat(CHECK_LOG_TAIL_BYTES)) }
		);
		const tail = outcome.results[0].logTail ?? '';
		expect(tail.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(CHECK_LOG_TAIL_BYTES);
	});

	it('fits an oversize outcome inside the job result cap by shedding log text', () => {
		const oversize = {
			gateStatus: 'green',
			results: Array.from({ length: 32 }, (_, index) => ({
				id: `check-${index}`,
				status: 'green',
				exitCode: 0,
				durationMs: 1,
				logTail: 'x'.repeat(16 * 1024)
			}))
		};
		expect(Buffer.byteLength(JSON.stringify(oversize), 'utf8')).toBeGreaterThan(FLEET_JOB_MAX_RESULT_BYTES);

		const fitted = fitNodeOutcomeToResultBudget(oversize);
		// The VERDICT survives — that is the whole point. An oversize result
		// is rejected by `completeJob`, which the worker loop re-reports as
		// a FAILED run, and a failure report stores no result at all: gate,
		// pushed branch and owner question all discarded.
		expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(FLEET_JOB_MAX_RESULT_BYTES);
		expect(fitted.gateStatus).toBe('green');
		expect(fitted.results).toHaveLength(32);
		expect(fitted.results.every((result) => result.status === 'green')).toBe(true);
	});

	it('leaves an outcome that already fits completely untouched', () => {
		const outcome = {
			gateStatus: 'red',
			results: [{ id: 'a', status: 'red', exitCode: 1, durationMs: 2 }]
		};
		expect(fitNodeOutcomeToResultBudget(outcome)).toBe(outcome);
	});

	it('counts a tail in bytes, not UTF-16 code units', () => {
		expect(tailUtf8Bytes('\u2500'.repeat(10), 9)).toBe('\u2500'.repeat(3));
		// A cut that lands mid-sequence walks FORWARD to the next codepoint
		// rather than emitting U+FFFD, which is three bytes where the
		// fragment was one and would push the tail back over its bound.
		expect(tailUtf8Bytes('\u2500'.repeat(10), 8)).toBe('\u2500'.repeat(2));
		expect(Buffer.byteLength(tailUtf8Bytes('\u2500'.repeat(10), 8), 'utf8')).toBeLessThanOrEqual(8);
		expect(tailUtf8Bytes('abc', 10)).toBe('abc');
	});
});
