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
	generateText: vi.fn(),
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
	withToolCallingRetry: vi.fn().mockImplementation((fn) => fn())
}));

vi.mock('../tools/file-tools', () => ({
	createCreateFileTool: vi.fn().mockReturnValue({ type: 'createFile-tool' }),
	createUpdateFileTool: vi.fn().mockReturnValue({ type: 'updateFile-tool' })
}));

vi.mock('../tools/validate-json-tools', () => ({
	createValidateItemJsonTool: vi.fn().mockReturnValue({ type: 'validateItemJson-tool' })
}));

import { generateText } from 'ai';
import { createCreateFileTool } from '../tools/file-tools';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker';

const mockGenerateText = vi.mocked(generateText);
const mockCreateCreateFileTool = vi.mocked(createCreateFileTool);

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

	it('invokes generateText with tools for each chunk', async () => {
		// Capture the onCreated callback when createCreateFileTool is called
		let capturedOnCreated: ((path: string, content: string) => Promise<void>) | undefined;
		mockCreateCreateFileTool.mockImplementation((_sandbox, _cwd, options) => {
			capturedOnCreated = options?.onCreated;
			return { type: 'createFile-tool' } as never;
		});

		mockGenerateText.mockImplementation(async () => {
			// Simulate the agent creating a file during generateText execution
			if (capturedOnCreated) {
				await capturedOnCreated('supertool.json', '{"slug":"supertool","name":"SuperTool"}');
			}
			return { steps: [], text: '' } as never;
		});

		const ctx = createMockContext();
		const result = await processUrlWorker('https://supertool.com', ctx);

		expect(result.count).toBe(1);
		expect(result.files).toEqual(['supertool.json']);
		expect(result.error).toBeUndefined();
		expect(mockGenerateText).toHaveBeenCalledTimes(1);

		// Verify tools are passed to generateText
		const callArgs = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
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
		expect(result.error).toBe('Failed to extract content from URL');
	});

	it('returns error when no items are created by agent', async () => {
		mockGenerateText.mockResolvedValue({ steps: [], text: '' } as never);

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

	it('handles generateText failure gracefully', async () => {
		mockGenerateText.mockRejectedValue(new Error('API timeout'));

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

		mockGenerateText.mockImplementation(async () => {
			// Simulate the agent creating a file during generateText execution
			if (capturedOnCreated) {
				await capturedOnCreated('tool-a.json', '{"slug":"tool-a","name":"Tool A"}');
			}
			return { steps: [], text: '' } as never;
		});

		const ctx = createMockContext();
		const result = await processUrlWorker('https://example.com', ctx);

		expect(result.count).toBe(1);
		expect(result.files).toEqual(['tool-a.json']);
		expect(mockGenerateText).toHaveBeenCalled();
	});
});
