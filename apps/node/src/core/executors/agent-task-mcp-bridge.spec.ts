import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { join } from 'node:path';
import {
	MCP_CREDENTIAL_RENEWAL_INTERVAL_MS,
	runAgentTaskJob,
	type AgentTaskIo,
	type AgentTaskScratchFs
} from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';
import type { McpLoopbackProxy, McpLoopbackProxyOptions } from './mcp-bridge';
import { createLogger, REDACTED, type LogEntry } from '../logger';

/**
 * `agent-task` with the platform MCP bridge — self-build slice Z (EW-796).
 *
 * The properties that carry the weight, in order of how much it would
 * hurt to lose them:
 *
 *   1. THE TOKEN NEVER LEAVES MEMORY. It is not in the config file the
 *      model reads, not on the command line, not in the child's
 *      environment, not on the job result, and not in any log line.
 *   2. The config lands in SCRATCH and is gone afterwards — so it can
 *      never be staged by `git add -A` and never survives the run.
 *   3. The proxy is stopped and the credential revoked at finalize,
 *      whatever the run's verdict, including when the model step throws.
 *   4. A bridge that cannot start does NOT fail the Task: the run
 *      proceeds exactly as a run without one and says so on the result.
 *   5. A payload with no `mcp` block mints nothing and reports nothing.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';
const TOKEN = 'ew_run_0123456789abcdef0123456789abcdef';
const PROXY_URL = 'http://127.0.0.1:54321/mcp/aaaabbbbccccdddd0000111122223333';

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

function scratchFs(): AgentTaskScratchFs & { files: Map<string, string>; removed: string[] } {
	const files = new Map<string, string>();
	const removed: string[] = [];
	return {
		files,
		removed,
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? claudeEnvelope : (files.get(path) ?? null)),
		remove: async (path) => {
			removed.push(path);
			for (const key of [...files.keys()]) {
				if (key.startsWith(path)) files.delete(key);
			}
		}
	};
}

function questionFs(): AgentTaskQuestionFs {
	return {
		readHead: async () => null,
		remove: async () => undefined,
		removeDirIfEmpty: async () => undefined
	};
}

/** Spawn double that records the command AND the env the child would get. */
function recordingSpawn(onSpawn?: (command: string, env: NodeJS.ProcessEnv | undefined) => void) {
	const commands: string[] = [];
	const envs: Array<NodeJS.ProcessEnv | undefined> = [];
	// `runNodeCommandStep` calls `spawnFn(command, options)` — the options
	// object is the SECOND argument, and `options.env` is the environment
	// the child would actually get.
	const spawnFn = ((command: string, options: { env?: NodeJS.ProcessEnv }) => {
		commands.push(command);
		envs.push(options?.env);
		onSpawn?.(command, options?.env);
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

/** A proxy double whose lifecycle and token reads are observable. */
function proxyDouble(events: string[]) {
	let tokenGetter: (() => string | null) | null = null;
	const start = vi.fn(async (options: McpLoopbackProxyOptions): Promise<McpLoopbackProxy> => {
		events.push(`start:${options.upstreamUrl}`);
		tokenGetter = options.token;
		return {
			url: PROXY_URL,
			address: '127.0.0.1',
			toolCalls: () => 7,
			close: async () => {
				events.push('close');
			}
		};
	});
	return { start, readToken: () => tokenGetter?.() ?? null };
}

const mcpPayload = {
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
		model: 'claude-opus-5',
		envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN']
	},
	mcp: {
		enabled: true,
		serverUrl: 'https://mcp.example.com/mcp',
		serverName: 'ever-works',
		toolFamilies: ['Tasks', 'Inbox']
	}
};

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
		scratchFs: scratchFs(),
		questionFs: questionFs(),
		...over
	};
}

