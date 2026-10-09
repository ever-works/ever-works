import { describe, expect, it } from 'vitest';
import {
	FLEET_AGENT_TASK_TIMELINE_MAX_BYTES,
	FLEET_AGENT_TASK_TIMELINE_MAX_STEPS,
	FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES,
	normalizeFleetAgentTaskTimeline
} from '@ever-works/contracts';
import {
	createModelTranscriptRecorder,
	MODEL_TRANSCRIPT_MAX_LINE_BYTES,
	observeModelOutput,
	summarizeArgs,
	type ModelOutputChunkReader
} from './model-transcript';

/**
 * Run evidence of a fleet model step (self-build slice AP).
 *
 * What would hurt most to lose, in order:
 *
 *   1. NOTHING the run was given leaks: a delivered `.env` value, a granted
 *      env value or a token the pattern scanner knows never survives into a
 *      step record or the transcript — including when it sits inside a JSON
 *      string where it is escaped.
 *   2. No FILE BODY and no TOOL OUTPUT reaches either artefact.
 *   3. Both stay inside their caps however long the run was, and the
 *      recorder's memory does not grow with the stream.
 *   4. The step records are right: names, summaries, statuses, durations.
 */

const FILE_BODY = 'export const TOP_SECRET_FILE_BODY = 42; // this text must never leave the machine';
const ENV_VALUE = 'postgres://file-user:file-s3cret@db.internal/app';
const QUOTED_ENV_VALUE = 'pa"ss\\word-with-escapes-123';
const WORKSPACE = process.platform === 'win32' ? 'C:\\fleet\\repositories\\task-1' : '/fleet/repositories/task-1';

function claudeStream(): string {
	const lines = [
		{ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5', cwd: WORKSPACE },
		{
			type: 'assistant',
			message: {
				content: [
					{ type: 'thinking', thinking: 'private reasoning that is not reported', signature: 'sig' },
					{ type: 'text', text: `I will read the config at ${WORKSPACE}/apps/api/.env first.` },
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'Bash',
						input: { command: `psql ${ENV_VALUE} -c "select 1"`, description: 'Probe the db' }
					}
				]
			}
		},
		{
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_1',
						content: `connected to ${ENV_VALUE}`,
						is_error: true
					}
				]
			},
			tool_use_result: { stdout: `connected to ${ENV_VALUE}`, stderr: '' }
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						id: 'toolu_2',
						name: 'Write',
						input: { file_path: `${WORKSPACE}/src/a.ts`, content: FILE_BODY }
					}
				]
			}
		},
		{
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: FILE_BODY }] }]
			}
		},
		{
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: `Done. The token was ghp_${'a'.repeat(36)} and ${QUOTED_ENV_VALUE}.` }]
			}
		},
		{
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'Implemented the change.',
			total_cost_usd: 0.5,
			num_turns: 3,
			session_id: 'sess-1'
		}
	];
	return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function record(stream: string, protectedValues: string[] = [ENV_VALUE, QUOTED_ENV_VALUE]) {
	const recorder = createModelTranscriptRecorder({
		provider: 'claude-code',
		protectedValues,
		workspacePath: WORKSPACE
	});
	recorder.feed(stream, null);
	return recorder.finish(null);
}

