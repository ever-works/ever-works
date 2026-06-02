import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { ActivepiecesFlowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';
// Direct import (NOT via `@ever-works/plugin/helpers`): the SSRF guard pulls in
// `node:net` / `node:dns` and is intentionally excluded from the helpers barrel.
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

/**
 * Security (SSRF / supply-chain): the data-repository URL is tenant-supplied and is
 * forwarded verbatim inside the webhook payload to Activepieces, where downstream flow
 * steps clone/fetch from it. `validateFormInput` only checks the field is non-empty, so
 * without this guard a tenant could point the flow (and the attached access token) at an
 * internal host (`http://internal-secrets-service/`), a non-HTTP scheme (`file:///etc/...`),
 * a cloud-metadata endpoint, or a github.com lookalike (`https://github.com.evil.com/`).
 *
 * Accepts only a parseable `https://` URL whose host is exactly `github.com` and that also
 * clears the lexical SSRF guard. Parsing via `URL` (rather than a `startsWith('https://github.com/')`
 * string check) is deliberate so credential/lookalike hosts like `https://github.com@evil.com/`
 * or `https://github.com.evil.com/` are rejected. Throws on anything else; the pipeline's
 * try/catch surfaces it as a normal error result. Mirrors the `resolveSafeBaseUrl` guard.
 */
function assertSafeGithubRepoUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error('Data repository URL is not a valid URL.');
	}
	if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
		throw new Error('Data repository URL must be an https://github.com/... repository URL.');
	}
	if (!isSafeWebhookUrl(trimmed)) {
		throw new Error('Data repository URL is not safe to forward (SSRF guard blocked the destination host).');
	}
	return trimmed;
}

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
		// Security (SSRF / supply-chain): validate the tenant-supplied repo URL before it
		// (and any access token) is forwarded to the Activepieces flow. See assertSafeGithubRepoUrl.
		const repoUrl = assertSafeGithubRepoUrl(String(config.repo_url));
		payload.dataSource = {
			type: 'github-repo',
			repoUrl,
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
