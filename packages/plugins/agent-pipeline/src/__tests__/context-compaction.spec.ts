import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('tokenx', () => ({
	estimateTokenCount: vi.fn((text: string) => Math.ceil(text.length / 4))
}));

import { estimateTokenCount } from 'tokenx';
import { createPrepareStep } from '../utils/context-compaction';
import type { ContextCompactionOptions } from '../utils/context-compaction';

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
		const messages = [userMsg('generate items'), ...buildSearchPairs(12)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const firstToolMsg = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
			toolName: string;
		};
		expect(firstToolMsg.toolName).toBe('search');
		expect(firstToolMsg.output.type).toBe('text');
		expect(firstToolMsg.output.value).toMatch(/^Searched 'query-0' -> 2 results$/);
	});

	it('compacts processUrls results to summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'processUrls', { urls: ['https://a.com', 'https://b.com'] })]),
			toolMsg([
				toolResult('c1', 'processUrls', {
					type: 'json',
					value: [
						{ url: 'https://a.com', files: ['a.json'], count: 1 },
						{ url: 'https://b.com', files: ['b.json', 'c.json'], count: 2 }
					]
				})
			]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compacted = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compacted.output.value).toBe('Processed 2 URLs -> 3 items');
	});

	it('compacts modifyItems results to summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'modifyItems', { instructions: 'merge categories' })]),
			toolMsg([
				toolResult('c1', 'modifyItems', {
					type: 'json',
					value: { modifiedFiles: ['a.json', 'b.json'], count: 2 }
				})
			]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compacted = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compacted.output.value).toBe('Modified 2 files');
	});

	it('compacts getWorkspaceOverview results to summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'getWorkspaceOverview', {})]),
			toolMsg([
				toolResult('c1', 'getWorkspaceOverview', {
					type: 'json',
					value: { totalItems: 25, categories: ['A', 'B', 'C'], tags: [], brands: [] }
				})
			]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const compacted = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(compacted.output.value).toBe('Workspace: 25 items, 3 categories');
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

		const messages = [userMsg('generate'), ...buildSearchPairs(10)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

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

	it('compacts validateItemJson valid results to summary', () => {
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

		const toolPart = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolPart.output.value).toBe('item.json: valid');
	});

	it('compacts validateItemJson error results to summary', () => {
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

		const toolPart = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolPart.output.value).toBe('bad.json: JSON is invalid and could not be repaired: Unexpected token');
	});

	it('compacts createFile results to summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'createFile', { path: 'item.json', content: '{}' })]),
			toolMsg([toolResult('c1', 'createFile', { type: 'json', value: { success: true, path: 'item.json' } })]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolPart = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolPart.output.value).toBe('Created: item.json');
	});

	it('compacts updateFile results to summary', () => {
		mockEstimate.mockReturnValueOnce(800).mockReturnValue(600);

		const prepareStep = createPrepareStep(defaultOptions());

		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'updateFile', { path: 'item.json', content: '{"name":"x"}' })]),
			toolMsg([toolResult('c1', 'updateFile', { type: 'json', value: { success: true, path: 'item.json' } })]),
			...buildSearchPairs(10, 100)
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolPart = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolPart.output.value).toBe('Updated: item.json');
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

describe('progressive compaction', () => {
	const mockEstimate = vi.mocked(estimateTokenCount);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('falls through to smaller window when window=10 is not enough', () => {
		let callCount = 0;
		mockEstimate.mockImplementation(() => {
			callCount++;
			if (callCount === 1) return 800;
			if (callCount === 2) return 800;
			return 600;
		});

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));
		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Compaction fit at window=5'));
	});

	it('reaches window=1 for very tight budgets', () => {
		let callCount = 0;
		mockEstimate.mockImplementation(() => {
			callCount++;
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
		expect(result!.messages.length).toBeLessThan(messages.length);
		expect((result!.messages[0] as { role: string }).role).toBe('user');
		expect((result!.messages[result!.messages.length - 1] as { role: string }).role).toBe('tool');
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Dropped'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('pairs'));
	});

	it('preserves recent window even when evicting all old pairs', () => {
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(
			defaultOptions({
				maxContextTokens: 150,
				budgetRatio: 0.7,
				logger: logger as never
			})
		);
		const messages = [userMsg('go'), ...buildSearchPairs(20)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect((result!.messages[0] as { role: string }).role).toBe('user');
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
		const nonUserCount = result!.messages.length - 1;
		expect(nonUserCount % 2).toBe(0);
	});

	it('logs warning when budget exceeded even after eviction', () => {
		mockEstimate.mockReturnValue(800);

		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const prepareStep = createPrepareStep(defaultOptions({ logger: logger as never }));
		const messages = [userMsg('generate'), ...buildSearchPairs(15)] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still over budget after eviction'));
	});
});

describe('output safety net (maxSingleOutputChars)', () => {
	const mockEstimate = vi.mocked(estimateTokenCount);

	beforeEach(() => {
		vi.clearAllMocks();
		mockEstimate.mockImplementation((text?: string) => Math.ceil((text ?? '').length / 4));
	});

	it('truncates oversized bash output', () => {
		mockEstimate.mockReturnValue(500);

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

	it('does not truncate small outputs', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 1000 }));
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'echo hi' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: 'short output' })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeUndefined();
	});

	it('truncates output but skips compaction when under budget', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 50 }));
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'ls' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: 'z'.repeat(200) })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 200 chars total]');
	});

	it('includes truncation notice with original char count', () => {
		mockEstimate.mockReturnValue(500);

		const prepareStep = createPrepareStep(defaultOptions({ maxSingleOutputChars: 50 }));
		const messages = [
			userMsg('generate'),
			assistantMsg([toolCall('c1', 'bash', { command: 'cat file' })]),
			toolMsg([toolResult('c1', 'bash', { type: 'text', value: 'a'.repeat(12345) })])
		] as never[];

		const result = prepareStep({ messages });
		expect(result).toBeDefined();

		const toolMsgContent = (result!.messages[2] as { role: string; content: unknown[] }).content[0] as {
			output: { type: string; value: string };
		};
		expect(toolMsgContent.output.value).toContain('[Output truncated: 12345 chars total]');
	});
});
