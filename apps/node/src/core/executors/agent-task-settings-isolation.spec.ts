import { join } from 'node:path';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { describe, expect, it, vi } from 'vitest';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';
import { MODEL_CLI_FLEET_SETTINGS } from './model-cli';

/**
 * Control 17 — a fleet Claude Code run never loads the REPOSITORY's own
 * `.claude/settings*.json`, and no hook runs at all.
 *
 * Measured 2026-10-18 on Claude Code 2.1.302 (Windows): a `SessionStart`
 * hook committed in a repository's `.claude/settings.json` FIRED on exactly
 * the command the node used to build — `claude -p --permission-mode
 * acceptEdits --mcp-config <empty> --strict-mcp-config` — in an untrusted
 * workspace. A hook is a shell command run as the machine owner, whatever the
 * permission mode, so whoever lands a commit in a Work's repository could run
 * code on every enrolled PC. With `--setting-sources user --settings
 * <{"disableAllHooks":true}>` (and with `--restricted`) the same hook did not
 * fire.
 *
 * Pinned here, on the real executor path:
 *
 *   1. A Claude Code run writes the hook-free settings file to SCRATCH and is
 *      spawned with `--setting-sources user --settings <it>`.
 *   2. `--restricted` is added only when the pinned binary ADVERTISES it, and
 *      never alongside skip-permissions.
 *   3. The isolation is GATED: a builder that drops it fails the job before
 *      anything is spawned.
 *   4. A run that cannot write the settings file does not run.
 *   5. Codex is unaffected.
 */

const stub = vi.hoisted(() => ({ dropSettings: false }));

vi.mock('./model-cli', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./model-cli')>();
	return {
		...actual,
		buildModelCliCommand: (input: Parameters<typeof actual.buildModelCliCommand>[0]) => {
			if (!stub.dropSettings) return actual.buildModelCliCommand(input);
			// The regression a refactor would introduce: the node wrote the
			// settings file and then never handed it to the builder.
			const { settingsPath: _dropped, ...rest } = input;
			return actual.buildModelCliCommand(rest);
		}
	};
});

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const CODEX = process.platform === 'win32' ? 'C:\\npm\\codex.cmd' : '/usr/local/bin/codex';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';
const SETTINGS_PAIR = / --setting-sources user --settings "([^"]+)" /;

const descriptor: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: false
};

const basePayload = {
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
		provider: 'claude-code' as const,
		instructions: '# Task\nFix the thing.',
		permissionMode: 'acceptEdits' as const
	}
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-17',
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
	session_id: 'sess-1'
});

function scratchFs(failOn?: (path: string) => boolean) {
	const files = new Map<string, string>();
	const writes: Array<{ path: string; content: string }> = [];
	const removed: string[] = [];
	const fs: AgentTaskScratchFs = {
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			if (failOn?.(path))
				throw Object.assign(new Error(`ENOSPC: no space left on device, open '${path}'`), {
					code: 'ENOSPC'
				});
			writes.push({ path, content });
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? claudeEnvelope : (files.get(path) ?? null)),
		remove: async (path) => {
			removed.push(path);
			for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key);
		}
	};
	return { fs, files, writes, removed };
}

function questionFs(): AgentTaskQuestionFs {
	return { readHead: async () => null, remove: async () => undefined, removeDirIfEmpty: async () => undefined };
}

function recordingSpawn() {
	const commands: string[] = [];
	const spawnFn = ((command: string) => {
		commands.push(command);
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
	return { commands, spawnFn };
}

/** A compat probe answering with exactly these advertised flags (null = help not recognised). */
function compat(flags: string[] | null): AgentTaskIo['modelCliCompat'] {
	return async () => ({ version: '2.1.302', supportedFlags: flags ? new Set(flags) : null });
}

function io(over: Partial<AgentTaskIo> = {}): AgentTaskIo {
	return {
		directoryExists: () => true,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 1
		})),
		modelCli: { 'claude-code': CLAUDE, codex: CODEX },
		scratchRoot: SCRATCH,
		questionFs: questionFs(),
		...over
	};
}

