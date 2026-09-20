import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { mkdtempSync, promises as realFs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AgentTaskPayloadError,
	defaultScratchFs,
	resolveRealHomeDir,
	runAgentTaskJob,
	type AgentTaskIo,
	type AgentTaskScratchFs,
	type AgentTaskSessionConfigFs
} from './agent-task';
import {
	CLAUDE_TOP_LEVEL_CONFIG_FILE_NAME,
	ISOLATED_HOME_ENV_NAMES,
	ISOLATED_HOME_RESIDUAL_ENV_NAMES
} from '../model-execution/isolated-home';
import { ownerQuestionPath, type AgentTaskQuestionFs } from './agent-task-question';
import { MODEL_CLI_MAX_OUTPUT_BYTES } from './model-cli';

/**
 * `agent-task` with an `execution` block — agent execution v2.
 *
 * What these prove, in order of how much it would hurt to lose:
 *
 *   1. The model runs FIRST, in the provisioned worktree, with the
 *      instructions on stdin (a scratch file the node writes) and the
 *      CLI's output captured from a scratch file — never argv.
 *   2. The verdict is honest: a model that failed, a red check, or a
 *      failed push each make the job `failed` and say why, even when
 *      the other parts went fine.
 *   3. A node without the requested CLI refuses the job naming the knob,
 *      rather than pretending to have run it.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';

const descriptor: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: false
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-77',
		kind: 'agent-task',
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

const claudeEnvelope = JSON.stringify({
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: 'Implemented the change.',
	total_cost_usd: 0.5,
	num_turns: 3,
	session_id: 'sess-1'
});

/**
 * In-memory scratch filesystem; records what the model step wrote.
 *
 * `mkdir` is what lets the model step build its per-run isolated home
 * (self-build slice AK) without touching the real filesystem. It is
 * OPTIONAL on the seam, and its absence is a recorded containment
 * downgrade rather than a silent no-op — see the downgrade tests below,
 * which drop it on purpose.
 */
function scratchFs(
	modelOutput: string | null
): AgentTaskScratchFs & { files: Map<string, string>; removed: string[]; dirs: string[] } {
	const files = new Map<string, string>();
	const removed: string[] = [];
	const dirs: string[] = [];
	return {
		files,
		removed,
		dirs,
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? modelOutput : (files.get(path) ?? null)),
		remove: async (path) => {
			removed.push(path);
		},
		mkdir: async (path) => {
			dirs.push(path);
		}
	};
}

/**
 * The three downgrades EVERY ordinary run carries, isolated or not.
 *
 * `toolchain-anchors` is the one a reader is most likely to be surprised
 * by and the reason it is standing: the command runner's allowlist still
 * forwards `PNPM_HOME`, `NVM_DIR`, `NODE_OPTIONS` and a dozen more as
 * absolute paths into the real profile, so `isolatedHome: true` on its own
 * would read as "nothing of the real home is left", which is false.
 */
const STANDING_DOWNGRADES = [
	{ control: 'process-containment', reason: expect.stringContaining('hardened executor') },
	{ control: 'network-egress', reason: expect.stringContaining('outbound network') },
	{ control: 'toolchain-anchors', reason: expect.stringContaining('toolchain anchors') }
];

/** The containment every run in this file gets: ordinary path, home isolated. */
function containedRun(sessionHome: string = join(homedir(), '.claude')) {
	return {
		executionPath: 'ordinary',
		isolatedHome: true,
		localSessionHome: sessionHome,
		downgrades: STANDING_DOWNGRADES
	};
}

/**
 * A machine whose Claude Code config relocates harmlessly.
 *
 * Deterministic on purpose, and provided by `baseIo` for every test in
 * this file: the production reader looks at the DEVELOPER's own
 * `~/.claude.json`, so a default would make `isolatedHome` depend on
 * whether the person running the suite happens to have onboarded their
 * CLI. `null` for both files reads as "this machine has no top-level
 * config", which is the case where relocating costs nothing.
 */
function sessionConfigFs(files: Record<string, string> = {}): AgentTaskSessionConfigFs {
	return { readFile: async (path: string) => files[path] ?? null };
}

/**
 * In-memory owner-question filesystem (self-build slice Q). Records every
 * removal in `events` so ordering against the spawn and the finalizers can
 * be asserted; `readHead` is null for an absent path, so a test that never
 * seeds a file never touches the real filesystem.
 */
function questionFs(seed: Record<string, string> = {}, events: string[] = []) {
	const files = new Map<string, string>(Object.entries(seed));
	const fs: AgentTaskQuestionFs & { files: Map<string, string>; events: string[] } = {
		files,
		events,
		readHead: async (path, maxBytes) => {
			const content = files.get(path);
			if (content === undefined) return null;
			return Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
		},
		remove: async (path) => {
			events.push(`remove:${path}`);
			files.delete(path);
		},
		removeDirIfEmpty: async () => undefined
	};
	return fs;
}

/** Spawn double that records every command and scripts exit codes by substring. */
function recordingSpawn(
	exitCodes: Array<[match: string, code: number | null]>,
	onCommand?: (command: string) => void,
	/**
	 * The ENVIRONMENT each command was actually given. The containment
	 * record is built from what the node INTENDED; this is the only way a
	 * test can also see what the child got, which is what makes dropping
	 * the overlay at the call site fail the exact-shape assertion instead
	 * of sliding past it.
	 */
	onEnv?: (env: Record<string, string>) => void
) {
	const commands: string[] = [];
	const spawnFn = ((command: string, options: { env: Record<string, string> }) => {
		commands.push(command);
		onCommand?.(command);
		onEnv?.(options.env);
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => {
			const hit = exitCodes.find(([match]) => command.includes(match));
			handlers.get('close')?.(hit ? hit[1] : 0);
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
	return { commands, spawnFn };
}

function baseIo(over: Partial<AgentTaskIo> = {}): AgentTaskIo {
	return {
		directoryExists: () => true,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 3
		})),
		modelCli: { 'claude-code': CLAUDE, codex: null },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs(claudeEnvelope),
		sessionConfigFs: sessionConfigFs(),
		questionFs: questionFs(),
		...over
	};
}

