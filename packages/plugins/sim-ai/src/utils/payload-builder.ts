import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';
import type { SimWorkflowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	work: WorkReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

/**
 * Builds the input payload to send to the SIM workflow.
 * Uses inline data by default, with optional GitHub repo reference.
 */
export function buildWorkflowPayload(options: PayloadOptions): SimWorkflowInput {
	const { work, request, existing, config } = options;

	const payload: SimWorkflowInput = {
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
	// Security: the user-supplied repo_url is forwarded to the external SIM
	// workflow, which fetches it server-side. Without validation an attacker
	// could point it at http://169.254.169.254/, a private/loopback host, or a
	// non-HTTP scheme (file://) to probe internal services via the SIM runner
	// (SSRF). Gate the dataSource on the shared lexical SSRF guard (rejects
	// non-HTTP(S) schemes and literal private/loopback/link-local/cloud-metadata
	// IPs). Legitimate https://github.com/... URLs are unaffected; an unsafe URL
	// fails closed by omitting dataSource so the probe never reaches SIM.
	if (config.pass_repo_access && config.repo_url && isSafeWebhookUrl(config.repo_url as string)) {
		payload.dataSource = {
			type: 'github-repo',
			repoUrl: config.repo_url as string,
			accessToken: config.repo_access_token as string | undefined,
			branch: (config.repo_branch as string) || 'data',
			path: 'items/'
		};
	}

	// Custom workflow parameters
	if (config.workflow_params && typeof config.workflow_params === 'object') {
		payload.workflowParams = config.workflow_params as Record<string, unknown>;
	}

	return payload;
}
