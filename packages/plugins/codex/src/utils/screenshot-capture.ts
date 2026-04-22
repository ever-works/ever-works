import type { FacadeOptions, ItemData, StepStatus } from '@ever-works/plugin';
import { delay } from './pipeline-helpers.js';

const IMAGE_CAPTURE_DELAY_MS = 500;

export interface ScreenshotCaptureResult {
	status: StepStatus;
	errors: string[];
}

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

export async function captureScreenshots(items: ItemData[], ctx: ScreenshotContext): Promise<ScreenshotCaptureResult> {
	const errors: string[] = [];

	try {
		const itemsNeedingImages = items.filter(
			(item) => item.source_url && (!item.images || item.images.length === 0)
		);

		for (const item of itemsNeedingImages) {
			if (ctx.signal.aborted) {
				break;
			}

			try {
				const result = await ctx.screenshotFacade.getSmartImage(
					{ url: item.source_url!, itemName: item.name },
					ctx.facadeOptions
				);

				if (result.primaryImage) {
					(item as { images?: string[] }).images = [result.primaryImage, ...(item.images || [])];
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : 'Unknown error';
				ctx.logger.warn(`Failed to capture image for ${item.name}: ${reason}`);
				errors.push(reason);
			}

			await delay(IMAGE_CAPTURE_DELAY_MS);
		}

		return { status: 'completed', errors };
	} catch (error) {
		const reason = error instanceof Error ? error.message : 'Unknown error';
		ctx.logger.warn(`Screenshot step failed: ${reason}`);
		errors.push(reason);
		return { status: 'failed', errors };
	}
}