const payload = {
	taskId: 't1',
	runId: 'run-1',
	agentId: 'agent-1',
	workspace: {
		repositoryId: 'ever-works/ever-works',
		repoUrl: 'https://github.com/ever-works/ever-works.git',
		baseRef: 'develop',
		branch: 'task/t1-fix'
	},
	execution: {
		provider: 'claude-code',
		instructions: '# Task\nFix the thing.',
		model: 'claude-opus-5',
		effort: 'high',
		envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN']
	},
	acceptanceChecks: [{ id: 'unit', name: 'Unit', kind: 'test', command: 'pnpm test' }]
};

describe('runAgentTaskJob — model-cli execution', () => {
	it('runs the model in the worktree, grades the checks, commits and pushes, and reports success', async () => {
		const spawnEnvs: Array<Record<string, string>> = [];
		const { commands, spawnFn } = recordingSpawn([], undefined, (env) => spawnEnvs.push(env));
		const fs = scratchFs(claudeEnvelope);
		const io = baseIo({ spawnFn, scratchFs: fs });

		const outcome = await runAgentTaskJob(job(payload), io);

		expect(io.provisionWorkspace).toHaveBeenCalledWith('t1', payload.workspace, undefined);
		// The model command came FIRST, then the acceptance check.
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain(CLAUDE);
		expect(commands[0]).toContain('-p --output-format json --permission-mode acceptEdits');
		expect(commands[0]).toContain('--model claude-opus-5');
		expect(commands[0]).toContain('--effort high');
		expect(commands[0]).toContain('instructions.md');
		expect(commands[0]).not.toContain('Fix the thing');
		expect(commands[1]).toBe('pnpm test');
		// Instructions were written verbatim to scratch, and scratch was removed.
		const written = [...fs.files.entries()].find(([path]) => path.endsWith('instructions.md'));
		expect(written?.[1]).toBe('# Task\nFix the thing.');
		expect(fs.removed).toHaveLength(1);
		expect(fs.removed[0]).toContain('job-77');
		expect(fs.removed[0]).toContain('-scratch');

		expect(io.finalizeWorkspace).toHaveBeenCalledWith(
			't1',
			descriptor,
			{ commitMessage: 'feat(task): t1 agent run output', push: true },
			undefined
		);
		expect(outcome).toEqual({
			status: 'succeeded',
			taskId: 't1',
			runId: 'run-1',
			workspace: descriptor,
			steps: [],
			model: {
				provider: 'claude-code',
				status: 'succeeded',
				exitCode: 0,
				durationMs: expect.any(Number),
				summary: 'Implemented the change.',
				costUsd: 0.5,
				turns: 3,
				sessionId: 'sess-1'
			},
			checks: [{ id: 'unit', status: 'green', exitCode: 0, durationMs: expect.any(Number) }],
			gateStatus: 'green',
			git: {
				branch: 'task/t1-fix',
				baseSha: 'a'.repeat(40),
				headSha: 'b'.repeat(40),
				empty: false,
				pushed: true,
				changedFiles: 3
			},
			// Slice AK: what containment the model step actually got, on
			// every run that ran one — including this entirely successful
			// one. A record that only appeared when something went wrong
			// would teach a reader to read its absence as "fine", and the
			// absence also means "older node" and "the call was dropped".
			containment: containedRun()
		});

		// ...and the record is checked against the ENVIRONMENT the child
		// actually got, not only against what the node meant to do. The
		// record is computed from `mkdir` succeeding; the overlay reaches
		// the child through a separate call argument, and without this
		// assertion dropping that argument leaves this test green while the
		// job row still claims `isolatedHome: true`.
		const isolatedRoot = join(SCRATCH, 'job-77-scratch', 'run-home', 'home');
		expect(spawnEnvs[0]?.HOME).toBe(isolatedRoot);
		expect(spawnEnvs[0]?.USERPROFILE).toBe(isolatedRoot);
		expect(spawnEnvs[0]?.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude'));
		// The acceptance check is the control: it keeps the machine's home.
		expect(spawnEnvs[1]?.HOME).not.toBe(isolatedRoot);
	});

	it('honours the git policy: custom subject, no push', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		await runAgentTaskJob(job({ ...payload, git: { push: false, commitMessage: 'chore: wip' } }), io);
		expect(io.finalizeWorkspace).toHaveBeenCalledWith(
			't1',
			descriptor,
			{ commitMessage: 'chore: wip', push: false },
			undefined
		);
	});

	it('passes the lease fence into finalize and names a withheld publish in the run report', async () => {
		const { spawnFn } = recordingSpawn([]);
		const fence = { deadlineAt: Date.parse('2026-09-04T13:00:00.000Z'), marginMs: 60_000 };
		const withheld = 'the lease on this work expired 12s ago';
		const onPublishWithheld = vi.fn();
		const io = baseIo({
			spawnFn,
			// Async on purpose: resolving the fence re-asks the platform
			// whether this node still holds the claim.
			publishFence: async () => fence,
			onPublishWithheld,
			finalizeWorkspace: vi.fn(async () => ({
				pushed: false,
				headSha: 'c'.repeat(40),
				empty: false,
				changedFiles: 2,
				publishWithheld: withheld
			}))
		});

		const outcome = await runAgentTaskJob(job(payload), io);

		expect(io.finalizeWorkspace).toHaveBeenCalledWith(
			't1',
			descriptor,
			{ commitMessage: 'feat(task): t1 agent run output', push: true, publishFence: fence },
			undefined
		);
		// The run FAILS — the branch never reached the remote — but the reason
		// reads "publish withheld", not "git finalize failed": nothing is broken
		// in Git, and headSha names the commit the next attempt resumes from.
		expect(outcome.status).toBe('failed');
		expect(outcome.failureReason).toBe(`publish withheld: ${withheld}`);
		// And the caller is TOLD, so it can decide the job was never run to a
		// verdict rather than settling it terminally with no branch pushed.
		expect(onPublishWithheld).toHaveBeenCalledExactlyOnceWith(withheld);
		expect(outcome.git).toEqual({
			branch: 'task/t1-fix',
			baseSha: 'a'.repeat(40),
			headSha: 'c'.repeat(40),
			empty: false,
			pushed: false,
			changedFiles: 2,
			publishWithheld: withheld
		});
	});

	it('reads the lease deadline AFTER the model step, not when the job was leased', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const commandsAtFenceTime: string[] = [];
		const publishFence = vi.fn(() => {
			commandsAtFenceTime.push(...commands);
			return { deadlineAt: Date.parse('2026-09-04T14:00:00.000Z'), marginMs: 60_000 };
		});
		const onPublishWithheld = vi.fn();
		const io = baseIo({ spawnFn, publishFence, onPublishWithheld });

		const outcome = await runAgentTaskJob(job(payload), io);

		expect(publishFence).toHaveBeenCalledTimes(1);
		// A push that LANDED is an ordinary success: nothing was withheld, so
		// the job settles exactly as it did before the fence existed.
		expect(onPublishWithheld).not.toHaveBeenCalled();
		expect(outcome.status).toBe('succeeded');
		// The model and the acceptance check had both already run, so the
		// deadline read is the one the keep-alive has since renewed — reading
		// it at job start would fence against a value four renewals stale.
		expect(commandsAtFenceTime).toEqual(commands);
		expect(commandsAtFenceTime).toHaveLength(2);
	});

	it('skips the commit entirely when the policy says so', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		const outcome = await runAgentTaskJob(job({ ...payload, git: { commit: false } }), io);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
		expect(outcome.git).toBeUndefined();
		expect(outcome.status).toBe('succeeded');
	});

	it('fails the job when the CLI reports an error, and still grades the checks', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(
				JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'blew up' })
			)
		});
		const outcome = await runAgentTaskJob(job(payload), io);
		expect(commands).toHaveLength(2);
		expect(outcome.status).toBe('failed');
		expect(outcome.model?.status).toBe('failed');
		expect(outcome.failureReason).toContain('claude-code reported an error: blew up');
		expect(outcome.gateStatus).toBe('green');
	});

	it('fails the job on a red required check even when the model succeeded', async () => {
		const { spawnFn } = recordingSpawn([['pnpm test', 1]]);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn }));
		expect(outcome.status).toBe('failed');
		expect(outcome.gateStatus).toBe('red');
		expect(outcome.checks?.[0].status).toBe('red');
		expect(outcome.failureReason).toBe('a required acceptance check did not pass');
	});

	it('fails the job when the push fails, and names the git error', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			finalizeWorkspace: vi.fn(async () => {
				throw new Error('git push failed: remote rejected');
			})
		});
		const outcome = await runAgentTaskJob(job(payload), io);
		expect(outcome.status).toBe('failed');
		expect(outcome.git?.error).toBe('git push failed: remote rejected');
		expect(outcome.failureReason).toContain('git finalize failed');
	});

	it('reports a node without a finalizer honestly', async () => {
		const { spawnFn } = recordingSpawn([]);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, finalizeWorkspace: undefined }));
		expect(outcome.status).toBe('failed');
		expect(outcome.git?.error).toContain('no workspace finalizer');
	});

	it('refuses a job for a CLI this node does not have, naming the knob', async () => {
		const { spawnFn } = recordingSpawn([]);
		await expect(
			runAgentTaskJob(
				job({ ...payload, execution: { ...payload.execution, provider: 'codex' } }),
				baseIo({ spawnFn })
			)
		).rejects.toThrowError(/EVER_WORKS_NODE_CODEX_PATH/);
	});

	it('refuses a malformed execution block naming the field', async () => {
		const { spawnFn } = recordingSpawn([]);
		await expect(
			runAgentTaskJob(
				job({ ...payload, execution: { ...payload.execution, model: 'x; rm -rf /' } }),
				baseIo({ spawnFn })
			)
		).rejects.toBeInstanceOf(AgentTaskPayloadError);
	});

	it('runs the model without a repository workspace when only a path is given, and does not commit', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		const { workspace: _workspace, acceptanceChecks: _checks, ...rest } = payload;
		const outcome = await runAgentTaskJob(job({ ...rest, workspacePath: ABSOLUTE }), io);
		expect(commands).toHaveLength(1);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
		expect(outcome.workspace).toBeNull();
		expect(outcome.gateStatus).toBe('none');
		expect(outcome.status).toBe('succeeded');
	});

	it('still runs legacy steps after the model when both are present', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const outcome = await runAgentTaskJob(
			job({ ...payload, steps: [{ id: 'lint', command: 'pnpm lint' }] }),
			baseIo({ spawnFn })
		);
		expect(commands.map((c) => (c.includes(CLAUDE) ? 'model' : c))).toEqual(['model', 'pnpm lint', 'pnpm test']);
		expect(outcome.steps).toEqual([{ id: 'lint', status: 'green', exitCode: 0, durationMs: expect.any(Number) }]);
	});

	it('stops at a cancellation between phases', async () => {
		const controller = new AbortController();
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			provisionWorkspace: vi.fn(async () => {
				controller.abort(new Error('lease lost'));
				return descriptor;
			})
		});
		await expect(runAgentTaskJob(job(payload), io, controller.signal)).rejects.toThrowError(/lease lost/);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
	});
});

