import { join } from 'node:path';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { describe, expect, it, vi } from 'vitest';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';
import type { McpLoopbackProxy } from './mcp-bridge';
import { MODEL_CLI_EMPTY_MCP_CONFIG } from './model-cli';

/**
 * A fleet model run is isolated from the MACHINE OWNER's own MCP servers,
 * bridge or no bridge.
 *
 * Measured on a production fleet PC (2026-10-09): without the platform MCP
 * bridge the node ran `claude -p` with no `--strict-mcp-config`, and the CLI
 * loaded every server in the owner's `~/.claude.json` (`mcp-atlassian`,
 * `trigger`, `posthog`, `sentry`) plus the account's claude.ai connectors.
 * Under `acceptEdits` the calls were denied; under the tenant opt-in
 * `--dangerously-skip-permissions` every one of those tools would have been
 * callable, with the owner's credentials, by a prompt-injected run.
 *
 * Pinned here, on the real executor path:
 *
 *   1. A no-bridge Claude Code run writes an EMPTY MCP config to SCRATCH and
 *      is spawned with `--mcp-config <it> --strict-mcp-config`; so is a run
 *      whose bridge degraded.
 *   2. Every Claude Code model step's env says `ENABLE_CLAUDEAI_MCP_SERVERS=false`
 *      (bridge or not), whatever the parent exported.
 *   3. The isolation is GATED, not merely computed: a builder that drops it
 *      fails the job before anything is spawned.
 *   4. A run that cannot write the empty config does not run.
 *   5. Codex is unchanged (no supported switch — a documented gap).
 */

const stub = vi.hoisted(() => ({ dropIsolation: false }));

vi.mock('./model-cli', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./model-cli')>();
	return {
		...actual,
		buildModelCliCommand: (input: Parameters<typeof actual.buildModelCliCommand>[0]) => {
			if (!stub.dropIsolation) return actual.buildModelCliCommand(input);
			// The regression a refactor would introduce: the node computed
			// the isolation and then never handed it to the builder.
			const { emptyMcpConfigPath: _dropped, ...rest } = input;
			return actual.buildModelCliCommand(rest);
		}
	};
});

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const CODEX = process.platform === 'win32' ? 'C:\\npm\\codex.cmd' : '/usr/local/bin/codex';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';
const TOKEN = 'ew_run_0123456789abcdef0123456789abcdef';
const PROXY_URL = 'http://127.0.0.1:54321/mcp/aaaabbbbccccdddd0000111122223333';
const STRICT_PAIR = / --mcp-config "([^"]+)" --strict-mcp-config /;

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
		permissionMode: 'acceptEdits' as const,
		skipPermissions: true
	}
};

