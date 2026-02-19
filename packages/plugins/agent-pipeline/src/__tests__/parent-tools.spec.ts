import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createParentTools } from '../tools/parent-tools';
import type { ParentToolContext } from '../tools/parent-tools';
import type { ISearchFacade, IContentExtractorFacade, PluginLogger } from '@ever-works/plugin';

vi.mock('../worker/url-worker', () => ({
	processUrlWorker: vi.fn()
}));

vi.mock('../worker/modification-worker', () => ({
	processModification: vi.fn()
}));

vi.mock('../tools/workspace-overview', () => ({
	readWorkspaceOverview: vi.fn()
}));

import { processUrlWorker } from '../worker/url-worker';
import { processModification } from '../worker/modification-worker';
import { readWorkspaceOverview } from '../tools/workspace-overview';

const mockProcessUrl = vi.mocked(processUrlWorker);
const mockProcessModification = vi.mocked(processModification);
const mockReadOverview = vi.mocked(readWorkspaceOverview);

function createMockContext(overrides?: Partial<ParentToolContext>): ParentToolContext {
	return {
		workspacePath: '/tmp/workspace',
		facades: {
			searchFacade: {
				search: vi.fn().mockResolvedValue([]),
				isConfigured: () => true
			} as unknown as ISearchFacade,
			contentExtractorFacade: {
				extractContent: vi.fn(),
				isConfigured: () => true
			} as unknown as IContentExtractorFacade
		},
		facadeOptions: { userId: 'u1', directoryId: 'd1' },
		workerModel: {} as never,
		workerMaxContextTokens: 128000,
		parentModel: {} as never,
		parentMaxContextTokens: 128000,
		directoryContext: { directoryName: 'Test Dir' },
		onProgress: vi.fn(),
		totalSteps: 5,
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as PluginLogger,
		...overrides
	};
}

describe('createParentTools', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('creates all 5 tools', () => {
		const ctx = createMockContext();
		const { tools } = createParentTools(ctx);

		expect(tools).toHaveProperty('search');
		expect(tools).toHaveProperty('processUrls');
		expect(tools).toHaveProperty('modifyItems');
		expect(tools).toHaveProperty('getWorkspaceOverview');
		expect(tools).toHaveProperty('reportProgress');
	});

	it('returns a circuit breaker', () => {
		const ctx = createMockContext();
		const { breaker } = createParentTools(ctx);

		expect(breaker).toBeDefined();
		expect(typeof breaker.isTripped).toBe('function');
	});

	describe('processUrls tool', () => {
		it('processes URLs in parallel', async () => {
			mockProcessUrl
				.mockResolvedValueOnce({ url: 'https://a.com', files: ['a.json'], count: 1 })
				.mockResolvedValueOnce({ url: 'https://b.com', files: ['b.json', 'c.json'], count: 2 });

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const processUrls = tools.processUrls as { execute: Function };

			const result = await processUrls.execute(
				{ urls: ['https://a.com', 'https://b.com'] },
				{ toolCallId: 'tc1', messages: [] }
			);

			expect(result).toHaveLength(2);
			expect(result[0].count).toBe(1);
			expect(result[1].count).toBe(2);
			expect(mockProcessUrl).toHaveBeenCalledTimes(2);
		});

		it('handles worker failures gracefully', async () => {
			mockProcessUrl
				.mockResolvedValueOnce({ url: 'https://a.com', files: ['a.json'], count: 1 })
				.mockRejectedValueOnce(new Error('Network error'));

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const processUrls = tools.processUrls as { execute: Function };

			const result = await processUrls.execute(
				{ urls: ['https://a.com', 'https://b.com'] },
				{ toolCallId: 'tc1', messages: [] }
			);

			expect(result).toHaveLength(2);
			expect(result[0].count).toBe(1);
			expect(result[1].error).toBe('Network error');
		});
	});

	describe('modifyItems tool', () => {
		it('delegates to processModification', async () => {
			mockProcessModification.mockResolvedValue({
				modifiedFiles: ['item1.json'],
				count: 1
			});

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const modifyItems = tools.modifyItems as { execute: Function };

			const result = await modifyItems.execute(
				{ instructions: 'Merge categories' },
				{ toolCallId: 'tc1', messages: [] }
			);

			expect(result.count).toBe(1);
			expect(mockProcessModification).toHaveBeenCalledWith(
				'Merge categories',
				expect.objectContaining({ workspacePath: '/tmp/workspace' })
			);
		});
	});

	describe('getWorkspaceOverview tool', () => {
		it('returns workspace overview', async () => {
			mockReadOverview.mockResolvedValue({
				totalItems: 15,
				categories: ['Monitoring', 'CI/CD'],
				tags: ['open-source'],
				brands: ['CNCF']
			});

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const overview = tools.getWorkspaceOverview as { execute: Function };

			const result = await overview.execute({}, { toolCallId: 'tc1', messages: [] });

			expect(result.totalItems).toBe(15);
			expect(result.categories).toEqual(['Monitoring', 'CI/CD']);
		});
	});
});