/**
 * Per-run containment of the model step (self-build slice AK).
 *
 * The threat this closes: a fleet node runs the model CLI through the
 * ORDINARY command runner, whose env scrub deliberately keeps and
 * back-fills `HOME` / `USERPROFILE` / `APPDATA`. One prompt injection in
 * a mounted repository could therefore read `~/.claude`, `~/.ssh`,
 * `~/.aws`, the git credential store and every other checkout on the PC.
 *
 * What is asserted here, in the order it would hurt to lose:
 *
 *   1. the MODEL step's child environment points at a per-run home under
 *      this run's own scratch directory, and no anchor still names the
 *      machine owner's home;
 *   2. the machine's CLI login survives — exactly one directory, the
 *      provider's config home, is mirrored back in;
 *   3. the acceptance checks are deliberately NOT isolated, because a
 *      redirected home makes every `pnpm install` a cold install against
 *      a directory the run deletes;
 *   4. every run says what containment it got, and every downgrade says
 *      why. A run that silently gets less than intended is the failure
 *      this whole slice exists to make impossible.
 */
describe('runAgentTaskJob — model-step containment (self-build slice AK)', () => {
	const REAL_HOME = process.platform === 'win32' ? 'C:\\Users\\owner' : '/home/owner';
	/**
	 * The node's real environment, as the scrub would see it.
	 *
	 * Deliberately a FAT fixture. A six-name parent env makes "nothing
	 * still names the real home" trivially true and proves nothing about a
	 * fleet PC, where the allowlist forwards a dozen toolchain anchors as
	 * absolute paths into the profile. Every one of those is here so the
	 * assertions below are about the real residual rather than about the
	 * fixture.
	 */
	const PARENT_ENV: NodeJS.ProcessEnv = {
		PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
		HOME: REAL_HOME,
		USERPROFILE: REAL_HOME,
		APPDATA: join(REAL_HOME, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(REAL_HOME, 'AppData', 'Local'),
		TEMP: join(REAL_HOME, 'AppData', 'Local', 'Temp'),
		LANG: 'en_US.UTF-8',
		// The residual, as a real Windows fleet node carries it.
		PNPM_HOME: join(REAL_HOME, 'AppData', 'Local', 'pnpm'),
		COREPACK_HOME: join(REAL_HOME, 'AppData', 'Local', 'node', 'corepack'),
		NVM_DIR: join(REAL_HOME, 'AppData', 'Roaming', 'nvm'),
		VOLTA_HOME: join(REAL_HOME, '.volta'),
		CARGO_HOME: join(REAL_HOME, '.cargo'),
		GOPATH: join(REAL_HOME, 'go'),
		NODE_OPTIONS: `--require ${join(REAL_HOME, 'hook.js')}`
	};

	/** Spawn double that records the ENVIRONMENT each command was given. */
	function envRecordingSpawn() {
		const spawns: Array<{ command: string; env: Record<string, string> }> = [];
		const spawnFn = ((command: string, options: { env: Record<string, string> }) => {
			spawns.push({ command, env: options.env });
			const handlers = new Map<string, (arg?: unknown) => void>();
			queueMicrotask(() => handlers.get('close')?.(0));
			return {
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => {
					handlers.set(event, handler);
				},
				kill: () => undefined
			};
		}) as never;
		return { spawns, spawnFn };
	}

	it('runs the model with a per-run isolated home and reports that it did', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		const fs = scratchFs(claudeEnvelope);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, scratchFs: fs, parentEnv: PARENT_ENV }));

		const model = spawns[0];
		const runHome = join(SCRATCH, 'job-77-scratch', 'run-home');
		expect(model.env.HOME).toBe(join(runHome, 'home'));
		expect(model.env.USERPROFILE).toBe(join(runHome, 'home'));
		expect(model.env.APPDATA).toBe(join(runHome, 'home', 'AppData', 'Roaming'));
		expect(model.env.LOCALAPPDATA).toBe(join(runHome, 'home', 'AppData', 'Local'));
		expect(model.env.XDG_CONFIG_HOME).toBe(join(runHome, 'home', '.config'));
		expect(model.env.TEMP).toBe(join(runHome, 'tmp'));
		expect(model.env.TMP).toBe(join(runHome, 'tmp'));

		// THE property, stated at the width it is actually proved: no
		// REDIRECTED ANCHOR still resolves into the machine's profile.
		//
		// It is not the wider "nothing in this env names the real home" —
		// that would be false on a fleet PC, where the allowlist forwards
		// the toolchain anchors as absolute paths, and false in production
		// for a second reason besides: `defaultScratchRoot()` puts the
		// isolated home UNDER `%TEMP%`, i.e. inside the real profile, so on
		// a real node every redirected value starts with the real home too.
		// What containment rests on is that the redirected anchors point at
		// a directory this RUN owns, not that the string looks unfamiliar.
		const anchorLeaks = [...ISOLATED_HOME_ENV_NAMES]
			// `HOMEDRIVE` / `HOMEPATH` are a split pair, not paths in their
			// own right; they are asserted by their rejoin just below.
			.filter((name) => name !== 'HOMEDRIVE' && name !== 'HOMEPATH')
			.filter((name) => {
				const value = model.env[name];
				return typeof value !== 'string' || !value.startsWith(runHome);
			})
			.sort();
		expect(anchorLeaks).toEqual([]);
		expect(`${model.env.HOMEDRIVE}${model.env.HOMEPATH}`).toBe(join(runHome, 'home'));

		// And the residual is exactly the disclosed one, name for name —
		// the standing `toolchain-anchors` downgrade is measured here, not
		// asserted from memory.
		// `includes`, not `startsWith`: `NODE_OPTIONS` carries the real home
		// in the MIDDLE of its value (`--require <home>\hook.js`), and it is
		// the residual that matters most — code loaded into every `node`
		// descendant of the model step.
		const stillNamingRealHome = Object.keys(model.env)
			.filter((name) => model.env[name]!.includes(REAL_HOME) && name !== 'CLAUDE_CONFIG_DIR')
			.sort();
		expect(stillNamingRealHome.filter((name) => !ISOLATED_HOME_RESIDUAL_ENV_NAMES.includes(name))).toEqual([]);
		expect(stillNamingRealHome).toContain('PNPM_HOME');
		expect(stillNamingRealHome).toContain('NODE_OPTIONS');

		// The home was actually built on disk before the spawn.
		expect(fs.dirs).toContain(join(runHome, 'tmp'));
		expect(fs.dirs).toContain(join(runHome, 'home', 'AppData', 'Roaming'));

		expect((outcome as { containment?: unknown }).containment).toEqual(containedRun(join(REAL_HOME, '.claude')));
	});

	it('mirrors the machine’s CLI session back in, so the login is not severed', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		await runAgentTaskJob(job(payload), baseIo({ spawnFn, parentEnv: PARENT_ENV }));
		// Exactly one directory of the real home reaches the model, and it
		// is the one the CLI needs to know who this machine is.
		expect(spawns[0].env.CLAUDE_CONFIG_DIR).toBe(join(REAL_HOME, '.claude'));
	});

	it.each([
		// On a real Git Bash node HOME is a POSIX `/c/Users/...` that no Windows
		// CLI can open while USERPROFILE is the Windows path, so win32 must ask for
		// USERPROFILE first; everywhere else HOME is the native answer.
		['win32', 'USERPROFILE'],
		['linux', 'HOME'],
		['darwin', 'HOME']
	] as const)('on %s, reads the real home from %s first', (platform, winner) => {
		// The shared PARENT_ENV sets HOME and USERPROFILE to the SAME path, so no
		// run-level test can tell which one was preferred — a mutation that
		// swapped the win32 order stayed green. This asserts the ordering directly,
		// with the two anchors deliberately different.
		//
		// It is a pure (platform, env) check on purpose. An earlier version drove a
		// full `runAgentTaskJob` with `platform: 'win32'` forced, which passed on a
		// Windows machine and failed on the Linux CI runner: `quoteShellPath`'s
		// win32 branch rightly demands a drive-letter path, and the node-owned
		// scratch and workspace paths come from the HOST. The wiring from this
		// value into CLAUDE_CONFIG_DIR is covered separately, by "mirrors the
		// machine's CLI session back in".
		const anchors = { USERPROFILE: join(REAL_HOME, 'profile-anchor'), HOME: join(REAL_HOME, 'home-anchor') };

		expect(resolveRealHomeDir({ platform, parentEnv: { ...PARENT_ENV, ...anchors } })).toBe(anchors[winner]);
	});

	it('falls back to the other anchor when the preferred one is blank', () => {
		// A blank USERPROFILE on win32 must not be returned as the home: an empty
		// string would mirror `.claude` relative to the node's working directory.
		const home = join(REAL_HOME, 'home-anchor');
		expect(
			resolveRealHomeDir({ platform: 'win32', parentEnv: { ...PARENT_ENV, USERPROFILE: '  ', HOME: home } })
		).toBe(home);
	});

	it('mirrors the Codex session home for a codex run', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		const codexPayload = {
			...payload,
			execution: { ...payload.execution, provider: 'codex', envPassthrough: ['CODEX_ACCESS_TOKEN'] }
		};
		await runAgentTaskJob(
			job(codexPayload),
			baseIo({
				spawnFn,
				parentEnv: PARENT_ENV,
				modelCli: { 'claude-code': null, codex: CLAUDE },
				scratchFs: scratchFs('{"type":"thread.started","thread_id":"t"}')
			})
		);
		expect(spawns[0].env.CODEX_HOME).toBe(join(REAL_HOME, '.codex'));
		expect(spawns[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
	});

	it('honours an operator-configured session home instead of guessing', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		const moved = join(REAL_HOME, 'cli-config', 'claude');
		await runAgentTaskJob(
			job(payload),
			baseIo({ spawnFn, parentEnv: PARENT_ENV, modelSessionHome: { 'claude-code': moved } })
		);
		expect(spawns[0].env.CLAUDE_CONFIG_DIR).toBe(moved);
	});

	it('leaves the ACCEPTANCE CHECKS on the machine’s real home, on purpose', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		await runAgentTaskJob(job(payload), baseIo({ spawnFn, parentEnv: PARENT_ENV }));
		const check = spawns[1];
		expect(check.command).toBe('pnpm test');
		// A redirected home here would make every `pnpm install` a cold
		// install against a directory this run deletes.
		expect(check.env.HOME).toBe(REAL_HOME);
		expect(check.env.CLAUDE_CONFIG_DIR).toBeUndefined();
	});

	it('records a downgrade — and keeps running — when the per-run home cannot be created', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		const fs = scratchFs(claudeEnvelope);
		fs.mkdir = async () => {
			throw new Error('ENOSPC: no space left on device');
		};
		const warnings: string[] = [];
		const outcome = await runAgentTaskJob(
			job(payload),
			baseIo({
				spawnFn,
				scratchFs: fs,
				parentEnv: PARENT_ENV,
				logger: {
					info: () => undefined,
					warn: (message: string) => warnings.push(message),
					error: () => undefined,
					protect: () => undefined,
					unprotect: () => undefined
				} as unknown as AgentTaskIo['logger']
			})
		);

		// The run still produced a verdict...
		expect(outcome.status).toBe('succeeded');
		// ...with the machine's real home, and it SAYS so.
		expect(spawns[0].env.HOME).toBe(REAL_HOME);
		expect(
			(
				outcome as {
					containment?: { isolatedHome: boolean; downgrades: Array<{ control: string; reason: string }> };
				}
			).containment
		).toEqual({
			executionPath: 'ordinary',
			isolatedHome: false,
			localSessionHome: null,
			downgrades: [
				...STANDING_DOWNGRADES,
				{ control: 'isolated-home', reason: expect.stringContaining('ENOSPC') }
			]
		});
		expect(warnings.some((line) => line.includes('containment downgraded'))).toBe(true);
	});

	it('records a downgrade when the scratch seam cannot create directories at all', async () => {
		const { spawnFn } = envRecordingSpawn();
		const fs = scratchFs(claudeEnvelope);
		delete (fs as { mkdir?: unknown }).mkdir;
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, scratchFs: fs, parentEnv: PARENT_ENV }));
		const containment = (
			outcome as { containment?: { isolatedHome: boolean; downgrades: Array<{ control: string }> } }
		).containment;
		expect(containment?.isolatedHome).toBe(false);
		expect(containment?.downgrades.map((entry) => entry.control)).toContain('isolated-home');
	});

	it('records a downgrade when an operator switches isolation off', async () => {
		const { spawns, spawnFn } = envRecordingSpawn();
		const outcome = await runAgentTaskJob(
			job(payload),
			baseIo({ spawnFn, parentEnv: PARENT_ENV, modelHomeIsolation: 'inherit' })
		);
		expect(spawns[0].env.HOME).toBe(REAL_HOME);
		const containment = (
			outcome as {
				containment?: { isolatedHome: boolean; downgrades: Array<{ control: string; reason: string }> };
			}
		).containment;
		expect(containment?.isolatedHome).toBe(false);
		expect(containment?.downgrades.find((entry) => entry.control === 'isolated-home')?.reason).toContain(
			'modelHomeIsolation=inherit'
		);
	});

	it('reports the three controls this node cannot offer at all, on every run', async () => {
		const { spawnFn } = envRecordingSpawn();
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, parentEnv: PARENT_ENV }));
		const controls = (
			outcome as {
				containment?: { executionPath: string; downgrades: Array<{ control: string; reason: string }> };
			}
		).containment;
		// Egress control is NOT attempted by this slice — a Job Object
		// cannot express it and no subsystem exists — so it is reported as
		// a standing downgrade rather than left to tribal knowledge. Same
		// for the toolchain anchors: they are the difference between what
		// `isolatedHome: true` says and what it means, and leaving them out
		// would make a fully isolated run read as having only two holes.
		expect(controls?.executionPath).toBe('ordinary');
		expect(controls?.downgrades.map((entry) => entry.control)).toEqual([
			'process-containment',
			'network-egress',
			'toolchain-anchors'
		]);
		const anchors = controls?.downgrades.find((entry) => entry.control === 'toolchain-anchors')?.reason ?? '';
		expect(anchors).toContain('PNPM_HOME');
	});

	/**
	 * `CLAUDE_CONFIG_DIR` relocates the CLI's top-level config from
	 * `~/.claude.json` to `<dir>/.claude.json`, and on a machine whose
	 * onboarding lives in the first file the relocated one presents to
	 * `claude -p` as never onboarded — with no way to answer the prompt.
	 * The node PROVES the relocation is harmless before isolating, and
	 * declines rather than shipping a run that cannot start.
	 */
	describe('the Claude Code config relocation is proved harmless before the home is isolated', () => {
		const LIVE = join(REAL_HOME, CLAUDE_TOP_LEVEL_CONFIG_FILE_NAME);
		const RELOCATED = join(REAL_HOME, '.claude', CLAUDE_TOP_LEVEL_CONFIG_FILE_NAME);

		function isolatedHomeDowngrade(outcome: unknown): string | undefined {
			return (
				outcome as { containment?: { downgrades: Array<{ control: string; reason: string }> } }
			).containment?.downgrades.find((entry) => entry.control === 'isolated-home')?.reason;
		}

		it('declines to isolate when the machine would lose a gate it passes today', async () => {
			const { spawns, spawnFn } = envRecordingSpawn();
			const outcome = await runAgentTaskJob(
				job(payload),
				baseIo({
					spawnFn,
					parentEnv: PARENT_ENV,
					// The split this machine really has: onboarding in the
					// live file, machine identity in the relocated one.
					sessionConfigFs: sessionConfigFs({
						[LIVE]: JSON.stringify({ hasCompletedOnboarding: true, projects: {} }),
						[RELOCATED]: JSON.stringify({ machineID: 'abc' })
					})
				})
			);

			// The run went ahead on the machine's real home...
			expect(spawns[0].env.HOME).toBe(REAL_HOME);
			expect(outcome.status).toBe('succeeded');
			// ...and the job row says exactly why, and how to fix it.
			expect((outcome as { containment?: { isolatedHome: boolean } }).containment?.isolatedHome).toBe(false);
			const reason = isolatedHomeDowngrade(outcome);
			expect(reason).toContain('hasCompletedOnboarding');
			expect(reason).toContain(RELOCATED);
		});

		it('isolates when the relocated config already carries the gates', async () => {
			const { spawns, spawnFn } = envRecordingSpawn();
			const gates = { hasCompletedOnboarding: true, hasTrustDialogHooksAccepted: true };
			const outcome = await runAgentTaskJob(
				job(payload),
				baseIo({
					spawnFn,
					parentEnv: PARENT_ENV,
					sessionConfigFs: sessionConfigFs({
						[LIVE]: JSON.stringify(gates),
						[RELOCATED]: JSON.stringify({ ...gates, machineID: 'abc' })
					})
				})
			);
			expect(spawns[0].env.HOME).not.toBe(REAL_HOME);
			expect((outcome as { containment?: { isolatedHome: boolean } }).containment?.isolatedHome).toBe(true);
		});

		it('declines when it cannot read the config at all — "we could not look" is not proof', async () => {
			const { spawns, spawnFn } = envRecordingSpawn();
			const outcome = await runAgentTaskJob(
				job(payload),
				baseIo({
					spawnFn,
					parentEnv: PARENT_ENV,
					sessionConfigFs: {
						readFile: async () => {
							throw new Error('EACCES: permission denied');
						}
					}
				})
			);
			expect(spawns[0].env.HOME).toBe(REAL_HOME);
			expect(isolatedHomeDowngrade(outcome)).toContain('EACCES');
		});

		it('declines when no reader is wired, rather than assuming the relocation is free', async () => {
			const { spawns, spawnFn } = envRecordingSpawn();
			const io = baseIo({ spawnFn, parentEnv: PARENT_ENV });
			delete (io as { sessionConfigFs?: unknown }).sessionConfigFs;
			const outcome = await runAgentTaskJob(job(payload), io);
			expect(spawns[0].env.HOME).toBe(REAL_HOME);
			expect(isolatedHomeDowngrade(outcome)).toContain('no reader wired');
		});

		it('does not gate CODEX on it — `CODEX_HOME` moves no second file', async () => {
			const { spawns, spawnFn } = envRecordingSpawn();
			const codexPayload = {
				...payload,
				execution: { ...payload.execution, provider: 'codex', envPassthrough: ['CODEX_ACCESS_TOKEN'] }
			};
			const io = baseIo({
				spawnFn,
				parentEnv: PARENT_ENV,
				modelCli: { 'claude-code': null, codex: CLAUDE },
				scratchFs: scratchFs('{"type":"thread.started","thread_id":"t"}')
			});
			// Even with NO reader at all, Codex isolates: the probe is about
			// a file only Claude Code has.
			delete (io as { sessionConfigFs?: unknown }).sessionConfigFs;
			const outcome = await runAgentTaskJob(job(codexPayload), io);
			expect(spawns[0].env.HOME).not.toBe(REAL_HOME);
			expect((outcome as { containment?: { isolatedHome: boolean } }).containment?.isolatedHome).toBe(true);
		});
	});

	it('carries no containment block for a run that had no model step', async () => {
		const { spawnFn } = envRecordingSpawn();
		const stepsOnly = { ...payload, execution: undefined, steps: [{ id: 's1', command: 'echo hi' }] };
		const outcome = await runAgentTaskJob(job(stepsOnly), baseIo({ spawnFn, parentEnv: PARENT_ENV }));
		expect('containment' in outcome).toBe(false);
	});
});

