import { describe, it, expect, vi } from 'vitest';
import { createSearchTool, createReportProgressTool } from '../tools/facade-tools';
import type { ISearchFacade, FacadeOptions, PluginLogger } from '@ever-works/plugin';
import type { FacadeToolOptions } from '../tools/facade-tools';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker';

function createMockLogger(): PluginLogger {
	return { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function createToolOptions(overrides?: Partial<FacadeToolOptions>): FacadeToolOptions {
	return {
		breaker: new ToolCircuitBreaker(),
		logger: createMockLogger(),
		...overrides
	};
}

describe('facade-tools', () => {
	const facadeOptions: FacadeOptions = {
		userId: 'user1',
		workId: 'dir1'
	};

	describe('createSearchTool', () => {
		it('should call searchFacade.search with query and options', async () => {
			const mockResults = [
				{ title: 'Result 1', url: 'https://example.com', score: 0.9 },
				{ title: 'Result 2', url: 'https://example2.com', score: 0.8, publishedDate: '2024-01-01' }
			];

			const searchFacade = {
				search: vi.fn().mockResolvedValue(mockResults),
				isConfigured: () => true
			} as unknown as ISearchFacade;

			const tool = createSearchTool(searchFacade, facadeOptions, createToolOptions());
			const result = await tool.execute!({ query: 'test query', maxResults: 5 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(searchFacade.search).toHaveBeenCalledWith('test query', { maxResults: 5 }, facadeOptions);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				title: 'Result 1',
				url: 'https://example.com',
				score: 0.9,
				publishedDate: undefined
			});
		});

		it('should return structured error when search facade throws', async () => {
			const searchFacade = {
				search: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
				isConfigured: () => true
			} as unknown as ISearchFacade;

			const tool = createSearchTool(searchFacade, facadeOptions, createToolOptions());
			const result = await tool.execute!({ query: 'test', maxResults: 5 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(result).toEqual({
				results: [],
				error: expect.stringContaining('401 Unauthorized')
			});
		});

		it('should short-circuit when breaker is tripped', async () => {
			const searchFacade = {
				search: vi.fn(),
				isConfigured: () => true
			} as unknown as ISearchFacade;

			const breaker = new ToolCircuitBreaker({ threshold: 1 });
			breaker.recordFailure('search', new Error('down'));

			const tool = createSearchTool(searchFacade, facadeOptions, createToolOptions({ breaker }));
			const result = await tool.execute!({ query: 'test', maxResults: 5 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(searchFacade.search).not.toHaveBeenCalled();
			expect(result).toEqual({
				results: [],
				error: expect.stringContaining('Do NOT')
			});
		});
	});

	describe('createReportProgressTool', () => {
		it('should call onProgress callback', async () => {
			const onProgress = vi.fn();

			const tool = createReportProgressTool(onProgress, 1, 5);
			const result = await tool.execute!({ itemsCreated: 10, message: 'Going well' }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(onProgress).toHaveBeenCalledWith(
				expect.objectContaining({
					currentStepIndex: 1,
					totalSteps: 5,
					currentStepName: 'Generate Items',
					message: 'Going well',
					itemsProcessed: 10
				})
			);
			expect(result).toEqual({ acknowledged: true, itemsCreated: 10 });
		});

		it('should cap progress percentage at 80%', async () => {
			const onProgress = vi.fn();

			const tool = createReportProgressTool(onProgress, 1, 5);
			await tool.execute!({ itemsCreated: 100 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(onProgress).toHaveBeenCalledWith(
				expect.objectContaining({
					percent: 80
				})
			);
		});
	});
});