describe('runAgentTaskJob — MCP bridge on', () => {
	it('mints, starts the proxy, writes the config to scratch and passes it to the CLI', async () => {
		const events: string[] = [];
		const { commands, spawnFn } = recordingSpawn();
		const fs = scratchFs();
		const { start } = proxyDouble(events);
		const mint = vi.fn(async () => ({
			token: TOKEN,
			expiresAt: '2026-09-05T12:00:00.000Z',
			serverUrl: 'https://mcp.example.com/mcp'
		}));

		const outcome = await runAgentTaskJob(
			job(mcpPayload),
			baseIo({ spawnFn, scratchFs: fs, mcpBridge: { mint, start } })
		);

		expect(mint).toHaveBeenCalledWith('job-77');
		expect(start).toHaveBeenCalledTimes(1);
		expect(commands[0]).toContain('--mcp-config');
		expect(commands[0]).toContain('mcp.json');
		expect(commands[0]).toContain('--allowedTools mcp__ever-works');
		expect(outcome.status).toBe('succeeded');
		expect(outcome.mcp).toEqual({ enabled: true, toolCalls: 7 });
	});

	it('writes ONLY the loopback URL into the config — no credential, no headers', async () => {
		const events: string[] = [];
		const { spawnFn } = recordingSpawn();
		const fs = scratchFs();
		const written: string[] = [];
		const originalWrite = fs.writeFile;
		fs.writeFile = async (path, content) => {
			if (path.endsWith('mcp.json')) written.push(content);
			return originalWrite(path, content);
		};
		const { start } = proxyDouble(events);

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: fs,
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start
				}
			})
		);

		expect(written).toHaveLength(1);
		const config = JSON.parse(written[0] ?? '{}');
		expect(config).toEqual({ mcpServers: { 'ever-works': { type: 'http', url: PROXY_URL } } });
		expect(written[0]).not.toContain(TOKEN);
		expect(written[0]?.toLowerCase()).not.toContain('authorization');
		expect(written[0]?.toLowerCase()).not.toContain('header');
	});

	it('puts the config in SCRATCH, never in the worktree, and removes it with scratch', async () => {
		const events: string[] = [];
		const { spawnFn } = recordingSpawn();
		const fs = scratchFs();
		const { start } = proxyDouble(events);

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: fs,
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start
				}
			})
		);

		// Nothing is left behind, and nothing was ever written under the
		// worktree — so `git add -A` could not have staged it and the
		// changed-file count is unaffected. No exclude rule is needed
		// because the file was never inside the repository.
		expect(fs.removed.some((path) => path.includes('-scratch'))).toBe(true);
		expect([...fs.files.keys()].some((path) => path.endsWith('mcp.json'))).toBe(false);
		const everWritten = fs.removed.concat([...fs.files.keys()]);
		expect(everWritten.some((path) => path.startsWith(ABSOLUTE))).toBe(false);
	});

	it('never puts the token on the command line or in the child environment', async () => {
		const events: string[] = [];
		const { commands, envs, spawnFn } = recordingSpawn();
		const { start } = proxyDouble(events);

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				parentEnv: {
					PATH: '/usr/bin',
					// Even if someone put the token in the node's own env, the
					// platform-owned pattern refuses to pass it through.
					EVER_WORKS_MCP_TOKEN: TOKEN,
					CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value'
				},
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start
				}
			})
		);

		expect(commands[0]).not.toContain(TOKEN);
		const modelEnv = envs[0] ?? {};
		expect(JSON.stringify(modelEnv)).not.toContain(TOKEN);
		expect(modelEnv.EVER_WORKS_MCP_TOKEN).toBeUndefined();
		// The genuinely granted credential still arrives, so this is not a
		// blanket scrub — it is the platform-owned namespace being refused.
		expect(modelEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-value');
	});

	it('stops the proxy and revokes the credential when the step ends', async () => {
		const events: string[] = [];
		const { spawnFn } = recordingSpawn();
		const { start, readToken } = proxyDouble(events);
		const revoke = vi.fn(async () => {
			events.push('revoke');
		});

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					revoke,
					start
				}
			})
		);

		expect(revoke).toHaveBeenCalledWith('job-77');
		// Close BEFORE revoke: a still-listening socket after the model exits
		// is a live credential path nothing is watching.
		expect(events).toEqual(['start:https://mcp.example.com/mcp', 'close', 'revoke']);
		// And the credential is gone from memory, so a request that somehow
		// arrived now would be refused locally rather than forwarded.
		expect(readToken()).toBeNull();
	});

	it('stops and revokes even when the model step throws', async () => {
		const events: string[] = [];
		const { start } = proxyDouble(events);
		const revoke = vi.fn(async () => {
			events.push('revoke');
		});
		const explodingFs = scratchFs();
		explodingFs.readFile = async () => {
			throw new Error('scratch vanished');
		};

		await expect(
			runAgentTaskJob(
				job(mcpPayload),
				baseIo({
					spawnFn: recordingSpawn().spawnFn,
					scratchFs: explodingFs,
					mcpBridge: {
						mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
						revoke,
						start
					}
				})
			)
		).rejects.toThrow('scratch vanished');

		expect(events).toContain('close');
		expect(revoke).toHaveBeenCalledWith('job-77');
	});

	it('prefers the freshly minted serverUrl over the payload copy', async () => {
		const events: string[] = [];
		const { start } = proxyDouble(events);
		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn: recordingSpawn().spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => ({
						token: TOKEN,
						expiresAt: 'x',
						serverUrl: 'https://mcp-2.example.com/mcp'
					}),
					start
				}
			})
		);
		expect(events[0]).toBe('start:https://mcp-2.example.com/mcp');
	});
});