describe('runAgentTaskJob — owner question (self-build slice Q)', () => {
	const QUESTION_PATH = ownerQuestionPath(ABSOLUTE);
	const QUESTION_MD = '# Use Postgres?\n\nSQLite would be simpler, but the brief says production.';

	/** A spawn double that writes the question file when the MODEL command runs, and logs phases. */
	function questionRun(qfs: ReturnType<typeof questionFs>, events: string[], markdown: string | null) {
		return recordingSpawn([], (command) => {
			if (command.includes(CLAUDE)) {
				events.push('spawn:model');
				if (markdown !== null) qfs.files.set(QUESTION_PATH, markdown);
			} else {
				events.push('spawn:check');
			}
		});
	}

	it('reports the question the model wrote, removes the file, and still finalizes the partial work', async () => {
		const events: string[] = [];
		const qfs = questionFs({}, events);
		const { spawnFn } = questionRun(qfs, events, QUESTION_MD);
		const io = baseIo({
			spawnFn,
			questionFs: qfs,
			finalizeWorkspace: vi.fn(async () => {
				events.push('finalize:primary');
				return { pushed: true, headSha: 'b'.repeat(40), empty: false, changedFiles: 1 };
			})
		});

		const outcome = await runAgentTaskJob(job(payload), io);

		expect(outcome.question).toEqual({
			text: 'Use Postgres?',
			context: 'SQLite would be simpler, but the brief says production.',
			truncated: false,
			mountDir: null
		});
		// A question is not a failure: the model, the check and the push all
		// report exactly as they did, and the partial work is on the branch.
		expect(outcome.status).toBe('succeeded');
		expect(outcome.git).toMatchObject({ pushed: true, headSha: 'b'.repeat(40) });
		expect(qfs.files.size).toBe(0);
		// Ordering: the stale-file discard BEFORE the model, the collect
		// (its removal) AFTER the model and BEFORE the check and the finalize.
		expect(events).toEqual([
			`remove:${QUESTION_PATH}`,
			'spawn:model',
			`remove:${QUESTION_PATH}`,
			'spawn:check',
			'finalize:primary'
		]);
	});

	it('discards a stale file from an earlier attempt before the model runs and reports no question', async () => {
		const events: string[] = [];
		const qfs = questionFs({ [QUESTION_PATH]: '# Stale question from a crashed attempt?' }, events);
		let staleVisibleToModel: boolean | null = null;
		const { spawnFn } = recordingSpawn([], (command) => {
			if (command.includes(CLAUDE)) staleVisibleToModel = qfs.files.has(QUESTION_PATH);
		});

		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, questionFs: qfs }));

		expect(staleVisibleToModel).toBe(false);
		expect('question' in outcome).toBe(false);
		expect(outcome.status).toBe('succeeded');
		expect(events[0]).toBe(`remove:${QUESTION_PATH}`);
	});

	it('reports no question key at all when the model wrote no file', async () => {
		const { spawnFn } = recordingSpawn([]);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn }));
		expect('question' in outcome).toBe(false);
	});

	it('keeps the honest failure verdict AND the question when the model failed and a check is red', async () => {
		const events: string[] = [];
		const qfs = questionFs({}, events);
		const { spawnFn } = recordingSpawn(
			[
				[CLAUDE, 1],
				['pnpm test', 1]
			],
			(command) => {
				if (command.includes(CLAUDE)) qfs.files.set(QUESTION_PATH, QUESTION_MD);
			}
		);
		const io = baseIo({
			spawnFn,
			questionFs: qfs,
			scratchFs: scratchFs(
				JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'blew up' })
			)
		});

		const outcome = await runAgentTaskJob(job(payload), io);

		// The platform decides what a paused run means; the node never
		// launders a red verdict into a green one because a question exists.
		expect(outcome.status).toBe('failed');
		expect(outcome.failureReason).toContain('claude-code reported an error: blew up');
		expect(outcome.failureReason).toContain('a required acceptance check did not pass');
		expect(outcome.question?.text).toBe('Use Postgres?');
	});

	it('leaves the run untouched when the question file cannot be read', async () => {
		const qfs = questionFs();
		qfs.readHead = async () => {
			throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
		};
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn, questionFs: qfs });
		const outcome = await runAgentTaskJob(job(payload), io);
		expect('question' in outcome).toBe(false);
		expect(outcome.status).toBe('succeeded');
		expect(io.finalizeWorkspace).toHaveBeenCalledTimes(1);
	});

	it('still reports the question and still finalizes when the file cannot be removed', async () => {
		const events: string[] = [];
		const qfs = questionFs({}, events);
		qfs.remove = async () => {
			throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
		};
		const { spawnFn } = questionRun(qfs, events, QUESTION_MD);
		const io = baseIo({ spawnFn, questionFs: qfs });
		const outcome = await runAgentTaskJob(job(payload), io);
		expect(outcome.question?.text).toBe('Use Postgres?');
		expect(io.finalizeWorkspace).toHaveBeenCalledTimes(1);
		expect(outcome.status).toBe('succeeded');
	});

	it('never looks for a question when the job has no model execution', async () => {
		const qfs = questionFs({ [QUESTION_PATH]: '# Not a question — legacy steps run here' });
		const { spawnFn } = recordingSpawn([]);
		const { execution: _execution, acceptanceChecks: _checks, workspace: _workspace, ...rest } = payload;
		const outcome = await runAgentTaskJob(
			job({ ...rest, workspacePath: ABSOLUTE, steps: [{ id: 'lint', command: 'pnpm lint' }] }),
			baseIo({ spawnFn, questionFs: qfs })
		);
		expect('question' in outcome).toBe(false);
		expect(qfs.files.has(QUESTION_PATH)).toBe(true);
		expect(qfs.events).toEqual([]);
	});
});

