import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import type { ComposioToolInput } from '../types.js';
import { DEFAULT_TARGET_ITEMS } from '../types.js';

interface PayloadOptions {
	work: WorkReference;
	request: GenerationRequest;
	existing: ExistingItems;
	config: Record<string, unknown>;
}

// Security: the `github-repo` data source carries a repository access token
// (often a GitHub PAT) verbatim into the third-party Composio tool arguments.
// Confirm `repo_url` is an `https://github.com/...` URL before attaching it so a
// malicious/typo'd `repo_url` (e.g. `https://attacker.example/x`) can never cause
// the PAT to be forwarded to an attacker-controlled host. `URL.hostname` isolates
// the authority host, so embedded credentials / `github.com.evil.com` tricks are
// rejected by the exact host equality check. Legitimate inputs (the form's own
// `https://github.com/org/repo` example) are unaffected.
function isGitHubHttpsUrl(value: unknown): boolean {
	if (typeof value !== 'string' || value.trim() === '') {
		return false;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com';
	} catch {
		return false;
	}
}

/**
 * Builds the `arguments` payload forwarded to the Composio tool.
 *
 * The returned object merges two layers:
 *  - **Envelope** — `metadata`, `existingSummary`, `dataSource`, `toolParams`.
 *    Custom Composio tools (or workflow tools fronted by Composio) can
 *    destructure these for work context.
 *  - **Flattened `tool_params`** — each key is also spread at the top level so
 *    catalog tools (Gmail, Slack, Sheets, …) see their required input fields
 *    where Composio expects them (e.g. `{ to, subject, body }` for Gmail send).
 *
 * Collision handling: if the user's `tool_params` contain a key that clashes
 * with an envelope key (e.g. `metadata`), the user's value wins via spread order.
 */
export function buildToolPayload(options: PayloadOptions): ComposioToolInput & Record<string, unknown> {
	const { work, request, existing, config } = options;

	const envelope: ComposioToolInput = {
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

	// Security: only attach the token-bearing dataSource when repo_url is a real
	// github.com HTTPS URL (see isGitHubHttpsUrl); otherwise the repo access token
	// is withheld entirely so it cannot leak to a non-GitHub host.
	if (config.pass_repo_access && isGitHubHttpsUrl(config.repo_url)) {
		envelope.dataSource = {
			type: 'github-repo',
			repoUrl: config.repo_url as string,
			accessToken: config.repo_access_token as string | undefined,
			branch: (config.repo_branch as string) || 'data',
			path: 'items/'
		};
	}

	const toolParams =
		config.tool_params && typeof config.tool_params === 'object'
			? (config.tool_params as Record<string, unknown>)
			: undefined;

	if (toolParams) {
		envelope.toolParams = toolParams;
	}

	return {
		...envelope,
		...(toolParams ?? {})
	};
}
