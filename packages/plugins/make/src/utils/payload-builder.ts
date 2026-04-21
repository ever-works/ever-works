import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { MakeWorkflowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	directory: DirectoryReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

/**
 * Builds the input payload to send to a Make.com scenario or webhook.
 * Uses inline data by default, with optional GitHub repo reference.
 */
export function buildWorkflowPayload(options: PayloadOptions): MakeWorkflowInput {
	const { directory, request, existing, config } = options;

	const payload: MakeWorkflowInput = {
		metadata: {
			directoryId: directory.id,
			directoryName: directory.name,
			directorySlug: directory.slug,
			directoryDescription: directory.description,
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

	// Custom scenario parameters
	if (config.scenario_params && typeof config.scenario_params === 'object') {
		payload.scenarioParams = config.scenario_params as Record<string, unknown>;
	}

	return payload;
}
