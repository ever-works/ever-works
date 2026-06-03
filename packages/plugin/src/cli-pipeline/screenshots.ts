import type { ItemData } from '../common/index.js';
import type { FacadeOptions } from '../facades/index.js';
import type { StepStatus } from '../pipeline/step-types.js';
import { isSafeWebhookUrl } from '../helpers/ssrf-guard.js';

const IMAGE_CAPTURE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScreenshotCaptureResult {
	status: StepStatus;
	errors: string[];
}

export interface ScreenshotContext {
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
			if (ctx.signal.aborted) break;

			// Security (SSRF): source_url is AI-generated and may contain
			// private/loopback/link-local or cloud-metadata addresses. Apply the
			// lexical SSRF guard before forwarding to the screenshot facade, which
			// passes the URL to an external screenshot service whose network
			// position is unknown. Skip items with unsafe URLs rather than aborting
			// the whole capture run.
			if (!isSafeWebhookUrl(item.source_url!)) {
				ctx.logger.warn(`Skipping unsafe/blocked source URL for screenshot: ${item.source_url}`);
				continue;
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