/**
 * Self-build slice Z — the renewal loop.
 *
 * The token expires with the LEASE it was minted under (300 s by default)
 * while a model step may run for half an hour. Binding the two is the
 * point, so the answer is a shorter loop rather than a longer token: the
 * node re-mints on a timer, the platform rotates (deactivating the
 * predecessor), and the proxy's getter picks the new one up on its very
 * next request without restarting anything.
 */
describe('runAgentTaskJob — MCP credential renewal', () => {
	/** A controllable stand-in for `setInterval`. */
	function manualScheduler() {
		let scheduled: { fn: () => void; intervalMs: number } | null = null;
		let cancelled = 0;
		return {
			intervalMs: () => scheduled?.intervalMs ?? null,
			cancelled: () => cancelled,
			scheduled: () => scheduled !== null,
			tick: () => scheduled?.fn(),
			scheduleRenewal: (fn: () => void, intervalMs: number) => {
				scheduled = { fn, intervalMs };
				return {
					cancel: () => {
						cancelled += 1;
					}
				};
			}
		};
	}

	it('re-mints on the timer and the proxy picks up the new token immediately', async () => {
		const events: string[] = [];
		const { start, readToken } = proxyDouble(events);
		const scheduler = manualScheduler();
		let issued = 0;
		const mint = vi.fn(async () => ({
			token: `ew_run_rotated${++issued}`,
			expiresAt: 'x',
			serverUrl: 'https://mcp.example.com/mcp'
		}));

		// Renew from inside the model step, while the proxy is still up.
		const spawnFn = recordingSpawn(() => {
			expect(readToken()).toBe('ew_run_rotated1');
			scheduler.tick();
		}).spawnFn;

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: { mint, start, scheduleRenewal: scheduler.scheduleRenewal }
			})
		);

		expect(mint).toHaveBeenCalledTimes(2);
		expect(scheduler.intervalMs()).toBe(MCP_CREDENTIAL_RENEWAL_INTERVAL_MS);
	});

	it('renews well inside the default lease TTL', () => {
		// The node does not know the platform's lease policy, so the
		// interval is chosen against the DEFAULT TTL (300 s) plus its grace
		// rather than against whatever this job happened to get.
		expect(MCP_CREDENTIAL_RENEWAL_INTERVAL_MS).toBeGreaterThan(0);
		expect(MCP_CREDENTIAL_RENEWAL_INTERVAL_MS).toBeLessThan(300_000 / 2);
	});

	it('keeps the run alive when a renewal fails — the current token just ages out', async () => {
		const events: string[] = [];
		const { start } = proxyDouble(events);
		const scheduler = manualScheduler();
		const mint = vi
			.fn()
			.mockResolvedValueOnce({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' })
			.mockRejectedValue(new Error('platform unreachable'));

		const spawnFn = recordingSpawn(() => scheduler.tick()).spawnFn;

		const outcome = await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: { mint, start, scheduleRenewal: scheduler.scheduleRenewal }
			})
		);

		expect(outcome.status).toBe('succeeded');
		expect(outcome.mcp?.enabled).toBe(true);
	});

	it('cancels the timer at finalize, so nothing can put a fresh token back', async () => {
		const events: string[] = [];
		const { start, readToken } = proxyDouble(events);
		const scheduler = manualScheduler();

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn: recordingSpawn().spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start,
					scheduleRenewal: scheduler.scheduleRenewal
				}
			})
		);

		expect(scheduler.cancelled()).toBe(1);
		expect(readToken()).toBeNull();
	});

	it('schedules no timer at all when the bridge never came up', async () => {
		const scheduler = manualScheduler();

		await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn: recordingSpawn().spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => {
						throw new Error('Invalid node credential');
					},
					scheduleRenewal: scheduler.scheduleRenewal
				}
			})
		);

		expect(scheduler.scheduled()).toBe(false);
	});
});