const bridgeBlock = {
	enabled: true,
	serverUrl: 'https://mcp.example.com/mcp',
	serverName: 'ever-works',
	toolFamilies: ['Tasks']
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-81',
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

/** Scratch double that records every write (in order) and every removal. */
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

/** Spawn double that records the command AND the env the child would get. */
function recordingSpawn() {
	const commands: string[] = [];
	const envs: Array<NodeJS.ProcessEnv | undefined> = [];
	const spawnFn = ((command: string, options: { env?: NodeJS.ProcessEnv }) => {
		commands.push(command);
		envs.push(options?.env);
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
	return { commands, envs, spawnFn };
}

function proxyStart() {
	return vi.fn(
		async (): Promise<McpLoopbackProxy> => ({
			url: PROXY_URL,
			address: '127.0.0.1',
			toolCalls: () => 0,
			close: async () => undefined
		})
	);
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

/** Every case-spelling of `name` in `env`, with its value. */
function spellings(env: NodeJS.ProcessEnv | undefined, name: string): Array<[string, string | undefined]> {
	return Object.entries(env ?? {}).filter(([key]) => key.toUpperCase() === name.toUpperCase());
}

describe('runAgentTaskJob — MCP isolation from the machine owner’s servers', () => {
	it('no bridge: writes an EMPTY config to scratch and spawns claude with it under --strict-mcp-config', async () => {
		stub.dropIsolation = false;
		const scratch = scratchFs();
		const { commands, spawnFn } = recordingSpawn();

		const outcome = await runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }));

		expect(outcome.status).toBe('succeeded');
		const configWrites = scratch.writes.filter((write) => write.path.endsWith('mcp.json'));
		expect(configWrites).toHaveLength(1);
		expect(configWrites[0]?.content).toBe(MODEL_CLI_EMPTY_MCP_CONFIG);
		expect(JSON.parse(configWrites[0]?.content ?? 'null')).toEqual({ mcpServers: {} });
		// The command points at THAT file — in scratch, never the worktree.
		const configPath = STRICT_PAIR.exec(commands[0] ?? '')?.[1];
		expect(configPath).toBe(configWrites[0]?.path);
		expect(configPath?.startsWith(SCRATCH)).toBe(true);
		expect(configPath?.startsWith(ABSOLUTE)).toBe(false);
		expect(commands[0]).not.toContain('--allowedTools');
		// And it is removed with scratch.
		expect(scratch.files.has(configPath ?? '')).toBe(false);
	});

	it('no bridge: the child is told to fetch no claude.ai connectors, whatever the parent exported', async () => {
		stub.dropIsolation = false;
		const { envs, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job(basePayload),
			io({
				spawnFn,
				scratchFs: scratchFs().fs,
				parentEnv: { ...process.env, Enable_ClaudeAI_MCP_Servers: 'true' }
			})
		);

		expect(spellings(envs[0], 'ENABLE_CLAUDEAI_MCP_SERVERS')).toEqual([['ENABLE_CLAUDEAI_MCP_SERVERS', 'false']]);
	});

	it('a bridge that degraded leaves the run isolated by the empty config, not unisolated', async () => {
		stub.dropIsolation = false;
		const scratch = scratchFs();
		const { commands, envs, spawnFn } = recordingSpawn();

		const outcome = await runAgentTaskJob(
			job({ ...basePayload, mcp: bridgeBlock }),
			io({
				spawnFn,
				scratchFs: scratch.fs,
				mcpBridge: {
					mint: async () => {
						throw new Error('Invalid node credential');
					}
				}
			})
		);

		expect(outcome.mcp?.enabled).toBe(false);
		expect(commands[0]).toMatch(STRICT_PAIR);
		expect(commands[0]).not.toContain(PROXY_URL);
		const configWrites = scratch.writes.filter((write) => write.path.endsWith('mcp.json'));
		expect(configWrites.map((write) => write.content)).toEqual([MODEL_CLI_EMPTY_MCP_CONFIG]);
		expect(spellings(envs[0], 'ENABLE_CLAUDEAI_MCP_SERVERS')).toEqual([['ENABLE_CLAUDEAI_MCP_SERVERS', 'false']]);
	});

	it('bridge on: today’s flags exactly once, the bridge config is never overwritten, connectors still off', async () => {
		stub.dropIsolation = false;
		const scratch = scratchFs();
		const { commands, envs, spawnFn } = recordingSpawn();

		const outcome = await runAgentTaskJob(
			job({ ...basePayload, mcp: bridgeBlock }),
			io({
				spawnFn,
				scratchFs: scratch.fs,
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start: proxyStart(),
					scheduleRenewal: () => ({ cancel: () => undefined })
				}
			})
		);

		expect(outcome.mcp?.enabled).toBe(true);
		expect(commands[0]).toMatch(
			/ --mcp-config "[^"]+mcp\.json" --strict-mcp-config --allowedTools mcp__ever-works /
		);
		expect(commands[0]?.match(/--mcp-config/g)).toHaveLength(1);
		const configWrites = scratch.writes.filter((write) => write.path.endsWith('mcp.json'));
		expect(configWrites).toHaveLength(1);
		expect(JSON.parse(configWrites[0]?.content ?? 'null')).toEqual({
			mcpServers: { 'ever-works': { type: 'http', url: PROXY_URL } }
		});
		// `--mcp-config` servers are unaffected by the connector switch
		// (code.claude.com/docs/en/mcp), so it is set on bridge runs too.
		expect(spellings(envs[0], 'ENABLE_CLAUDEAI_MCP_SERVERS')).toEqual([['ENABLE_CLAUDEAI_MCP_SERVERS', 'false']]);
	});

	it('refuses to spawn when the built command does not carry the isolation (the gate is wired)', async () => {
		stub.dropIsolation = true;
		try {
			const scratch = scratchFs();
			const { commands, spawnFn } = recordingSpawn();

			await expect(
				runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }))
			).rejects.toThrowError(/does not carry --mcp-config <file> --strict-mcp-config/);
			expect(commands).toHaveLength(0);
			// Scratch is still removed on the refusal.
			expect(scratch.removed.some((path) => path.startsWith(SCRATCH))).toBe(true);
		} finally {
			stub.dropIsolation = false;
		}
	});

	it('does not run at all when the empty config cannot be written — and still removes scratch', async () => {
		stub.dropIsolation = false;
		const scratch = scratchFs((path) => path.endsWith('mcp.json'));
		const { commands, spawnFn } = recordingSpawn();

		await expect(runAgentTaskJob(job(basePayload), io({ spawnFn, scratchFs: scratch.fs }))).rejects.toThrowError(
			/ENOSPC/
		);
		expect(commands).toHaveLength(0);
		expect(scratch.removed.some((path) => path.startsWith(SCRATCH))).toBe(true);
	});

	it('codex is unchanged: no config written, no MCP flag, no connector switch (documented gap)', async () => {
		stub.dropIsolation = false;
		const scratch = scratchFs();
		const { commands, envs, spawnFn } = recordingSpawn();

		await runAgentTaskJob(
			job({ ...basePayload, execution: { ...basePayload.execution, provider: 'codex' } }),
			io({ spawnFn, scratchFs: scratch.fs })
		);

		expect(commands[0]).toContain(' exec --json ');
		expect(commands[0]).not.toContain('mcp');
		expect(scratch.writes.some((write) => write.path.endsWith('mcp.json'))).toBe(false);
		expect(spellings(envs[0], 'ENABLE_CLAUDEAI_MCP_SERVERS')).toEqual([]);
	});
});
