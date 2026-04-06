import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processUrlWorker } from '../worker/url-worker';
import type { UrlWorkerContext } from '../worker/url-worker';
import type { IContentExtractorFacade, FacadeOptions, PluginLogger } from '@ever-works/plugin';

// Mock bash-tool and just-bash dynamic imports
const mockBashToolExecute = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
const mockReadFileExecute = vi.fn().mockResolvedValue('');
const mockSandboxReadFile = vi.fn();
const mockSandboxWriteFile = vi.fn();

vi.mock('bash-tool', () => ({
	createBashTool: vi.fn().mockResolvedValue({
		tools: {
			bash: { execute: mockBashToolExecute },
			readFile: { execute: mockReadFileExecute }
		}
	})
}));

vi.mock('just-bash', () => ({
	Bash: vi.fn().mockImplementation(() => ({})),
	ReadWriteFs: vi.fn().mockImplementation(() => ({
		readFile: mockSandboxReadFile,
		writeFile: mockSandboxWriteFile
	}))
}));

vi.mock('ai', () => ({
	streamText: vi.fn(),
	stepCountIs: vi.fn().mockReturnValue(() => false),
	wrapLanguageModel: vi.fn().mockImplementation(({ model }) => model),
	tool: vi.fn().mockImplementation((def) => def)
}));

vi.mock('node:fs/promises', () => ({
	appendFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../utils/taxonomy-sync', () => ({
	syncTaxonomyFromFile: vi.fn()
}));

vi.mock('../utils/context-compaction', () => ({
	createPrepareStep: vi.fn().mockReturnValue(() => undefined)
}));

