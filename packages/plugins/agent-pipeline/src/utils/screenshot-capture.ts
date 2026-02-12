import type { ItemData, FacadeOptions, StepStatus } from '@ever-works/plugin';
import { delay } from './pipeline-helpers.js';

const IMAGE_CAPTURE_DELAY_MS = 500;

interface ScreenshotContext {
	screenshotFacade: {
		isAvailable(): boolean;
		getSmartImage(
			params: { url: string; itemName: string },
			options: FacadeOptions
		): Promise<{ primaryImage?: string }>;
	};
	facadeOptions: FacadeOptions;
	signal: AbortSignal;
	logger: { warn(...args: unknown[]): void };
}

/**
 * Captures screenshots for items that need images.
 * This step is always non-fatal — errors are logged but never propagate.
 *
 * @returns The step status: 'completed' if screenshots were captured, 'failed' if the step errored.
 */
export async function captureScreenshots(items: ItemData[], ctx: ScreenshotContext): Promise<StepStatus> {
	try {
		const itemsNeedingImages = items.filter(
			(item) => item.source_url && (!item.images || item.images.length === 0)
		);

		for (const item of itemsNeedingImages) {
			if (ctx.signal.aborted) break;

			try {
				const result = await ctx.screenshotFacade.getSmartImage(
					{ url: item.source_url!, itemName: item.name },
					ctx.facadeOptions
				);

				if (result.primaryImage) {
					(item as { images?: string[] }).images = [result.primaryImage, ...(item.images || [])];
				}
			} catch (error) {
				ctx.logger.warn(
					`Failed to capture image for ${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}

			await delay(IMAGE_CAPTURE_DELAY_MS);
		}

		return 'completed';
	} catch (error) {
		ctx.logger.warn(`Screenshot step failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		return 'failed';
	}
}
