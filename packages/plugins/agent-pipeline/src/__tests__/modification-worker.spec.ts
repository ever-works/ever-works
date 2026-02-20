import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processModification } from '../worker/modification-worker';
import type { ModificationWorkerContext } from '../worker/modification-worker';
import type { PluginLogger } from '@ever-works/plugin';

vi.mock('ai', () => ({
	generateText: vi.fn(),
	stepCountIs: vi.fn(() => () => false),
	tool: vi.fn((opts) => opts),
	wrapLanguageModel: vi.fn(({ model }) => model)
}));

vi.mock('../tools/file-tools', () => ({
	createUpdateFileTool: vi.fn().mockReturnValue({ type: 'updateFile-tool' })
}));

vi.mock('../tools/validate-json-tools', () => ({
	createValidateItemJsonTool: vi.fn().mockReturnValue({ type: 'validateItemJson-tool' })
}));

vi.mock('../utils/taxonomy-sync', () => ({
	syncTaxonomyFromFile: vi.fn()
}));

vi.mock('../utils/tool-call-resilience', () => ({
	createToolCallRepairFn: vi.fn().mockReturnValue(() => null),
	withToolCallingRetry: vi.fn().mockImplementation(async (fn) => {
		const result = await fn();
		return result ?? { steps: [], text: '', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
	})
}));

vi.mock('tokenx', () => ({
	estimateTokenCount: vi.fn(() => 100)
}));

vi.mock('bash-tool', () => ({
	createBashTool: vi.fn().mockResolvedValue({
		tools: {
			bash: { execute: vi.fn() },
			readFile: { execute: vi.fn() }
		}
	})
}));

vi.mock('just-bash', () => ({
	Bash: vi.fn(),
	ReadWriteFs: vi.fn()
}));

import { generateText } from 'ai';
import { TokenUsageAccumulator } from '../types';

const mockGenerateText = vi.mocked(generateText);

function createMockContext(overrides?: Partial<ModificationWorkerContext>): ModificationWorkerContext {
	return {
		model: {} as never,
		maxContextTokens: 128000,
		workspacePath: '/tmp/workspace',
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as PluginLogger,
		...overrides
	};
}

describe('processModification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('calls generateText with tools and returns result', async () => {
		mockGenerateText.mockResolvedValue({
			steps: [],
			text: '',
			finishReason: 'stop',
			totalUsage: { totalTokens: 500 }
		} as never);

		const ctx = createMockContext();
		const result = await processModification('Merge categories A and B', ctx);

		expect(mockGenerateText).toHaveBeenCalledOnce();
		const callArgs = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.tools).toHaveProperty('bash');
		expect(callArgs.tools).toHaveProperty('readFile');
		expect(callArgs.tools).toHaveProperty('updateFile');
		expect(callArgs.tools).toHaveProperty('validateItemJson');
		expect(callArgs.prompt).toBe('Merge categories A and B');
		expect(result.error).toBeUndefined();
	});

	it('returns empty result when no files modified', async () => {
		mockGenerateText.mockResolvedValue({
			steps: [],
			text: 'Nothing to modify',
			finishReason: 'stop',
			totalUsage: { totalTokens: 100 }
		} as never);

		const ctx = createMockContext();
		const result = await processModification('Check categories', ctx);

		expect(result.count).toBe(0);
		expect(result.modifiedFiles).toEqual([]);
	});

	it('handles abort signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const ctx = createMockContext({ signal: controller.signal });
		const result = await processModification('Merge categories', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('Aborted');
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it('handles errors gracefully', async () => {
		mockGenerateText.mockRejectedValue(new Error('Model error'));

		const ctx = createMockContext();
		const result = await processModification('Invalid instruction', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('Model error');
	});

	it('accumulates token usage when tokenAccumulator is provided', async () => {
		mockGenerateText.mockResolvedValue({
			steps: [],
			text: '',
			finishReason: 'stop',
			totalUsage: { inputTokens: 300, outputTokens: 150, totalTokens: 450 }
		} as never);

		const accumulator = new TokenUsageAccumulator();
		const ctx = createMockContext({ tokenAccumulator: accumulator });
		await processModification('Update categories', ctx);

		const breakdown = accumulator.toBreakdown();
		expect(breakdown.workers.inputTokens).toBe(300);
		expect(breakdown.workers.outputTokens).toBe(150);
		expect(breakdown.workers.totalTokens).toBe(450);
	});
});
