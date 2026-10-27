import { describe, expect, it } from 'vitest';
import { parseClaudeUsageLine } from './claude-records';
import { emptyCodexFileState, parseCodexUsageLine } from './codex-records';
import {
	FORBIDDEN_STRINGS,
	claudeLine,
	claudeToolResultLine,
	claudeUserLine,
	codexMessageLine,
	codexMetaLine,
	codexReasoningLine,
	codexTokenLine,
	codexTurnLine
} from './__fixtures__/usage-fixtures';

/** Usage & cost on the fleet (FL-20, T-09) — the two parsers keep the allow-listed fields only. */
describe('parseClaudeUsageLine', () => {
	it('keeps model, tokens by class, the session id, the folder and the time — nothing else', () => {
		const record = parseClaudeUsageLine(
			claudeLine({
				sessionId: 'c0ffee00-1111-4222-8333-444455556666',
				messageId: 'msg_01',
				at: '2026-10-20T10:15:00.000Z',
				usage: { input: 12, output: 340, cacheRead: 5000, cacheWrite: 800 }
			})
		);
		expect(record).toEqual({
			provider: 'claude-code',
			key: 'claude-code:msg_01:req_msg_01',
			sessionId: 'c0ffee00-1111-4222-8333-444455556666',
			model: 'claude-sonnet-4-5-20250929',
			at: Date.parse('2026-10-20T10:15:00.000Z'),
			cwd: '/home/owner/code/api',
			tokens: { in: 12, out: 340, cacheRead: 5000, cacheWrite: 800 }
		});
		const text = JSON.stringify(record);
		for (const forbidden of FORBIDDEN_STRINGS) expect(text).not.toContain(forbidden);
	});

	it('ignores user prompts and tool results, even when they mention usage fields', () => {
		expect(parseClaudeUsageLine(claudeUserLine('s', '2026-10-20T10:00:00.000Z'))).toBeNull();
		expect(parseClaudeUsageLine(claudeToolResultLine('s', '2026-10-20T10:00:00.000Z'))).toBeNull();
		expect(parseClaudeUsageLine('not json at all "usage" "assistant"')).toBeNull();
	});

	it('skips synthetic placeholders and zero-usage lines', () => {
		const synthetic = claudeLine({
			sessionId: 's1',
			messageId: 'msg_s',
			model: '<synthetic>',
			at: '2026-10-20T10:00:00.000Z',
			usage: { input: 1, output: 1 }
		});
		expect(parseClaudeUsageLine(synthetic)).toBeNull();
		const zero = claudeLine({
			sessionId: 's1',
			messageId: 'msg_z',
			at: '2026-10-20T10:00:00.000Z',
			usage: { input: 0, output: 0 }
		});
		expect(parseClaudeUsageLine(zero)).toBeNull();
	});
});

describe('parseCodexUsageLine', () => {
	it('carries the session and model from the meta and turn lines; input excludes cached input', () => {
		const state = emptyCodexFileState();
		expect(
			parseCodexUsageLine(
				codexMetaLine('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', '2026-10-20T11:00:00.000Z'),
				state
			)
		).toBeNull();
		expect(parseCodexUsageLine(codexTurnLine('2026-10-20T11:00:01.000Z'), state)).toBeNull();
		expect(parseCodexUsageLine(codexMessageLine('2026-10-20T11:00:02.000Z'), state)).toBeNull();
		expect(parseCodexUsageLine(codexReasoningLine('2026-10-20T11:00:03.000Z'), state)).toBeNull();
		const record = parseCodexUsageLine(
			codexTokenLine(
				'2026-10-20T11:00:04.000Z',
				{ input: 1000, cached: 600, output: 50 },
				{ input: 1000, cached: 600, output: 50 }
			),
			state
		);
		expect(record).toMatchObject({
			provider: 'codex',
			sessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
			model: 'gpt-5-codex',
			cwd: '/home/owner/code/web',
			tokens: { in: 400, out: 50, cacheRead: 600, cacheWrite: 0 }
		});
		const text = JSON.stringify({ record, state });
		for (const forbidden of FORBIDDEN_STRINGS) expect(text).not.toContain(forbidden);
	});

	it('counts the growth of the totals when an event has no per-request usage', () => {
		const state = emptyCodexFileState();
		parseCodexUsageLine(codexMetaLine('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001', '2026-10-20T11:00:00.000Z'), state);
		const first = parseCodexUsageLine(
			codexTokenLine('2026-10-20T11:00:01.000Z', { input: 100, cached: 0, output: 10 }, null),
			state
		);
		const second = parseCodexUsageLine(
			codexTokenLine('2026-10-20T11:00:02.000Z', { input: 300, cached: 100, output: 30 }, null),
			state
		);
		expect(first?.tokens).toEqual({ in: 100, out: 10, cacheRead: 0, cacheWrite: 0 });
		expect(second?.tokens).toEqual({ in: 100, out: 20, cacheRead: 100, cacheWrite: 0 });
		// No model was named: tokens only, never a guessed model.
		expect(second?.model).toBe('unknown');
	});

	it('gives a re-emitted event the same identity (counted once by the dedupe)', () => {
		const state = emptyCodexFileState();
		parseCodexUsageLine(codexMetaLine('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002', '2026-10-20T11:00:00.000Z'), state);
		const line = codexTokenLine(
			'2026-10-20T11:00:01.000Z',
			{ input: 100, cached: 0, output: 10 },
			{ input: 100, cached: 0, output: 10 }
		);
		const a = parseCodexUsageLine(line, state);
		const b = parseCodexUsageLine(line, state);
		expect(a?.key).toBe(b?.key);
	});
});