describe('defaultScratchFs — scratch directories cannot be pre-planted (review follow-up)', () => {
	it('creates a unique directory under the root even when the predictable name is a symlink elsewhere', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-scratch-root-'));
		const elsewhere = mkdtempSync(join(tmpdir(), 'ew-scratch-elsewhere-'));
		// An attacker pre-creates a link at the predictable path.
		await realFs.symlink(elsewhere, join(root, 'job-77'), process.platform === 'win32' ? 'junction' : 'dir');

		const created = await defaultScratchFs.createScratchDir(root, 'job-77');
		try {
			// The created directory is unique (never the planted name) and a
			// real directory under the root, not the link's target.
			expect(created).not.toBe(join(root, 'job-77'));
			expect(created.startsWith(root)).toBe(true);
			const stat = await realFs.lstat(created);
			expect(stat.isDirectory()).toBe(true);
			expect(stat.isSymbolicLink()).toBe(false);
			await defaultScratchFs.writeFile(join(created, 'instructions.md'), 'secret');
			expect(await realFs.readdir(elsewhere)).toEqual([]);
			expect(await defaultScratchFs.readFile(join(created, 'instructions.md'))).toBe('secret');
			expect(await defaultScratchFs.readFile(join(created, 'missing.json'))).toBeNull();
		} finally {
			await defaultScratchFs.remove(created);
			await realFs.rm(root, { recursive: true, force: true });
			await realFs.rm(elsewhere, { recursive: true, force: true });
		}
	});
});

