import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { ActivepiecesFlowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	work: WorkReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

/**
 * Builds the input payload to send to the Activepieces flow webhook.
 * Uses inline data by default, with optional GitHub repo reference.
 */
export function buildFlowPayload(options: PayloadOptions): ActivepiecesFlowInput {
	const { work, request, existing, config } = options;

	const payload: ActivepiecesFlowInput = {
		metadata: {
			workId: work.id,
			workName: work.name,
			workSlug: work.slug,
			workDescription: work.description,
			prompt: request.prompt,
			generationMethod: request.generationMethod,
			targetItems: (config.target_items as number) ?? DEFAULT_TARGET_ITEMS
		}
	};

	// Strategy 1: Inline existing items summary
	if (config.pass_existing_items !== false && existing.items.length > 0) {
		payload.existingSummary = {
			totalItems: existing.items.length,
			categories: existing.categories.map((c) => c.name),
			tags: existing.tags.map((t) => t.name),
			sampleItems: existing.items.slice(0, 20).map((item) => ({
				name: item.name,
				url: item.source_url
			}))
		};
	}

	// Strategy 2: GitHub repository reference
	if (config.pass_repo_access && config.repo_url) {
		payload.dataSource = {
			type: 'github-repo',
			repoUrl: config.repo_url as string,
			accessToken: config.repo_access_token as string | undefined,
			branch: (config.repo_branch as string) || 'data',
			path: 'items/'
		};
	}

	// Custom flow parameters
	if (config.flow_params && typeof config.flow_params === 'object') {
		payload.flowParams = config.flow_params as Record<string, unknown>;
	}

	return payload;
}
