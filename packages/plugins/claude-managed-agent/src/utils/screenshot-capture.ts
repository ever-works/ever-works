import type { FacadeOptions, ItemData } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

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

		// Security (SSRF): `source_url` originates from untrusted, LLM-generated
		// structured output (result-parser passes it through verbatim) and can be
		// steered via direct or indirect prompt injection to point at internal /
		// cloud-metadata targets (e.g. `http://169.254.169.254/...`, `file://`,
		// a loopback admin port). It is fetched server-side by the screenshot
		// provider, so gate it on the shared lexical SSRF guard (rejects non
		// HTTP(S) schemes and literal private/loopback/link-local/metadata IPs)
		// before handing it to the facade. Unsafe URLs are skipped; legitimate
		// https item URLs are unaffected. Mirrors the sim-ai result-parser guard
		// for the same `source_url` -> getSmartImage path.
		if (!isSafeWebhookUrl(item.source_url)) {
			logger.warn(`Skipping screenshot for ${item.name}: source_url failed SSRF safety check`);
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