describe('defaultScratchFs — the model output read is bounded', () => {
	/**
	 * `buildModelCliCommand` redirects the CLI's stdout to this file with the
	 * shell's `>`, so it never passes through Node's stdout capture and
	 * nothing upstream bounds it. `MODEL_CLI_OUTPUT_TAIL_BYTES` trims for
	 * DISPLAY, but only after the whole file is already a string in memory —
	 * by which point a looping or compromised CLI has exhausted the process
	 * and taken every other job on the node with it.
	 */
	it('refuses a scratch file larger than the ceiling instead of loading it', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-scratch-big-'));
		const created = await defaultScratchFs.createScratchDir(root, 'job-big');
		const target = join(created, 'model-output.json');
		try {
			await realFs.writeFile(target, 'x'.repeat(MODEL_CLI_MAX_OUTPUT_BYTES + 1));

			await expect(defaultScratchFs.readFile(target)).rejects.toThrowError(/Refusing to load it/);
		} finally {
			await defaultScratchFs.remove(created);
			await realFs.rm(root, { recursive: true, force: true });
		}
	});

	it('still reads a file at the ceiling', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-scratch-ok-'));
		const created = await defaultScratchFs.createScratchDir(root, 'job-ok');
		const target = join(created, 'model-output.json');
		try {
			// Exactly at the bound is allowed — the check is a ceiling, not a
			// budget, so an ordinary chatty run is never refused.
			await realFs.writeFile(target, 'y'.repeat(MODEL_CLI_MAX_OUTPUT_BYTES));
			const read = await defaultScratchFs.readFile(target);
			expect(read).toHaveLength(MODEL_CLI_MAX_OUTPUT_BYTES);
		} finally {
			await defaultScratchFs.remove(created);
			await realFs.rm(root, { recursive: true, force: true });
		}
	});
});