describe('runAgentTaskJob — MCP bridge degradation', () => {
	it('runs exactly as today when the mint is refused, and says why', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const outcome = await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => {
						throw new Error('Invalid node credential');
					}
				}
			})
		);

		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).not.toContain('--mcp-config');
		expect(outcome.mcp?.enabled).toBe(false);
		expect(outcome.mcp?.unavailableReason).toContain('Invalid node credential');
	});

	it('degrades when the listener cannot start', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const outcome = await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(),
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start: async () => {
						throw new Error('EADDRINUSE');
					}
				}
			})
		);
		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).not.toContain('--mcp-config');
		expect(outcome.mcp).toEqual({
			enabled: false,
			toolCalls: null,
			unavailableReason: 'EADDRINUSE'
		});
	});

	it('degrades when the node has no job client to mint with', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const outcome = await runAgentTaskJob(job(mcpPayload), baseIo({ spawnFn, scratchFs: scratchFs() }));
		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).not.toContain('--mcp-config');
		expect(outcome.mcp?.enabled).toBe(false);
	});

	it('redacts the token out of a failure message that happened to carry it', async () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ sink: (entry) => entries.push(entry) });
		const outcome = await runAgentTaskJob(
			job(mcpPayload),
			baseIo({
				spawnFn: recordingSpawn().spawnFn,
				scratchFs: scratchFs(),
				logger,
				mcpBridge: {
					mint: async () => ({ token: TOKEN, expiresAt: 'x', serverUrl: 'https://mcp.example.com/mcp' }),
					start: async () => {
						throw new Error(`listen failed while holding ${TOKEN}`);
					}
				}
			})
		);

		const logged = entries.map((entry) => entry.message).join('\n');
		expect(logged).not.toContain(TOKEN);
		expect(logged).toContain(REDACTED);
		// And it does not reach the job result either.
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
		expect(outcome.mcp?.unavailableReason).toContain(REDACTED);
	});
});

describe('runAgentTaskJob — no MCP block', () => {
	it('mints nothing, starts nothing and reports no mcp key at all', async () => {
		const mint = vi.fn();
		const start = vi.fn();
		const { commands, spawnFn } = recordingSpawn();
		const { mcp: _omitted, ...withoutMcp } = mcpPayload;

		const outcome = await runAgentTaskJob(
			job(withoutMcp),
			baseIo({ spawnFn, scratchFs: scratchFs(), mcpBridge: { mint: mint as never, start: start as never } })
		);

		expect(mint).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(commands[0]).not.toContain('--mcp-config');
		expect('mcp' in outcome).toBe(false);
		expect(outcome.status).toBe('succeeded');
	});

	it.each([
		{ enabled: false, serverUrl: 'https://mcp.example.com/mcp', serverName: 'ever-works' },
		{ enabled: true, serverUrl: '', serverName: 'ever-works' },
		{ enabled: true, serverUrl: 'https://mcp.example.com/mcp', serverName: '' },
		null
	])('treats a disabled or malformed mcp block as no bridge (%j)', async (mcp) => {
		const mint = vi.fn();
		const { commands, spawnFn } = recordingSpawn();
		const outcome = await runAgentTaskJob(
			job({ ...mcpPayload, mcp }),
			baseIo({ spawnFn, scratchFs: scratchFs(), mcpBridge: { mint: mint as never } })
		);
		expect(mint).not.toHaveBeenCalled();
		expect(commands[0]).not.toContain('--mcp-config');
		expect('mcp' in outcome).toBe(false);
	});
});