describe('runAgentTaskJob — control 17: the repository’s Claude Code settings never load', () => {
	it('writes the hook-free settings file to scratch and spawns claude with --setting-sources user --settings <it>', async () => {
		stub.dropSettings = false;
		const scratch = scratchFs();
		const { commands, spawnFn } = recordingSpawn();

		const outcome = await runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }));

		expect(outcome.status).toBe('succeeded');
		const settingsWrites = scratch.writes.filter((write) => write.path.endsWith('claude-settings.json'));
		expect(settingsWrites).toHaveLength(1);
		expect(settingsWrites[0]?.content).toBe(MODEL_CLI_FLEET_SETTINGS);
		expect(JSON.parse(settingsWrites[0]?.content ?? 'null')).toEqual({ disableAllHooks: true });
		const settingsPath = SETTINGS_PAIR.exec(commands[0] ?? '')?.[1];
		expect(settingsPath).toBe(settingsWrites[0]?.path);
		// In scratch — never the worktree, so it is never committed — and removed with it.
		expect(settingsPath?.startsWith(SCRATCH)).toBe(true);
		expect(settingsPath?.startsWith(ABSOLUTE)).toBe(false);
		expect(scratch.files.has(settingsPath ?? '')).toBe(false);
		// Never a source list that would let the project settings back in.
		expect(commands[0]).not.toMatch(/--setting-sources [^ ]*project/);
		expect(commands[0]).not.toMatch(/--setting-sources [^ ]*local/);
	});

	it('adds --restricted when the pinned binary advertises it', async () => {
		stub.dropSettings = false;
		const { commands, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job(basePayload),
			io({ spawnFn, scratchFs: scratchFs().fs, modelCliCompat: compat(['-p', '--restricted', '--settings']) })
		);

		expect(commands[0]).toContain(' --restricted ');
		expect(commands[0]).toMatch(SETTINGS_PAIR);
	});

	it('leaves --restricted off when the machine owner switched restricted mode off locally', async () => {
		stub.dropSettings = false;
		const { commands, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job(basePayload),
			io({
				spawnFn,
				scratchFs: scratchFs().fs,
				modelCliCompat: compat(['-p', '--restricted']),
				executionPolicy: { allowSkipPermissions: false, allowShellCommands: false, restrictedMode: false }
			})
		);

		expect(commands[0]).not.toContain('--restricted');
		// The baseline isolation is not part of that switch.
		expect(commands[0]).toMatch(SETTINGS_PAIR);
	});

	it('never passes --restricted to a binary that does not advertise it, or whose help was not recognised', async () => {
		stub.dropSettings = false;
		for (const flags of [['-p', '--settings'], null]) {
			const { commands, spawnFn } = recordingSpawn();
			await runAgentTaskJob(
				job(basePayload),
				io({ spawnFn, scratchFs: scratchFs().fs, modelCliCompat: compat(flags) })
			);
			expect(commands[0]).not.toContain('--restricted');
			// The baseline isolation holds either way.
			expect(commands[0]).toMatch(SETTINGS_PAIR);
		}
	});

	it('never combines --restricted with skip-permissions (the CLI refuses the pair)', async () => {
		stub.dropSettings = false;
		const { commands, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job({ ...basePayload, execution: { ...basePayload.execution, skipPermissions: true } }),
			io({ spawnFn, scratchFs: scratchFs().fs, modelCliCompat: compat(['-p', '--restricted']) })
		);

		expect(commands[0]).toContain('--dangerously-skip-permissions');
		expect(commands[0]).not.toContain('--restricted');
		// Hooks are still off on a skip-permissions run.
		expect(commands[0]).toMatch(SETTINGS_PAIR);
	});

	it('refuses to spawn when the built command does not carry the settings isolation (the gate is wired)', async () => {
		stub.dropSettings = true;
		try {
			const scratch = scratchFs();
			const { commands, spawnFn } = recordingSpawn();

			await expect(
				runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }))
			).rejects.toThrowError(/does not carry --setting-sources user --settings <file>/);
			expect(commands).toHaveLength(0);
			expect(scratch.removed.some((path) => path.startsWith(SCRATCH))).toBe(true);
		} finally {
			stub.dropSettings = false;
		}
	});

	it('does not run at all when the settings file cannot be written — and still removes scratch', async () => {
		stub.dropSettings = false;
		const scratch = scratchFs((path) => path.endsWith('claude-settings.json'));
		const { commands, spawnFn } = recordingSpawn();

		await expect(runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }))).rejects.toThrowError(
			/ENOSPC/
		);
		expect(commands).toHaveLength(0);
		expect(scratch.removed.some((path) => path.startsWith(SCRATCH))).toBe(true);
	});

	it('leaves codex untouched: no settings file, no Claude settings flags', async () => {
		stub.dropSettings = false;
		const scratch = scratchFs();
		const { commands, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job({ ...basePayload, execution: { ...basePayload.execution, provider: 'codex' } }),
			io({ spawnFn, scratchFs: scratch.fs, modelCliCompat: compat(['--json', '--restricted']) })
		);

		expect(commands[0]).toContain(' exec --ignore-user-config --json ');
		expect(commands[0]).not.toContain('--setting-sources');
		expect(commands[0]).not.toContain('--restricted');
		expect(scratch.writes.some((write) => write.path.endsWith('claude-settings.json'))).toBe(false);
	});
});
