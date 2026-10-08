import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAgentTaskModelResult, FleetJobView } from '@ever-works/contracts';
import { runAgentTaskJob, type AgentTaskScratchFs } from './agent-task';
import type { NodeCheckResult } from './acceptance-checks';
import { parseModelCliResult, redactCommandResult } from './model-cli';
import { createModelTranscriptRecorder } from './model-transcript';

/**
 * Self-build slice AP, review round 1 — what the switch to Claude Code's
 * `stream-json` output could leak, and the fixes that close it.
 *
 *   1. A run that dies before its `result` line used to leave an EMPTY
 *      stdout (the `json` document is printed at exit), so its output tail
 *      was stderr. A stream is every turn, tool RESULTS included — the tail
 *      must stay "what the model said + stderr", never raw file bodies.
 *   2. Inside a JSON stream a delivered `.env` value is written ESCAPED
 *      (`"` → `\"`, `\` → `\\`); a verbatim match never finds it there.
 *      Every reported text is scrubbed of the escaped spellings too.
 *   3. The session id still comes ONLY from the `result` envelope — slice
 *      AU's "the resumed session never opened" test reads its absence.
 *   4. A transcript KEY and a call id are cleaned like values.
 *   5. A bounded reader that cannot size the file falls back to readFile.
 */

const FILE_BODY = 'export const TOP_SECRET_FILE_BODY = 42;';
/** A delivered `.env` value JSON has to escape — a quote and a backslash. */
const ESCAPED_VALUE = 'pa"ss\\word-9f2c-delivered';
const ESCAPED_IN_JSON = JSON.stringify(ESCAPED_VALUE).slice(1, -1);
const DOUBLE_ESCAPED_IN_JSON = JSON.stringify(ESCAPED_IN_JSON).slice(1, -1);

const step = (over: Partial<NodeCheckResult> = {}): NodeCheckResult => ({
	id: 'model',
	status: 'red',
	exitCode: 1,
	durationMs: 10,
	logTail: 'claude: fatal: connection reset',
	...over
});

/** A Claude Code stream that died before its `result` line. */
function diedMidRun(): string {
	return (
		[
			{ type: 'system', subtype: 'init', session_id: 'init-session-should-not-count' },
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the config.' }] } },
			{
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'apps/api/.env' } }]
				}
			},
			{
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_1',
							content: `${FILE_BODY}\nPASSWORD=${ESCAPED_VALUE}`
						}
					]
				}
			},
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'Now running the tests.' }] } }
		]
			.map((line) => JSON.stringify(line))
			.join('\n') + '\n'
	);
}

describe('parseModelCliResult — Claude Code stream output (review)', () => {
	it('tails what the model SAID plus stderr — never the raw stream with its tool results', () => {
		const model = parseModelCliResult('claude-code', diedMidRun(), step(), [], [], {}, [ESCAPED_VALUE]);
		expect(model.summary).toBeNull();
		expect(model.outputTail).toBe('Reading the config.\nNow running the tests.\nclaude: fatal: connection reset');
		expect(model.outputTail).not.toContain('TOP_SECRET_FILE_BODY');
		expect(model.outputTail).not.toContain('tool_result');
	});

	it('takes the session id from the result envelope ONLY (slice AU reads its absence)', () => {
		const died = parseModelCliResult('claude-code', diedMidRun(), step(), [], [], {}, []);
		expect(died.sessionId ?? null).toBeNull();
		const finished = parseModelCliResult(
			'claude-code',
			`${diedMidRun()}${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-9', total_cost_usd: 0.2, num_turns: 4 })}\n`,
			step({ status: 'green', exitCode: 0 }),
			[],
			[],
			{},
			[]
		);
		expect(finished).toMatchObject({ summary: 'Done.', sessionId: 'sess-9', costUsd: 0.2, turns: 4 });
	});

	it('keeps the single `json` document behaviour byte-for-byte: no stream, the old tail', () => {
		const model = parseModelCliResult('claude-code', 'not json at all', step(), [], [], {}, []);
		expect(model.outputTail).toBe('not json at all\nclaude: fatal: connection reset');
	});
});

