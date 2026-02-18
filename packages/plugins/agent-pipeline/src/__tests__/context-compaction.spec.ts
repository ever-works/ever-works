import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('tokenx', () => ({
	estimateTokenCount: vi.fn((text: string) => Math.ceil(text.length / 4))
}));

import { estimateTokenCount } from 'tokenx';
import { createPrepareStep } from '../utils/context-compaction';
import type { ContextCompactionOptions } from '../utils/context-compaction';

// --- Test helpers ---

function toolCall(id: string, name: string, input: Record<string, unknown> = {}) {
	return { type: 'tool-call' as const, toolCallId: id, toolName: name, input };
}

function toolResult(id: string, name: string, output: unknown) {
	return { type: 'tool-result' as const, toolCallId: id, toolName: name, output };
}

function assistantMsg(parts: ReturnType<typeof toolCall>[]) {
	return { role: 'assistant' as const, content: parts };
}

function toolMsg(parts: ReturnType<typeof toolResult>[]) {
	return { role: 'tool' as const, content: parts };
}

function userMsg(text: string) {
	return { role: 'user' as const, content: text };
}

/** Build N assistant/tool pairs for search results */
function buildSearchPairs(count: number, startId = 0) {
	const messages: unknown[] = [];
	for (let i = 0; i < count; i++) {
		const id = `call-${startId + i}`;
		messages.push(
			assistantMsg([toolCall(id, 'search', { query: `query-${i}` })]),
			toolMsg([
				toolResult(id, 'search', {
					type: 'json',
					value: [
						{ title: 'Result 1', url: 'https://example.com/1', score: 0.9 },
						{ title: 'Result 2', url: 'https://example.com/2', score: 0.8 }
					]
				})
			])
		);
	}
	return messages;
}

function defaultOptions(overrides?: Partial<ContextCompactionOptions>): ContextCompactionOptions {
	return {
		maxContextTokens: 1000,
		budgetRatio: 0.7,
		...overrides
	};
}

// --- Tests ---

