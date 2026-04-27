import type { FacadeOptions, ItemData } from '@ever-works/plugin';

import type { ManagedAgentScreenshotFacade } from '../types.js';
import { delayWithSignal } from './pipeline-helpers.js';

export async function captureScreenshots(
	items: ItemData[],
	screenshotFacade: ManagedAgentScreenshotFacade,
	facadeOptions: FacadeOptions,
	signal: AbortSignal,
	logger: { warn(message: string, ...args: unknown[]): void }
): Promise<string[]> {
	if (!screenshotFacade.isAvailable()) {
		return [];
	}

	const warnings: string[] = [];

	for (const item of items) {
		if (signal.aborted) {
			break;
		}

		if (!item.source_url || (Array.isArray(item.images) && item.images.length > 0)) {
			continue;
		}

		try {
			const image = await screenshotFacade.getSmartImage(
				{
					url: item.source_url,
					itemName: item.name
				},
				facadeOptions
			);

			if (image.primaryImage) {
				(item as { images?: string[] }).images = [image.primaryImage];
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Unknown screenshot error';
			logger.warn(`Failed to capture screenshot for ${item.name}: ${reason}`);
			warnings.push(`Screenshot capture failed for ${item.name}: ${reason}`);
		}

		await delayWithSignal(250, signal);
	}

	return warnings;
}