describe('createModelTranscriptRecorder — claude-code stream-json', () => {
	it('records each assistant message and tool call, with the call statuses its results report', () => {
		const evidence = record(claudeStream());
		expect(evidence.timelineDropped).toBe(0);
		expect(evidence.timeline.map((step) => [step.kind, step.toolName ?? null, step.status ?? null])).toEqual([
			['assistant-message', null, null],
			['tool-call', 'Bash', 'error'],
			['tool-call', 'Write', 'ok'],
			['assistant-message', null, null]
		]);
		const [, bash, write] = evidence.timeline;
		expect(bash.callId).toBe('toolu_1');
		expect(bash.argsSummary).toContain('command=psql [redacted]');
		expect(bash.argsSummary).toContain('description=Probe the db');
		// The workspace is rewritten to `.`; the BODY key is listed by name only.
		expect(write.argsSummary).toBe('file_path=./src/a.ts +content');
		expect(evidence.transcriptSourceBytes).toBe(Buffer.byteLength(claudeStream(), 'utf8'));
	});

	it('NEVER carries a protected value, an escaped one, a known token pattern, a file body or a tool output', () => {
		const evidence = record(claudeStream());
		const everything = JSON.stringify(evidence);
		expect(everything).not.toContain(ENV_VALUE);
		expect(everything).not.toContain('file-s3cret');
		// The quoted value appears JSON-ESCAPED inside a transcript line; it
		// is scrubbed before serialization, so neither spelling survives.
		expect(everything).not.toContain(QUOTED_ENV_VALUE);
		expect(everything).not.toContain(JSON.stringify(QUOTED_ENV_VALUE).slice(1, -1));
		expect(everything).not.toContain(`ghp_${'a'.repeat(36)}`);
		expect(everything).not.toContain('TOP_SECRET_FILE_BODY');
		expect(everything).not.toContain('private reasoning');
		expect(everything).toContain('[redacted]');
		expect(evidence.transcript).toContain('[elided');
		expect(evidence.transcript).toContain('[elided tool output]');
	});

	it('keeps the transcript one JSON document per line, structure intact', () => {
		const evidence = record(claudeStream());
		const lines = evidence.transcript.split('\n');
		expect(lines).toHaveLength(7);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
		const result = JSON.parse(lines[6]) as Record<string, unknown>;
		expect(result).toMatchObject({ type: 'result', result: 'Implemented the change.', total_cost_usd: 0.5 });
	});

	it('produces the same evidence however the stream is chunked, multi-byte characters split included', () => {
		const stream = claudeStream().replace('Done.', 'Done — ✓ 完了.');
		const whole = record(stream);
		const bytes = Buffer.from(stream, 'utf8');
		const recorder = createModelTranscriptRecorder({
			provider: 'claude-code',
			protectedValues: [ENV_VALUE, QUOTED_ENV_VALUE],
			workspacePath: WORKSPACE
		});
		for (let offset = 0; offset < bytes.length; offset += 7)
			recorder.feed(bytes.subarray(offset, offset + 7), null);
		expect(recorder.finish(null)).toEqual(whole);
		expect(JSON.stringify(whole)).toContain('完了');
	});

	it('reads durations off the arrival times it was fed, and leaves an unanswered call unknown', () => {
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [] });
		const call = (id: string) =>
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] }
			}) + '\n';
		const answer = (id: string) =>
			JSON.stringify({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }
			}) + '\n';
		recorder.feed(call('a'), 1000);
		recorder.feed(answer('a'), 4500);
		recorder.feed(call('b'), 5000);
		const evidence = recorder.finish(9000);
		expect(evidence.timeline).toEqual([
			{
				kind: 'tool-call',
				atMs: 1000,
				toolName: 'Read',
				callId: 'a',
				argsSummary: 'file_path=/x',
				status: 'ok',
				durationMs: 3500
			},
			{
				kind: 'tool-call',
				atMs: 5000,
				toolName: 'Read',
				callId: 'b',
				argsSummary: 'file_path=/x',
				status: 'unknown',
				durationMs: null
			}
		]);
	});

	it('holds the timeline to its step cap and COUNTS what it dropped', () => {
		const lines: string[] = [];
		for (let i = 0; i < 500; i += 1) {
			lines.push(
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Grep', input: { pattern: `p${i}` } }] }
				})
			);
		}
		const evidence = record(lines.join('\n'));
		expect(evidence.timeline).toHaveLength(FLEET_AGENT_TASK_TIMELINE_MAX_STEPS);
		expect(evidence.timelineDropped).toBe(500 - FLEET_AGENT_TASK_TIMELINE_MAX_STEPS);
		// …and what it reports survives the platform's coercing reader intact.
		expect(normalizeFleetAgentTaskTimeline(evidence.timeline, evidence.timelineDropped)).toEqual({
			steps: evidence.timeline,
			dropped: 500 - FLEET_AGENT_TASK_TIMELINE_MAX_STEPS
		});
	});

	it('holds the timeline to its BYTE budget when every step is as large as a step can be', () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i += 1) {
			lines.push(
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'text', text: `${i} ${'w'.repeat(5000)}` }] }
				})
			);
		}
		const evidence = record(lines.join('\n'));
		expect(Buffer.byteLength(JSON.stringify(evidence.timeline), 'utf8')).toBeLessThanOrEqual(
			FLEET_AGENT_TASK_TIMELINE_MAX_BYTES
		);
		expect(evidence.timeline.length + evidence.timelineDropped).toBe(400);
		expect(evidence.timeline.every((step) => step.truncated === true)).toBe(true);
	});

	it('caps the transcript by keeping its head and its tail around an elision line', () => {
		const lines: string[] = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'first-line' })];
		for (let i = 0; i < 3000; i += 1) {
			lines.push(
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'text', text: `turn ${i} ${'z'.repeat(200)}` }] }
				})
			);
		}
		lines.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'last-line' }));
		const evidence = record(lines.join('\n'));
		expect(Buffer.byteLength(evidence.transcript, 'utf8')).toBeLessThanOrEqual(
			FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES
		);
		expect(evidence.transcript.startsWith(lines[0])).toBe(true);
		expect(evidence.transcript).toContain('"type":"ever-works.transcript-elided"');
		expect(evidence.transcript.endsWith('"result":"last-line"}')).toBe(true);
	});

	it('skips a line too long to buffer, still closing the call it answers', () => {
		const call = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'toolu_big', name: 'Read', input: { file_path: '/big' } }] }
		});
		const huge = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						tool_use_id: 'toolu_big',
						type: 'tool_result',
						content: 'q'.repeat(MODEL_TRANSCRIPT_MAX_LINE_BYTES + 10)
					}
				]
			}
		});
		const after = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after' }] } });
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [] });
		const bytes = Buffer.from([call, huge, after].join('\n'), 'utf8');
		for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
			recorder.feed(bytes.subarray(offset, offset + 64 * 1024), 10);
		const evidence = recorder.finish(10);
		expect(evidence.timeline.map((step) => step.status ?? step.text)).toEqual(['unknown', 'after']);
		expect(evidence.timeline[0].durationMs).toBe(0);
		expect(evidence.transcript).toContain('"type":"ever-works.oversized-line"');
		expect(evidence.transcript).not.toContain('qqqq');
	});

	it('keeps a non-JSON line short and scrubbed rather than dropping it', () => {
		const evidence = record(`warning: something about ${ENV_VALUE}\n${'n'.repeat(5000)}\n`);
		expect(evidence.timeline).toEqual([]);
		expect(evidence.transcript).toContain('warning: something about [redacted]');
		expect(evidence.transcript.split('\n')[1].length).toBeLessThanOrEqual(500);
	});
});

