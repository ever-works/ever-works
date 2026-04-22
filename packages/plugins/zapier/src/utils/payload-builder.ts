import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { ZapierWorkflowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	directory: DirectoryReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

/**
 * Builds the `inputs` payload forwarded to the Zapier action.
 * Uses inline data by default, with optional GitHub repo reference.
 */
export function buildWorkflowPayload(options: PayloadOptions): ZapierWorkflowInput {
	const { directory, request, existing, config } = options;

	const payload: ZapierWorkflowInput = {
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

	if (config.pass_repo_access && config.repo_url) {
		payload.dataSource = {
			type: 'github-repo',
			repoUrl: config.repo_url as string,
			accessToken: config.repo_access_token as string | undefined,
			branch: (config.repo_branch as string) || 'data',
			path: 'items/'
		};
	}

	if (config.action_params && typeof config.action_params === 'object') {
		payload.actionParams = config.action_params as Record<string, unknown>;
	}

	return payload;
}