describe('createPrepareStep', () => {
	const mockEstimate = vi.mocked(estimateTokenCount);

	beforeEach(() => {
		vi.clearAllMocks();
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));
	});

	it('returns undefined when under token budget', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions());
		const messages = [userMsg('hello'), assistantMsg([toolCall('c1', 'search', { query: 'test' })])];

		const result = prepareStep({ messages: messages as never[] });
		expect(result).toBeUndefined();
	});

	it('compacts search results to summary in older messages', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		// 12 pairs total: first 2 should be compacted, last 10 kept
		const messages = [userMsg('generate items'), ...buildSearchPairs(12)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// First tool message (index 2) should be compacted
		const firstToolMsg = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
			toolName: string;
		};
		expect(firstToolMsg.toolName).toBe('search');
		expect(firstToolMsg.output.type).toBe('text');
		expect(firstToolMsg.output.value).toMatch(/^Searched 'query-0' -> 2 results$/);
	});

	it('compacts extractContent results to URL-only summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			// Old extractContent pair
			assistantMsg([toolCall('c1', 'extractContent', { url: 'https://example.com/page' })]),
			toolMsg([
				toolResult('c1', 'extractContent', {
					type: 'json',
					value: { url: 'https://example.com/page', content: 'A'.repeat(8000), images: [] }
				})
			]),
			// 10 recent pairs to fill the window
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.type).toBe('text');
		expect(compactedTool.output.value).toBe('Extracted content from https://example.com/page');
	});

	it('does not compact createFile/updateFile results', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const originalOutput = { type: 'json' as const, value: { success: true, path: '/items/test.json' } };
		const messages = [
			userMsg('generate'),
			// Old createFile pair
			assistantMsg([toolCall('c1', 'createFile', { path: 'test.json', content: '{}' })]),
			toolMsg([toolResult('c1', 'createFile', originalOutput)]),
			// Old updateFile pair
			assistantMsg([toolCall('c2', 'updateFile', { path: 'test.json', content: '{"a":1}' })]),
			toolMsg([toolResult('c2', 'updateFile', originalOutput)]),
			// 10 recent pairs
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// createFile result at index 2 should be unchanged
		const createToolMsg = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: unknown;
		};
		expect(createToolMsg.output).toEqual(originalOutput);

		// updateFile result at index 4 should be unchanged
		const updateToolMsg = (result!.messages[4] as { role: string; content: unknown[] }).content[0] as {
			output: unknown;
		};
		expect(updateToolMsg.output).toEqual(originalOutput);
	});

	it('preserves recent message pairs untouched', () => {
		mockEstimate.mockReturnValue(800);

		const prepareStep = createPrepareStep(defaultOptions());

		const recentOutput = {
			type: 'json' as const,
			value: [
				{ title: 'Result 1', url: 'https://example.com/1', score: 0.9 },
				{ title: 'Result 2', url: 'https://example.com/2', score: 0.8 }
			]
		};

		// Exactly 10 pairs = all recent, nothing to compact
		const messages = [userMsg('generate'), ...buildSearchPairs(10)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// Last tool message should be untouched (within recent window)
		const lastToolIdx = result!.messages.length - 1;
		const lastToolMsg = (result!.messages[lastToolIdx] as { role: string; content: unknown[] }).content[0] as {
			output: unknown;
		};
		expect(lastToolMsg.output).toEqual(recentOutput);
	});

	it('logs when compaction triggers', () => {
		mockEstimate.mockReturnValue(800);

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));

		const messages = [userMsg('generate'), ...buildSearchPairs(12)] as never[];

		prepareStep({ messages });

		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Context compaction triggered'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('800'));
	});

	it('handles empty message array', () => {
		mockEstimate.mockReturnValue(0);

		const prepareStep = createPrepareStep(defaultOptions());
		const result = prepareStep({ messages: [] });
		expect(result).toBeUndefined();
	});

	it('handles minimal message array with only user message', () => {
		mockEstimate.mockReturnValue(10);

		const prepareStep = createPrepareStep(defaultOptions());
		const result = prepareStep({ messages: [userMsg('hello')] as never[] });
		expect(result).toBeUndefined();
	});

	it('compacts bash results to command-only summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'ls /items' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: 'file1.json\nfile2.json\nfile3.json' })]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.value).toBe('Ran: ls /items');
	});

	it('compacts readFile results to path-only summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'readFile', { path: '/items/test.json' })]),
			toolMsg([toolResult('c1', 'readFile', { type: 'text', value: '{"name":"Test","url":"..."}' })]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.value).toBe('Read: /items/test.json');
	});

	it('compacts validateItemJson results with valid status', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'validateItemJson', { path: 'item.json' })]),
			toolMsg([
				toolResult('c1', 'validateItemJson', {
					type: 'json',
					value: { valid: true, message: 'JSON is valid.' }
				})
			]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.value).toBe('item.json: valid');
	});

	it('compacts validateItemJson results with error status', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'validateItemJson', { path: 'bad.json' })]),
			toolMsg([
				toolResult('c1', 'validateItemJson', {
					type: 'json',
					value: { valid: false, error: 'JSON is invalid and could not be repaired: Unexpected token' }
				})
			]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.value).toBe(
			'bad.json: JSON is invalid and could not be repaired: Unexpected token'
		);
	});

	it('does not compact reportProgress results', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const originalOutput = { type: 'json' as const, value: { acknowledged: true, itemsCreated: 5 } };
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'reportProgress', { itemsCreated: 5 })]),
			toolMsg([toolResult('c1', 'reportProgress', originalOutput)]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgResult = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: unknown;
		};
		expect(toolMsgResult.output).toEqual(originalOutput);
	});

	it('truncates unknown tool output to 200 chars', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const longOutput = 'x'.repeat(300);
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'unknownTool', {})]),
			toolMsg([toolResult('c1', 'unknownTool', { type: 'text', value: longOutput })]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compactedTool = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compactedTool.output.value.length).toBeLessThanOrEqual(201);
		expect(compactedTool.output.value).toContain('\u2026');
	});
});

// --- Progressive compaction tests ---

