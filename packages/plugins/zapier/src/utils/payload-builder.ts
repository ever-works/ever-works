import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { ZapierWorkflowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	work: WorkReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

/**
 * Builds the `inputs` payload forwarded to the Zapier action.
 *
 * The returned object merges two layers:
 *  - **Envelope** — `metadata`, `existingSummary`, `dataSource`, `actionParams`.
 *    Custom Zaps can destructure these for work context.
 *  - **Flattened `action_params`** — each key is also spread at the top level so
 *    catalog actions (Gmail, Slack, Sheets, …) see their required input fields
 *    where Zapier expects them (e.g. `{ to, subject, body }` for Gmail send).
 *
 * Collision handling: reserved envelope keys (`metadata`, `existingSummary`,
 * `dataSource`, `actionParams`) are platform-owned and always win. Any matching
 * key in the user's free-form `action_params` is dropped from the top-level
 * flatten so it cannot forge the trusted work/tenant context (e.g. overwrite
 * `metadata.workId`). The user's full object is still available untouched under
 * the `actionParams` envelope key for Zaps that destructure it.
 */
const RESERVED_ENVELOPE_KEYS = new Set(['metadata', 'existingSummary', 'dataSource', 'actionParams']);
export function buildWorkflowPayload(options: PayloadOptions): ZapierWorkflowInput & Record<string, unknown> {
	const { work, request, existing, config } = options;

	const envelope: ZapierWorkflowInput = {
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

	if (config.pass_existing_items !== false && existing.items.length > 0) {
		envelope.existingSummary = {
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
		envelope.dataSource = {
			type: 'github-repo',
			repoUrl: config.repo_url as string,
			accessToken: config.repo_access_token as string | undefined,
			branch: (config.repo_branch as string) || 'data',
			path: 'items/'
		};
	}

	const actionParams =
		config.action_params && typeof config.action_params === 'object'
			? (config.action_params as Record<string, unknown>)
			: undefined;

	if (actionParams) {
		envelope.actionParams = actionParams;
	}

	// Security: flatten user-supplied action params at the top level (catalog
	// actions like Gmail/Slack expect their fields there) but never let them
	// shadow platform-owned envelope keys. Reserved keys are stripped from the
	// top-level spread so action_params cannot forge metadata/dataSource/etc.
	// (legitimate catalog fields — to, subject, body, channel… — never collide).
	const flattenedParams = actionParams
		? Object.fromEntries(Object.entries(actionParams).filter(([key]) => !RESERVED_ENVELOPE_KEYS.has(key)))
		: {};

	return {
		...flattenedParams,
		...envelope
	};
}
