import type { ItemData } from '@ever-works/plugin';
import type { FacadeOptions } from '@ever-works/plugin';
import type { StepStatus } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

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

export async function captureScreenshots(
	items: readonly ItemData[],
	ctx: ScreenshotContext
): Promise<ScreenshotCaptureResult> {
	const errors: string[] = [];

	try {
		const itemsNeedingImages = items.filter(
			(item) => item.source_url && (!item.images || item.images.length === 0)
		);

		for (const item of itemsNeedingImages) {
			if (ctx.signal.aborted) {
				break;
			}

			// Security (SSRF): `source_url` originates from untrusted, Hermes-/LLM-
			// generated result items (written verbatim into the result JSON) and can
			// be steered via direct or indirect prompt injection to point at internal
			// / cloud-metadata targets (e.g. `http://169.254.169.254/...`, `file://`,
			// a loopback admin port). It is fetched server-side by the screenshot
			// provider, so gate it on the shared lexical SSRF guard (rejects non
			// HTTP(S) schemes and literal private/loopback/link-local/metadata IPs)
			// before handing it to the facade. Unsafe URLs are skipped; legitimate
			// https item URLs are unaffected. Mirrors the claude-managed-agent /
			// sim-ai guards for the same `source_url` -> getSmartImage path.
			if (!isSafeWebhookUrl(item.source_url!)) {
				ctx.logger.warn(`Skipping image for ${item.name}: source_url failed SSRF safety check`);
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
