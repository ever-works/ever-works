import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	MutableItemData,
	DomainType
} from '@ever-works/plugin';

const IMAGE_CAPTURE_DELAY_MS = 500;

/**
 * Image Capture Step
 *
 * Captures screenshots for items that don't have images.
 * Uses the Screenshot Facade for smart image routing based on domain type.
 */
export class ImageCaptureStep implements IBuiltInStepExecutor {
	readonly name = 'Image Capture';

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { directory, request, finalItems, domainAnalysis } = context;
		const { logger, screenshotFacade } = execContext;
		const config = request.config || {};

		if (!config.capture_screenshots) {
			logger.debug(`[${directory.slug}] Image capture disabled, skipping`);
			return context;
		}

		if (!screenshotFacade.isAvailable()) {
			logger.warn(`[${directory.slug}] Screenshot service not configured, skipping image capture`);
			return context;
		}

		if (!domainAnalysis) {
			logger.warn(`[${directory.slug}] No domain analysis available, skipping image capture`);
			return context;
		}

		const itemsNeedingImages = finalItems.filter(
			(item) => item.source_url && (!item.images || item.images.length === 0)
		);

		if (itemsNeedingImages.length === 0) {
			logger.debug(`[${directory.slug}] No items need images`);
			return context;
		}

		const domainType = domainAnalysis.domain_type as DomainType;
		logger.log(
			`[${directory.slug}] Capturing images for ${itemsNeedingImages.length} items (domain: ${domainType})`
		);

		for (const item of itemsNeedingImages) {
			try {
				const result = await screenshotFacade.getSmartImage({
					url: item.source_url!,
					domainType,
					itemName: item.name
				});

				if (result.primaryImage) {
					item.images = [result.primaryImage, ...(item.images || [])];
					logger.debug(`[${directory.slug}] Captured ${result.source} image for ${item.name}`);
				}
			} catch (error) {
				logger.warn(
					`[${directory.slug}] Failed to capture image for ${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}

			await this.delay(IMAGE_CAPTURE_DELAY_MS);
		}

		logger.log(`[${directory.slug}] Image capture complete for ${itemsNeedingImages.length} items`);

		return context;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
