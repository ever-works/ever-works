import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAgentTaskModelResult, FleetJobView } from '@ever-works/contracts';
import { runAgentTaskJob, type AgentTaskScratchFs } from './agent-task';
import { fitNodeOutcomeToResultBudget } from './acceptance-checks';
import { MODEL_CLI_MAX_OUTPUT_BYTES } from './model-cli';

/**
 * Run evidence end to end through the executor (self-build slice AP).
 *
 *   1. A Claude Code run is asked for its line-delimited stream, and its
 *      step records and redacted transcript ride on `result.model`.
 *   2. A DELIVERED `.env` value — one that lives in no environment, so a
 *      redactor keyed on names is blind to it (lesson 12) — never reaches
 *      either artefact, even when the model echoes it in a command, a
 *      message and a tool output.
 *   3. `modelTranscript: 'off'` is the exact pre-slice node.
 *   4. A stream that outgrew the output ceiling no longer fails the run:
 *      its END is read for the verdict.
 *   5. The result fitter sheds the transcript, then the timeline, before
 *      it would let a result exceed the platform's cap.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? String.raw`C:\cli\claude.exe` : '/usr/local/bin/claude';
const SCRATCH = process.platform === 'win32' ? String.raw`C:\scratch` : '/tmp/ew-scratch';
const FILE_VALUE = 'postgres://file-user:file-s3cret@db.internal/app';
const ROW = '22222222-2222-4222-8222-222222222222';

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-ap',
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

const workspace = {
	repositoryId: 'ever/repository',
	repoUrl: 'https://github.com/ever/repository.git',
	baseRef: 'develop',
	branch: 'task/platform-task-12345678',
	envFilesRef: [{ repoConnectionId: ROW, paths: ['apps/api/.env'] }]
};
const descriptor = {
	path: ABSOLUTE,
	repositoryId: workspace.repositoryId,
	baseRef: workspace.baseRef,
	branch: workspace.branch,
	baseSha: 'a'.repeat(40),
	headSha: 'b'.repeat(40),
	reused: false
};

/** What the model "printed": the value echoed in a command, a tool output and a message. */
function streamEchoing(value: string): string {
	return (
		[
			{ type: 'system', subtype: 'init', session_id: 'sess-ap' },
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Checking the database first.' },
						{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `psql ${value}` } }
					]
				}
			},
			{
				type: 'user',
				message: {
					content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `connected to ${value}` }]
				}
			},
			{ type: 'assistant', message: { content: [{ type: 'text', text: `It was ${value}.` }] } },
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Implemented the change.',
				total_cost_usd: 0.25,
				num_turns: 2,
				session_id: 'sess-ap'
			}
		]
			.map((line) => JSON.stringify(line))
			.join('\n') + '\n'
	);
}

function scratchFs(modelOutput: string | null, extra: Partial<AgentTaskScratchFs> = {}): AgentTaskScratchFs {
	return {
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async () => undefined,
		readFile: async (path) => (path.endsWith('model-output.json') ? modelOutput : null),
		remove: async () => undefined,
		mkdir: async () => undefined,
		...extra
	};
}

function recordingSpawn() {
	const commands: string[] = [];
	const spawnFn = vi.fn(((command: string) => {
		commands.push(command);
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		return {
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
			kill: () => undefined
		};
	}) as never);
	return { commands, spawnFn };
}

function io(modelOutput: string | null, overrides: Record<string, unknown> = {}) {
	const spawn = recordingSpawn();
	return {
		commands: spawn.commands,
		deps: {
			directoryExists: (path: string) => path === ABSOLUTE,
			provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
			finalizeWorkspace: vi.fn(async () => ({
				pushed: true,
				headSha: 'c'.repeat(40),
				empty: false,
				changedFiles: 1
			})),
			fetchRunEnvFiles: vi
				.fn()
				.mockResolvedValue([
					{ repoConnectionId: ROW, path: 'apps/api/.env', content: `DATABASE_URL=${FILE_VALUE}\n` }
				]),
			writeRunEnvFiles: vi.fn(async () => 1),
			removeRunEnvFiles: vi.fn(async () => 1),
			spawnFn: spawn.spawnFn,
			parentEnv: { PATH: '/usr/bin' },
			modelCli: { 'claude-code': CLAUDE },
			scratchRoot: SCRATCH,
			scratchFs: scratchFs(modelOutput),
			sessionConfigFs: { readFile: async () => null },
			questionFs: {
				readHead: async () => null,
				remove: async () => undefined,
				removeDirIfEmpty: async () => undefined
			},
			...overrides
		}
	};
}

const payload = {
	taskId: 'task-1',
	runId: 'run-1',
	workspace,
	execution: { provider: 'claude-code', instructions: '# do it' }
};

async function run(modelOutput: string | null, overrides: Record<string, unknown> = {}) {
	const { commands, deps } = io(modelOutput, overrides);
	const outcome = (await runAgentTaskJob(job(payload), deps as never)) as Record<string, unknown>;
	return { commands, outcome, model: outcome.model as FleetAgentTaskModelResult };
}