describe('protected values are scrubbed in their JSON-escaped spellings too (review)', () => {
	it('from a Codex event tail, where the value is written escaped', () => {
		const codex = `${JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', aggregated_output: `PASSWORD=${ESCAPED_VALUE}` } })}\n`;
		expect(codex).toContain(ESCAPED_IN_JSON);
		const model = parseModelCliResult('codex', codex, step(), [], [], {}, [ESCAPED_VALUE]);
		expect(model.outputTail).toBeDefined();
		expect(model.outputTail).not.toContain(ESCAPED_IN_JSON);
		expect(model.outputTail).not.toContain(ESCAPED_VALUE);
		expect(model.outputTail).toContain('[redacted]');
	});

	it('from a check log tail that printed the value inside JSON, once or twice escaped', () => {
		const result = redactCommandResult(
			step({ logTail: `{"env":"${ESCAPED_IN_JSON}","nested":"{\\"p\\":\\"${DOUBLE_ESCAPED_IN_JSON}\\"}"}` }),
			[],
			{},
			[ESCAPED_VALUE]
		);
		expect(result.logTail).not.toContain(ESCAPED_IN_JSON);
		expect(result.logTail).not.toContain(DOUBLE_ESCAPED_IN_JSON);
		expect(result.logTail).not.toContain('ss\\\\word');
	});
});

describe('createModelTranscriptRecorder — keys and call ids are cleaned (review)', () => {
	it('never carries a protected value as an object KEY or a call id', () => {
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [ESCAPED_VALUE] });
		recorder.feed(
			`${JSON.stringify({
				type: 'assistant',
				message: {
					content: [
						{ type: 'tool_use', id: `toolu_${ESCAPED_VALUE}`, name: 'Mcp', input: { [ESCAPED_VALUE]: 1 } }
					]
				}
			})}\n`,
			null
		);
		const evidence = recorder.finish(null);
		const everything = JSON.stringify(evidence);
		expect(everything).not.toContain(ESCAPED_IN_JSON);
		expect(everything).not.toContain(DOUBLE_ESCAPED_IN_JSON);
		expect(evidence.timeline[0].callId).toBe('toolu_[redacted]');
		expect(evidence.timeline[0].argsSummary).toBe('+[redacted]');
	});

	it("scrubs the escaped spelling in a killed run's half-written last line, whoever built the value list", () => {
		// Raw values, NOT pre-expanded by collectModelOutputProtectedValues:
		// the recorder must be safe on its own. The cut line is not JSON, so
		// it is kept as raw text — where the value is still JSON-escaped.
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [ESCAPED_VALUE] });
		const whole = JSON.stringify({
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 't', content: `PASSWORD=${ESCAPED_VALUE} and more` }]
			}
		});
		recorder.feed(whole.slice(0, whole.indexOf(' and more')), null);
		const evidence = recorder.finish(null);
		expect(evidence.transcript).not.toContain(ESCAPED_IN_JSON);
		expect(evidence.transcript).toContain('[redacted]');
	});
});

describe('runAgentTaskJob — the bounded reader fails open to readFile (review)', () => {
	const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
	const SCRATCH = process.platform === 'win32' ? String.raw`C:\scratch` : '/tmp/ew-scratch';
	const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Read it anyway.' });

	it('a readChunk that throws (a Windows sharing violation) does not fail a run readFile can read', async () => {
		const spawnFn = vi.fn(((_command: string) => {
			const handlers = new Map<string, (arg?: unknown) => void>();
			queueMicrotask(() => handlers.get('close')?.(0));
			return {
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
				kill: () => undefined
			};
		}) as never);
		const scratchFs: AgentTaskScratchFs = {
			createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
			writeFile: async () => undefined,
			readFile: async (path) => (path.endsWith('model-output.json') ? envelope : null),
			remove: async () => undefined,
			mkdir: async () => undefined,
			readChunk: async () => {
				throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
			}
		};
		const job: FleetJobView = {
			id: 'job-rc',
			kind: 'agent-task',
			status: 'leased',
			nodeId: 'node-1',
			requiredCapabilities: [],
			payload: { taskId: 'task-1', execution: { provider: 'claude-code', instructions: '# do it' } },
			leaseExpiresAt: null,
			attempts: 1,
			maxAttempts: 3,
			createdAt: null,
			startedAt: null,
			completedAt: null
		};
		const outcome = (await runAgentTaskJob(job, {
			directoryExists: () => true,
			spawnFn,
			parentEnv: { PATH: '/usr/bin' },
			modelCli: { 'claude-code': process.platform === 'win32' ? 'C:\\cli\\claude.exe' : '/usr/local/bin/claude' },
			scratchRoot: SCRATCH,
			scratchFs,
			workspacePath: ABSOLUTE,
			sessionConfigFs: { readFile: async () => null },
			questionFs: {
				readHead: async () => null,
				remove: async () => undefined,
				removeDirIfEmpty: async () => undefined
			},
			modelTranscriptPollMs: 10
		} as never)) as Record<string, unknown>;
		expect((outcome.model as FleetAgentTaskModelResult).summary).toBe('Read it anyway.');
	});
});