vi.mock('../utils/tool-call-resilience', () => ({
	createToolCallRepairFn: vi.fn().mockReturnValue(() => null),
	withToolCallingRetry: vi.fn().mockImplementation(async (fn) => {
		const result = await fn();
		return result ?? { steps: [], text: '', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
	})
}));

vi.mock('../tools/file-tools', () => ({
	createCreateFileTool: vi.fn().mockReturnValue({ type: 'createFile-tool' }),
	createUpdateFileTool: vi.fn().mockReturnValue({ type: 'updateFile-tool' })
}));

vi.mock('../tools/validate-json-tools', () => ({
	createValidateItemJsonTool: vi.fn().mockReturnValue({ type: 'validateItemJson-tool' })
}));

import { streamText } from 'ai';
import { createCreateFileTool } from '../tools/file-tools';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker';
import { TokenUsageAccumulator } from '../types';

const mockStreamText = vi.mocked(streamText);
const mockCreateCreateFileTool = vi.mocked(createCreateFileTool);

function createMockStreamResult(overrides?: {
	onStream?: () => Promise<void>;
	streamError?: Error;
	totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens: number };
	text?: string;
	steps?: unknown[];
}) {
	const fullStream = {
		async *[Symbol.asyncIterator]() {
			if (overrides?.streamError) {
				throw overrides.streamError;
			}

			await overrides?.onStream?.();
		}
	};

	return {
		fullStream,
		steps: Promise.resolve(overrides?.steps ?? []),
		text: Promise.resolve(overrides?.text ?? ''),
		totalUsage: Promise.resolve(overrides?.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
	} as never;
}

function createMockContext(overrides?: Partial<UrlWorkerContext>): UrlWorkerContext {
	return {
		workerModel: {} as never,
		maxContextTokens: 128000,
		contentExtractorFacade: {
			extractContent: vi.fn().mockResolvedValue({
				rawContent: 'Test content about a great tool',
				images: []
			})
		} as unknown as IContentExtractorFacade,
		facadeOptions: { userId: 'u1', directoryId: 'd1' } as FacadeOptions,
		directoryContext: {
			directoryName: 'AI Tools',
			directoryDescription: 'Best AI tools'
		},
		workspacePath: '/tmp/workspace',
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as PluginLogger,
		breaker: new ToolCircuitBreaker(),
		...overrides
	};
}

describe('processUrlWorker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSandboxReadFile.mockRejectedValue(new Error('ENOENT'));
		mockSandboxWriteFile.mockResolvedValue(undefined);
	});

	it('invokes streamText with tools for each chunk', async () => {
		// Capture the onCreated callback when createCreateFileTool is called
		let capturedOnCreated: ((path: string, content: string) => Promise<void>) | undefined;
		mockCreateCreateFileTool.mockImplementation((_sandbox, _cwd, options) => {
			capturedOnCreated = options?.onCreated;
			return { type: 'createFile-tool' } as never;
		});

		mockStreamText.mockImplementation(() =>
			createMockStreamResult({
				onStream: async () => {
					if (capturedOnCreated) {
						await capturedOnCreated('supertool.json', '{"slug":"supertool","name":"SuperTool"}');
					}
				},
				totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
			})
		);

		const ctx = createMockContext();
		const result = await processUrlWorker('https://supertool.com', ctx);

		expect(result.count).toBe(1);
		expect(result.files).toEqual(['supertool.json']);
		expect(result.error).toBeUndefined();
		expect(mockStreamText).toHaveBeenCalledTimes(1);

		// Verify tools are passed to streamText
		const callArgs = mockStreamText.mock.calls[0][0] as Record<string, unknown>;
		expect(callArgs.tools).toHaveProperty('bash');
		expect(callArgs.tools).toHaveProperty('readFile');
		expect(callArgs.tools).toHaveProperty('createFile');
		expect(callArgs.tools).toHaveProperty('updateFile');
		expect(callArgs.tools).toHaveProperty('validateItemJson');
	});

	it('returns error when content extraction fails', async () => {
		const ctx = createMockContext({
			contentExtractorFacade: {
				extractContent: vi.fn().mockResolvedValue(null)
			} as unknown as IContentExtractorFacade
		});

		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('Content extraction failed for URL: https://example.com');
	});

	it('returns error when no items are created by agent', async () => {
		mockStreamText.mockReturnValue(
			createMockStreamResult({
				totalUsage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 }
			})
		);

		const ctx = createMockContext();
		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('No items extracted');
	});

	it('handles abort signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const ctx = createMockContext({ signal: controller.signal });
		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('Aborted');
	});

	it('handles streamText failure gracefully', async () => {
		mockStreamText.mockImplementation(() =>
			createMockStreamResult({
				streamError: new Error('API timeout')
			})
		);

		const ctx = createMockContext();
		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(0);
		expect(result.error).toBe('No items extracted');
	});

	it('tracks files created via onCreated callback', async () => {
		// Capture the onCreated callback when createCreateFileTool is called
		let capturedOnCreated: ((path: string, content: string) => Promise<void>) | undefined;
		mockCreateCreateFileTool.mockImplementation((_sandbox, _cwd, options) => {
			capturedOnCreated = options?.onCreated;
			return { type: 'createFile-tool' } as never;
		});

		mockStreamText.mockImplementation(() =>
			createMockStreamResult({
				onStream: async () => {
					if (capturedOnCreated) {
						await capturedOnCreated('tool-a.json', '{"slug":"tool-a","name":"Tool A"}');
					}
				},
				totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
			})
		);

		const ctx = createMockContext();
		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(1);
		expect(result.files).toEqual(['tool-a.json']);
		expect(mockStreamText).toHaveBeenCalled();
	});

	it('accumulates token usage when tokenAccumulator is provided', async () => {
		mockStreamText.mockReturnValue(
			createMockStreamResult({
				totalUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 }
			})
		);

		const accumulator = new TokenUsageAccumulator();
		const ctx = createMockContext({ tokenAccumulator: accumulator });
		await processUrlWorker('https://example.com', ctx);

		const breakdown = accumulator.toBreakdown();
		expect(breakdown.workers.inputTokens).toBe(200);
		expect(breakdown.workers.outputTokens).toBe(100);
		expect(breakdown.workers.totalTokens).toBe(300);
	});
});