describe('defaultScratchFs — the scratch ROOT cannot be pre-planted either (review round 2)', () => {
	const linkType = process.platform === 'win32' ? 'junction' : 'dir';

	it('refuses a root that is itself a symlink or junction to somewhere else', async () => {
		const base = mkdtempSync(join(tmpdir(), 'ew-scratch-base-'));
		const elsewhere = join(base, 'elsewhere');
		await realFs.mkdir(elsewhere);
		// An attacker pre-plants the predictable root name as a link they control.
		const root = join(base, 'agent-tasks');
		await realFs.symlink(elsewhere, root, linkType);
		try {
			await expect(defaultScratchFs.createScratchDir(root, 'job-1')).rejects.toThrowError(/not a real directory/);
			// No job directory appeared where the link points.
			expect(await realFs.readdir(elsewhere)).toEqual([]);
		} finally {
			await realFs.rm(base, { recursive: true, force: true });
		}
	});

	it('refuses a root whose parent below the OS temp dir is a symlink or junction', async () => {
		const base = mkdtempSync(join(tmpdir(), 'ew-scratch-base-'));
		const elsewhere = join(base, 'elsewhere');
		await realFs.mkdir(elsewhere);
		// `<temp>/<base>/ever-works-node` is the link; `agent-tasks` below it
		// is what `mkdir -p` would happily create on the far side.
		const parent = join(base, 'ever-works-node');
		await realFs.symlink(elsewhere, parent, linkType);
		const root = join(parent, 'agent-tasks');
		try {
			await expect(defaultScratchFs.createScratchDir(root, 'job-2')).rejects.toThrowError(/not a real directory/);
			const leaked = await realFs.readdir(join(elsewhere, 'agent-tasks')).catch(() => [] as string[]);
			expect(leaked).toEqual([]);
		} finally {
			await realFs.rm(base, { recursive: true, force: true });
		}
	});

	it('still accepts a real root and creates the job directory inside it', async () => {
		const base = mkdtempSync(join(tmpdir(), 'ew-scratch-base-'));
		const root = join(base, 'ever-works-node', 'agent-tasks');
		try {
			const created = await defaultScratchFs.createScratchDir(root, 'job-3');
			expect(created.startsWith(root)).toBe(true);
			expect((await realFs.lstat(created)).isDirectory()).toBe(true);
		} finally {
			await realFs.rm(base, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === 'win32')('tightens a group/other-accessible pre-existing root to 0700', async () => {
		const base = mkdtempSync(join(tmpdir(), 'ew-scratch-base-'));
		const root = join(base, 'agent-tasks');
		await realFs.mkdir(root, { mode: 0o755 });
		try {
			await defaultScratchFs.createScratchDir(root, 'job-4');
			expect((await realFs.stat(root)).mode & 0o777).toBe(0o700);
		} finally {
			await realFs.rm(base, { recursive: true, force: true });
		}
	});
});
