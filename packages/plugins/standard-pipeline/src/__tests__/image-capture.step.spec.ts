import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImageCaptureStep } from '../steps/image-capture.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	MutableItemData
} from '@ever-works/plugin';

describe('ImageCaptureStep', () => {
	let step: ImageCaptureStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockScreenshotFacade = () => ({
		getSmartImage: vi.fn().mockResolvedValue({
			primaryImage: 'https://screenshots.example.com/image.png',
			source: 'screenshot'
		}),
		isAvailable: vi.fn().mockReturnValue(true)
	});

	const createMockDirectory = (): DirectoryReference => ({
		id: 'test-dir-id',
		slug: 'test-directory',
		name: 'Test Directory'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			config: {
				capture_screenshots: true,
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockItem = (name: string, source_url?: string, images?: string[]): MutableItemData =>
		({
			name,
			slug: name.toLowerCase().replace(/\s+/g, '-'),
			description: `Description for ${name}`,
			source_url,
			images
		}) as MutableItemData;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			finalItems: [createMockItem('Test Item', 'https://example.com')],
			domainAnalysis: { domain_type: 'software', confidence: 0.9 },
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	const expectedFacadeOptions = { userId: 'test-user-id', directoryId: 'test-dir-id' };

	beforeEach(() => {
		step = new ImageCaptureStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			screenshotFacade: createMockScreenshotFacade(),
			user: { id: 'test-user-id' },
			directory: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Image Capture');
		});
	});

	describe('run method', () => {
		it('should skip when capture_screenshots is disabled', async () => {
			mockContext.request = createMockRequest({
				config: { capture_screenshots: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.debug).toHaveBeenCalledWith(expect.stringContaining('disabled'));
			expect(result).toBe(mockContext);
		});

		it('should skip when screenshot service is not available', async () => {
			mockExecContext.screenshotFacade.isAvailable = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
			expect(result).toBe(mockContext);
		});

		it('should skip when no domain analysis is available', async () => {
			mockContext.domainAnalysis = undefined;

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('No domain analysis'));
			expect(result).toBe(mockContext);
		});

		it('should capture images for items without images', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledWith(
				{
					url: 'https://example.com',
					domainType: 'software',
					itemName: 'Test Item'
				},
				expectedFacadeOptions
			);
		});

		it('should skip items that already have images', async () => {
			mockContext.finalItems = [
				createMockItem('Item With Images', 'https://example.com', ['https://existing.com/img.png'])
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
		});

		it('should skip items without source_url', async () => {
			mockContext.finalItems = [createMockItem('Item No URL')];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).not.toHaveBeenCalled();
		});

		it('should add captured image to item images array', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images).toContain('https://screenshots.example.com/image.png');
		});

		it('should handle screenshot errors gracefully', async () => {
			mockExecContext.screenshotFacade.getSmartImage = vi.fn().mockRejectedValue(new Error('Screenshot failed'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to capture image')
			);
			expect(result.finalItems[0].images).toBeUndefined();
		});

		it('should process multiple items', async () => {
			mockContext.finalItems = [
				createMockItem('Item 1', 'https://example1.com'),
				createMockItem('Item 2', 'https://example2.com'),
				createMockItem('Item 3', 'https://example3.com')
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledTimes(3);
		});

		it('should skip items without primary image in result', async () => {
			mockExecContext.screenshotFacade.getSmartImage = vi.fn().mockResolvedValue({
				primaryImage: null,
				source: 'none'
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images).toBeUndefined();
		});

		it('should log completion message', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('Image capture complete'));
		});

		it('should use domain type from domain analysis', async () => {
			mockContext.domainAnalysis = { domain_type: 'ecommerce', confidence: 0.8 };

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.screenshotFacade.getSmartImage).toHaveBeenCalledWith(
				expect.objectContaining({ domainType: 'ecommerce' }),
				expectedFacadeOptions
			);
		});

		it('should preserve existing images when adding new ones', async () => {
			mockContext.finalItems = [createMockItem('Item', 'https://example.com', [])];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].images?.length).toBe(1);
		});
	});
});