describe('createModelTranscriptRecorder — codex exec --json', () => {
	it('records commands, file changes and agent messages, and elides command output', () => {
		const lines = [
			{ type: 'thread.started', thread_id: 'th-1' },
			{
				type: 'item.started',
				item: { id: 'i1', type: 'command_execution', command: 'pnpm test', status: 'in_progress' }
			},
			{
				type: 'item.completed',
				item: {
					id: 'i1',
					type: 'command_execution',
					command: 'pnpm test',
					aggregated_output: FILE_BODY,
					exit_code: 1,
					status: 'failed'
				}
			},
			{
				type: 'item.completed',
				item: { id: 'i2', type: 'reasoning', text: 'private reasoning that is not reported' }
			},
			{
				type: 'item.completed',
				item: {
					id: 'i3',
					type: 'file_change',
					changes: [
						{ path: 'src/a.ts', kind: 'update' },
						{ path: 'src/b.ts', kind: 'add' }
					],
					status: 'completed'
				}
			},
			{ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Fixed the failing test.' } },
			{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }
		];
		const recorder = createModelTranscriptRecorder({ provider: 'codex', protectedValues: [] });
		lines.forEach((line, index) => recorder.feed(`${JSON.stringify(line)}\n`, index * 1000));
		const evidence = recorder.finish(9000);
		expect(evidence.timeline).toEqual([
			{
				kind: 'tool-call',
				atMs: 1000,
				toolName: 'shell',
				callId: 'i1',
				argsSummary: 'command=pnpm test',
				status: 'error',
				durationMs: 1000
			},
			{
				kind: 'tool-call',
				atMs: 4000,
				toolName: 'file_change',
				callId: 'i3',
				argsSummary: 'changes=update src/a.ts, add src/b.ts',
				status: 'ok',
				durationMs: null
			},
			{ kind: 'assistant-message', atMs: 5000, text: 'Fixed the failing test.' }
		]);
		expect(evidence.transcript).not.toContain('TOP_SECRET_FILE_BODY');
		expect(evidence.transcript).not.toContain('private reasoning');
	});
});

describe('summarizeArgs', () => {
	it('quotes the summary keys and lists every other key by NAME only', () => {
		expect(
			summarizeArgs({ file_path: '/a', old_string: FILE_BODY, new_string: FILE_BODY, replace_all: true })
		).toBe('file_path=/a +old_string,new_string,replace_all');
		expect(summarizeArgs({ command: 'ls\n  -la' })).toBe('command=ls -la');
		expect(summarizeArgs('not an object')).toBe('');
	});
});

describe('observeModelOutput', () => {
	/** A file the "CLI" appends to while the node polls it. */
	function growingFile() {
		let content = Buffer.alloc(0);
		const reader: ModelOutputChunkReader = async (_path, start, maxBytes) => ({
			bytes: content.subarray(start, start + maxBytes),
			size: content.length
		});
		return {
			reader,
			append: (text: string) => {
				content = Buffer.concat([content, Buffer.from(text, 'utf8')]);
			}
		};
	}

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it('feeds the stream as it is written, stamping arrival times, and drains the rest on stop', async () => {
		const file = growingFile();
		let clock = 0;
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [] });
		const observer = observeModelOutput({
			path: 'out',
			readChunk: file.reader,
			recorder,
			startedAt: 0,
			now: () => clock,
			pollMs: 10
		});
		clock = 2000;
		file.append(
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'pnpm build' } }] }
			}) + '\n'
		);
		await sleep(60);
		clock = 7000;
		// Written after the last poll: only `stop()`'s final drain sees it.
		file.append(
			JSON.stringify({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }
			}) + '\n'
		);
		const { complete } = await observer.stop();
		expect(complete).toBe(true);
		const evidence = recorder.finish(clock);
		expect(evidence.timeline).toEqual([
			{
				kind: 'tool-call',
				atMs: 2000,
				toolName: 'Bash',
				callId: 'x',
				argsSummary: 'command=pnpm build',
				status: 'ok',
				durationMs: 5000
			}
		]);
	});

	it('reports an INCOMPLETE view when a read fails, so the caller rebuilds from the file', async () => {
		const recorder = createModelTranscriptRecorder({ provider: 'claude-code', protectedValues: [] });
		const observer = observeModelOutput({
			path: 'out',
			readChunk: async () => {
				throw new Error('EBUSY');
			},
			recorder,
			startedAt: 0,
			pollMs: 10
		});
		await sleep(30);
		expect(await observer.stop()).toEqual({ complete: false });
	});

	it('treats a file the CLI has not created yet as empty, not as a failure', async () => {
		const recorder = createModelTranscriptRecorder({ provider: 'codex', protectedValues: [] });
		const observer = observeModelOutput({
			path: 'out',
			readChunk: async () => null,
			recorder,
			startedAt: 0,
			pollMs: 10
		});
		await sleep(30);
		expect(await observer.stop()).toEqual({ complete: true });
	});
});