describe('progressive compaction', () => {
	const mockEstimate = vi.mocked(estimateTokenCount);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('falls through to smaller window when window=10 is not enough', () => {
		// First call (raw): over budget. After window=10: still over. After window=5: under.
		let callCount = 0;
		mockEstimate.mockImplementation(() => {
			callCount++;
			// 1st call: raw check → over budget
			if (callCount === 1) return 800;
			// 2nd call: after window=10 compaction → still over
			if (callCount === 2) return 800;
			// 3rd call: after window=5 compaction → under budget
			return 600;
		});

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));

		// 15 pairs: plenty of messages to compact
		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Compaction fit at window=5'));
	});

	it('reaches window=1 for very tight budgets', () => {
		let callCount = 0;
		mockEstimate.mockImplementation(() => {
			callCount++;
			// Only under budget on window=1
			if (callCount <= 4) return 800;
			return 500;
		});

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));

		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Compaction fit at window=1'));
	});

	it('evicts oldest compacted pairs when no window size is sufficient', () => {
		// Use realistic estimation: token count based on content length
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		// Very tight budget: 200 tokens → 800 chars budget
		const prepareStep = createPrepareStep(
			defaultOptions({
				maxContextTokens: 285,
				budgetRatio: 0.7,
				logger: logger as never
			})
		);

		// 15 pairs: too many compacted steps to fit in 200 tokens
		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// Should have fewer messages than input (pairs were dropped)
		expect(result!.messages.length).toBeLessThan(messages.length);
		// First message is still user prompt
		expect((result!.messages[0] as { role: string }).role).toBe('user');
		// Last message is still a tool message (recent window preserved)
		expect((result!.messages[result!.messages.length - 1] as { role: string }).role).toBe('tool');
		// Should log eviction
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Dropped'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('pairs'));
	});

	it('preserves recent window even when evicting all old pairs', () => {
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		// Extremely tight budget
		const prepareStep = createPrepareStep(
			defaultOptions({
				maxContextTokens: 150,
				budgetRatio: 0.7,
				logger: logger as never
			})
		);

		// 20 pairs: many old pairs to drop
		const messages = [userMsg('go'), ...buildSearchPairs(20)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// User prompt must survive
		expect((result!.messages[0] as { role: string }).role).toBe('user');
		// At least the most recent pair should remain
		const roles = result!.messages.map((m) => (m as { role: string }).role);
		expect(roles).toContain('tool');
		expect(roles).toContain('assistant');
	});

	it('drops messages in even counts to preserve assistant+tool pairing', () => {
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(
			defaultOptions({
				maxContextTokens: 285,
				budgetRatio: 0.7,
				logger: logger as never
			})
		);

		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// Total messages minus user prompt should be even (all assistant+tool pairs intact)
		const nonUserCount = result!.messages.length - 1;
		expect(nonUserCount % 2).toBe(0);
	});

	it('logs warning when budget exceeded even after eviction', () => {
		// Always over budget regardless of dropping
		mockEstimate.mockReturnValue(800);

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));

		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still over budget after eviction'));
	});
});

// --- Output safety net tests ---

describe('output safety net (maxSingleOutputChars)', () => {
	const mockEstimate = vi.mocked(estimateTokenCount);

	beforeEach(() => {
		vi.clearAllMocks();
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));
	});

	it('truncates oversized bash output', () => {
		mockEstimate.mockReturnValue(500); // under budget

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 100 }));

		const longBashOutput = 'x'.repeat(500);
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'ls' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: longBashOutput })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 500 chars total]');
		expect(toolMsgContent.output.value.length).toBeLessThan(longBashOutput.length);
	});

	it('truncates oversized readFile output', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 100 }));

		const longFileContent = 'y'.repeat(300);
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'readFile', { path: '/test.json' })]),
			toolMsg([toolResult('c1', 'readFile', { type: 'text', value: longFileContent })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 300 chars total]');
	});

	it('does not truncate small outputs', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 1000 }));

		const smallOutput = 'short output';
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'echo hi' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: smallOutput })])
		] as never[];

		const result = prepareStep({ messages });
		// Under budget and no truncation needed → undefined
		expect(result).toBeUndefined();
	});

	it('never truncates createFile outputs', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 10 }));

		const originalOutput = { type: 'json' as const, value: { success: true, path: '/items/test.json' } };
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'createFile', { path: 'test.json', content: '{}' })]),
			toolMsg([toolResult('c1', 'createFile', originalOutput)])
		] as never[];

		const result = prepareStep({ messages });
		// createFile is protected, nothing changed, under budget → undefined
		expect(result).toBeUndefined();
	});

	it('never truncates reportProgress outputs', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 10 }));

		const originalOutput = { type: 'json' as const, value: { acknowledged: true, itemsCreated: 5 } };
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'reportProgress', { itemsCreated: 5 })]),
			toolMsg([toolResult('c1', 'reportProgress', originalOutput)])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeUndefined();
	});

	it('truncates output but skips compaction when under budget', () => {
		mockEstimate.mockReturnValue(500); // under budget of 700

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 50 }));

		const longOutput = 'z'.repeat(200);
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'ls' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: longOutput })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		// Output was truncated
		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 200 chars total]');
	});

	it('includes truncation notice with original char count', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 50 }));

		const longOutput = 'a'.repeat(12345);
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'cat file' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: longOutput })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 12345 chars total]');
	});
});
