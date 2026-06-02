import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { MakeWorkflowInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	work: WorkReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

// Security (DoS): `scenario_params` is an unconstrained, tenant-controlled
// `Record<string, unknown>` (Advanced form `type: 'json'` field) that is
// embedded verbatim in the outbound payload and later `JSON.stringify`-d into
// the Make.com request body. Without bounds, a malicious tenant can supply a
// huge map or a deeply nested object and exhaust CPU/memory during
// serialization. We cap nesting depth and total node count using an iterative,
// early-exit traversal (no recursion, never fully walks an oversized structure)
// so the check itself can't be turned into a DoS or blow the stack. Legitimate
// small parameter maps are unaffected. Circular references trip the node cap and
// are rejected. Throwing here is intentional: the pipeline call site wraps
// payload building in try/catch and surfaces a clean error result.
const MAX_SCENARIO_PARAMS_DEPTH = 8;
const MAX_SCENARIO_PARAMS_NODES = 5000;

function assertScenarioParamsWithinLimits(params: Record<string, unknown>): void {
	let nodeCount = 0;
	// Iterative depth-first walk with explicit [value, depth] frames.
	const stack: Array<{ value: unknown; depth: number }> = [{ value: params, depth: 0 }];

	while (stack.length > 0) {
		const { value, depth } = stack.pop() as { value: unknown; depth: number };

		if (depth > MAX_SCENARIO_PARAMS_DEPTH) {
			throw new Error(
				`Custom scenario parameters are nested too deeply (max ${MAX_SCENARIO_PARAMS_DEPTH} levels).`
			);
		}

		if (value === null || typeof value !== 'object') {
			continue;
		}

		const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
		for (const child of entries) {
			nodeCount += 1;
			if (nodeCount > MAX_SCENARIO_PARAMS_NODES) {
				throw new Error(
					`Custom scenario parameters are too large (max ${MAX_SCENARIO_PARAMS_NODES} values).`
				);
			}
			if (child !== null && typeof child === 'object') {
				stack.push({ value: child, depth: depth + 1 });
			}
		}
	}
}

/**
 * Builds the input payload to send to a Make.com scenario or webhook.
 * Uses inline data by default, with optional GitHub repo reference.
 */
export function buildWorkflowPayload(options: PayloadOptions): MakeWorkflowInput {
	const { work, request, existing, config } = options;

	const payload: MakeWorkflowInput = {
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

	// Custom scenario parameters
	if (config.scenario_params && typeof config.scenario_params === 'object') {
		const scenarioParams = config.scenario_params as Record<string, unknown>;
		// Security (DoS): bound size/depth of tenant-supplied params before they
		// are serialized into the outbound request body. See helper above.
		assertScenarioParamsWithinLimits(scenarioParams);
		payload.scenarioParams = scenarioParams;
	}

	return payload;
}
