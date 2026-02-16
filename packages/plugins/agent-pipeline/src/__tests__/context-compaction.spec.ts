import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('tokenx', () => ({
	estimateTokenCount: vi.fn((text: string) => Math.ceil(text.length / 4))
}));

import { estimateTokenCount } from 'tokenx';
import { createPrepareStep } from '../utils/context-compaction';
import type { ContextCompactionOptions } from '../utils/context-compaction';

// --- Test helpers ---

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
	return { type: 'tool-call' as const, toolCallId: id, toolName: name, args };
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
		mockEstimate.mockImplementation((text: string) => Math.ceil(text.length / 4));
	});

	it('returns undefined when under token budget', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions());
		const messages = [userMsg('hello'), assistantMsg([toolCall('c1', 'search', { query: 'test' })])];

		const result = prepareStep({ messages: messages as never[] });
		expect(result).toBeUndefined();
	});

	it('compacts search results to summary in older messages', () => {
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
		mockEstimate.mockReturnValue(800);

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
