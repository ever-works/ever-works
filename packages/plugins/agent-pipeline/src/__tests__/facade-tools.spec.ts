import { describe, it, expect, vi } from 'vitest';
import { createSearchTool, createExtractContentTool, createReportProgressTool } from '../tools/facade-tools';
import type { ISearchFacade, IContentExtractorFacade, FacadeOptions } from '@ever-works/plugin';
import { MAX_EXTRACT_CONTENT_LENGTH } from '../types';

describe('facade-tools', () => {
	const facadeOptions: FacadeOptions = {
		userId: 'user1',
		directoryId: 'dir1'
	};

	describe('createSearchTool', () => {
		it('should create a tool with correct description', () => {
			const searchFacade = {
				search: vi.fn().mockResolvedValue([]),
				isConfigured: () => true
			} as unknown as ISearchFacade;

			const tool = createSearchTool(searchFacade, facadeOptions);

			expect(tool).toBeDefined();
			expect(tool.description).toContain('Search');
		});

		it('should call searchFacade.search with query and options', async () => {
			const mockResults = [
				{ title: 'Result 1', url: 'https://example.com', score: 0.9 },
				{ title: 'Result 2', url: 'https://example2.com', score: 0.8, publishedDate: '2024-01-01' }
			];

			const searchFacade = {
				search: vi.fn().mockResolvedValue(mockResults),
				isConfigured: () => true
			} as unknown as ISearchFacade;

			const tool = createSearchTool(searchFacade, facadeOptions);
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
	});

	describe('createExtractContentTool', () => {
		it('should create a tool with correct description', () => {
			const extractor = {
				extractContent: vi.fn().mockResolvedValue(null),
				isConfigured: () => true
			} as unknown as IContentExtractorFacade;

			const tool = createExtractContentTool(extractor, facadeOptions);

			expect(tool).toBeDefined();
			expect(tool.description).toContain('Extract');
		});

		it('should call extractContent and return content', async () => {
			const extractor = {
				extractContent: vi.fn().mockResolvedValue({
					url: 'https://example.com',
					rawContent: 'Hello World',
					images: ['img1.png']
				}),
				isConfigured: () => true
			} as unknown as IContentExtractorFacade;

			const tool = createExtractContentTool(extractor, facadeOptions);
			const result = await tool.execute!({ url: 'https://example.com' }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(extractor.extractContent).toHaveBeenCalledWith('https://example.com', undefined, facadeOptions);
			expect(result).toEqual({
				url: 'https://example.com',
				content: 'Hello World',
				images: ['img1.png']
			});
		});

		it('should truncate long content', async () => {
			const longContent = 'x'.repeat(MAX_EXTRACT_CONTENT_LENGTH + 1000);

			const extractor = {
				extractContent: vi.fn().mockResolvedValue({
					url: 'https://example.com',
					rawContent: longContent
				}),
				isConfigured: () => true
			} as unknown as IContentExtractorFacade;

			const tool = createExtractContentTool(extractor, facadeOptions);
			const result = await tool.execute!({ url: 'https://example.com' }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(result.content).toHaveLength(MAX_EXTRACT_CONTENT_LENGTH + '\n\n[Content truncated]'.length);
			expect(result.content).toContain('[Content truncated]');
		});

		it('should handle extraction failure', async () => {
			const extractor = {
				extractContent: vi.fn().mockResolvedValue(null),
				isConfigured: () => true
			} as unknown as IContentExtractorFacade;

			const tool = createExtractContentTool(extractor, facadeOptions);
			const result = await tool.execute!({ url: 'https://example.com' }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(result).toEqual({
				url: 'https://example.com',
				content: '',
				error: 'Failed to extract content'
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

		it('should handle undefined onProgress', async () => {
			const tool = createReportProgressTool(undefined, 1, 5);
			const result = await tool.execute!({ itemsCreated: 5 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(result).toEqual({ acknowledged: true, itemsCreated: 5 });
		});

		it('should use default message when none provided', async () => {
			const onProgress = vi.fn();

			const tool = createReportProgressTool(onProgress, 1, 5);
			await tool.execute!({ itemsCreated: 3 }, {
				toolCallId: 'call_1',
				messages: []
			} as never);

			expect(onProgress).toHaveBeenCalledWith(
				expect.objectContaining({
					message: 'Created 3 items'
				})
			);
		});
	});
});
