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
		existing: { items: [], categories: [], tags: [], brands: [] },
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
		expect(tools).toHaveProperty('processUrl');
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

	describe('processUrl tool', () => {
		it('processes a single URL', async () => {
			mockProcessUrl.mockResolvedValueOnce({
				url: 'https://a.com',
				files: ['a.json'],
				count: 1
			});

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const processUrl = tools.processUrl as { execute: Function };

			const result = await processUrl.execute({ url: 'https://a.com' }, { toolCallId: 'tc1', messages: [] });

			expect(result.count).toBe(1);
			expect(mockProcessUrl).toHaveBeenCalledTimes(1);
			expect(mockProcessUrl).toHaveBeenCalledWith(
				'https://a.com',
				expect.objectContaining({ workspacePath: '/tmp/workspace' })
			);
		});

		it('handles worker failures gracefully', async () => {
			mockProcessUrl.mockRejectedValueOnce(new Error('Network error'));

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const processUrl = tools.processUrl as { execute: Function };

			const result = await processUrl.execute({ url: 'https://b.com' }, { toolCallId: 'tc1', messages: [] });

			expect(result).toEqual({
				url: 'https://b.com',
				files: [],
				count: 0,
				error: 'Network error'
			});
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
				newItems: 3,
				updatedItems: 4,
				categories: ['Monitoring', 'CI/CD'],
				tags: ['open-source'],
				brands: ['CNCF']
			});

			const ctx = createMockContext();
			const { tools } = createParentTools(ctx);
			const overview = tools.getWorkspaceOverview as { execute: Function };

			const result = await overview.execute({}, { toolCallId: 'tc1', messages: [] });

			expect(result.totalItems).toBe(15);
			expect(result.newItems).toBe(3);
			expect(result.updatedItems).toBe(4);
			expect(result.categories).toEqual(['Monitoring', 'CI/CD']);
		});
	});
});