describe('runAgentTaskJob — run evidence (self-build slice AP)', () => {
	it('asks Claude Code for its stream and reports step records and a transcript beside the verdict', async () => {
		const { commands, model, outcome } = await run(streamEchoing('nothing-secret-here'));
		expect(commands[0]).toContain('-p --output-format stream-json --verbose --permission-mode acceptEdits');
		// The verdict is read off the stream's last line, exactly as before.
		expect(outcome.status).toBe('succeeded');
		expect(model).toMatchObject({
			status: 'succeeded',
			summary: 'Implemented the change.',
			costUsd: 0.25,
			turns: 2
		});
		expect(model.timeline?.map((step) => step.toolName ?? step.text)).toEqual([
			'Checking the database first.',
			'Bash',
			'It was nothing-secret-here.'
		]);
		expect(model.timeline?.[1]).toMatchObject({ status: 'ok', argsSummary: 'command=psql nothing-secret-here' });
		// Read after the CLI exited (this scratch seam has no `readChunk`):
		// no live observation, so no timings are claimed.
		expect(model.timeline?.every((step) => step.atMs === null)).toBe(true);
		expect(model.transcript?.split('\n')).toHaveLength(5);
		expect(model.transcriptSourceBytes).toBeGreaterThan(0);
	});

	it('never lets a DELIVERED .env value reach the step records or the transcript', async () => {
		const { model, outcome } = await run(streamEchoing(FILE_VALUE));
		const reported = JSON.stringify(outcome);
		expect(reported).not.toContain(FILE_VALUE);
		expect(reported).not.toContain('file-s3cret');
		expect(model.timeline?.[1].argsSummary).toBe('command=psql [redacted]');
		expect(model.timeline?.[2].text).toBe('It was [redacted].');
		expect(model.transcript).toContain('[redacted]');
	});

	it("restores the exact pre-slice command and result shape with modelTranscript: 'off'", async () => {
		const legacyEnvelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
		const { commands, model } = await run(legacyEnvelope, { modelTranscript: 'off' });
		expect(commands[0]).toContain('-p --output-format json --permission-mode acceptEdits');
		expect(commands[0]).not.toContain('stream-json');
		expect(model).not.toHaveProperty('timeline');
		expect(model).not.toHaveProperty('transcript');
		expect(model).not.toHaveProperty('transcriptSourceBytes');
	});

	it('observes the stream LIVE through readChunk, and reads only the END of a stream past the output ceiling', async () => {
		const stream = Buffer.from(streamEchoing('x'), 'utf8');
		// Padding lines in front push the file past the ceiling; the verdict
		// sits on the last line, inside the window that is read.
		const padLine = Buffer.from(
			`${JSON.stringify({ type: 'system', subtype: 'noise', pad: 'p'.repeat(900) })}\n`,
			'utf8'
		);
		const padCount = Math.ceil((MODEL_CLI_MAX_OUTPUT_BYTES + 1024) / padLine.length);
		const file = Buffer.concat([...Array.from({ length: padCount }, () => padLine), stream]);
		const readFile = vi.fn(async () => {
			throw new Error('readFile must not be used for an oversize stream');
		});
		const { model, outcome } = await run(null, {
			scratchFs: scratchFs(null, {
				readFile,
				readChunk: async (_path: string, start: number, maxBytes: number) => ({
					bytes: file.subarray(start, start + maxBytes),
					size: file.length
				})
			}),
			modelTranscriptPollMs: 10
		});
		expect(file.length).toBeGreaterThan(MODEL_CLI_MAX_OUTPUT_BYTES);
		expect(readFile).not.toHaveBeenCalled();
		expect(outcome.status).toBe('succeeded');
		expect(model.summary).toBe('Implemented the change.');
		// Every step was seen live, and stamped.
		expect(model.timeline?.map((step) => step.toolName ?? step.text)).toEqual([
			'Checking the database first.',
			'Bash',
			'It was x.'
		]);
		expect(model.timeline?.every((step) => typeof step.atMs === 'number')).toBe(true);
		expect(model.transcriptSourceBytes).toBe(file.length);
	});
});

describe('fitNodeOutcomeToResultBudget — run evidence (self-build slice AP)', () => {
	const steps = Array.from({ length: 50 }, (_, i) => ({
		kind: 'tool-call',
		atMs: i,
		toolName: 'Read',
		status: 'ok'
	}));

	it('sheds the transcript, keeping its END, before anything else is touched', () => {
		const outcome = {
			status: 'succeeded',
			model: { summary: 'ok', timeline: steps, transcript: `HEAD${'t'.repeat(40_000)}END` }
		};
		const fitted = fitNodeOutcomeToResultBudget(outcome, 20_000);
		expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(20_000);
		expect(fitted.model.timeline).toHaveLength(50);
		expect(fitted.model.transcript.endsWith('END')).toBe(true);
		expect(fitted.model.transcript.startsWith('HEAD')).toBe(false);
	});

	it('drops the timeline as a LAST resort, and says how many steps it dropped', () => {
		const outcome = {
			status: 'succeeded',
			git: { branch: 'task/x', pushed: true },
			model: { summary: 'ok', timeline: steps, timelineDropped: 3 }
		};
		const fitted = fitNodeOutcomeToResultBudget(outcome, 600) as unknown as {
			git: unknown;
			model: Record<string, unknown>;
		};
		expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(600);
		expect(fitted.model.timeline).toBeUndefined();
		expect(fitted.model.timelineDropped).toBe(53);
		// The verdict and the branch survive.
		expect(fitted.git).toEqual({ branch: 'task/x', pushed: true });
	});
});
