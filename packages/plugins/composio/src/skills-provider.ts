import type {
	PluginSettings,
	SkillCatalogEntry,
	SkillCatalogListOptions,
	SkillCatalogListResult,
	SkillCatalogUpdate
} from '@ever-works/plugin';

import { ComposioClient } from './utils/composio-client.js';

const SKILL_VERSION = '1.0.0';
const ACTIVE_STATUS = 'ACTIVE';

interface BuildEntriesOptions {
	apiKey: string;
	baseUrl?: string;
	defaultUserId?: string;
	logger?: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
	fetchImpl?: typeof fetch;
}

/**
 * Implementation of the `skills-provider` capability for the Composio
 * plugin. Each ACTIVE Composio connected account the caller owns becomes
 * one `SkillCatalogEntry`, slugged `composio-<toolkit>`. The body is a
 * short markdown prompt instructing the agent how to invoke that
 * toolkit via the composio pipeline plugin during work generation.
 *
 * Kept as a free function (not on the plugin class) so it can be tested
 * standalone with an injected `fetch` and the plugin file stays focused.
 */
export async function buildSkillCatalogEntries({
	apiKey,
	baseUrl,
	defaultUserId,
	logger,
	fetchImpl
}: BuildEntriesOptions): Promise<SkillCatalogEntry[]> {
	if (!apiKey || !defaultUserId) return [];

	const client = new ComposioClient({
		apiKey,
		baseUrl,
		logger: logger ?? { log: () => undefined, warn: () => undefined },
		fetchImpl
	});

	const accounts = await client.listConnectedAccounts(defaultUserId);
	const activeBySlug = new Map<string, { id: string; slug: string }>();
	for (const account of accounts) {
		if ((account.status || '').toUpperCase() !== ACTIVE_STATUS) continue;
		const slug = (account.toolkit?.slug || '').trim().toUpperCase();
		if (!slug) continue;
		// First-wins: a user may have multiple connections per toolkit (e.g.
		// two Gmail accounts). The skill entry is per-toolkit, not per
		// account — the agent picks which user_id to call with.
		if (!activeBySlug.has(slug)) {
			activeBySlug.set(slug, { id: account.id, slug });
		}
	}

	const entries: SkillCatalogEntry[] = [];
	for (const { slug } of activeBySlug.values()) {
		entries.push(entryFor(slug, defaultUserId));
	}
	return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

function entryFor(toolkitSlug: string, defaultUserId: string): SkillCatalogEntry {
	const slug = `composio-${toolkitSlug.toLowerCase()}`;
	const title = `Composio: ${toolkitSlug}`;
	const description =
		`Call Composio tools in the ${toolkitSlug} toolkit during Work generation. ` +
		`The user has an ACTIVE Composio connection for this toolkit.`;
	const body =
		`# ${title}\n\n` +
		`This user has an **ACTIVE** Composio connection for the \`${toolkitSlug}\` toolkit.\n\n` +
		`When the user's task can be served by a ${toolkitSlug} tool (e.g. send an email, ` +
		`create an issue, read a document), use the **composio** pipeline plugin to execute ` +
		`the tool. Pass the following config:\n\n` +
		'```json\n' +
		JSON.stringify(
			{
				toolkit: toolkitSlug,
				tool_slug: `<TOOL_SLUG_TO_FILL_IN>`,
				composio_user_id: defaultUserId
			},
			null,
			2
		) +
		'\n```\n\n' +
		`Pick \`tool_slug\` from the toolkit's tool list (search composio.dev for ${toolkitSlug} ` +
		`tools or call \`GET /api/plugins/composio/toolkits\`). Do NOT invent slugs — Composio ` +
		`rejects unknown tools with HTTP 404.\n`;

	return {
		slug,
		title,
		description,
		frontmatter: {
			name: slug,
			description,
			tags: ['composio', toolkitSlug.toLowerCase(), 'integration']
		},
		body,
		version: SKILL_VERSION,
		tags: ['composio', toolkitSlug.toLowerCase(), 'integration']
	};
}

export function filterSkillCatalog(
	entries: SkillCatalogEntry[],
	options: SkillCatalogListOptions
): SkillCatalogListResult {
	let filtered = entries;
	if (options.search) {
		const q = options.search.toLowerCase();
		filtered = filtered.filter(
			(e) =>
				e.slug.includes(q) ||
				e.title.toLowerCase().includes(q) ||
				e.description.toLowerCase().includes(q)
		);
	}
	if (options.tags && options.tags.length > 0) {
		const requested = new Set(options.tags.map((t) => t.toLowerCase()));
		filtered = filtered.filter((e) => e.tags.some((t) => requested.has(t.toLowerCase())));
	}
	const total = filtered.length;
	const sliced = filtered.slice(options.offset, options.offset + options.limit);
	return { entries: sliced, total };
}

export function diffSkillCatalogVersions(
	entries: SkillCatalogEntry[],
	installedVersions: Record<string, string>
): { updated: SkillCatalogUpdate[] } {
	const updated: SkillCatalogUpdate[] = [];
	for (const entry of entries) {
		const installed = installedVersions[entry.slug];
		if (installed && installed !== entry.version) {
			updated.push({ slug: entry.slug, oldVersion: installed, newVersion: entry.version });
		}
	}
	return { updated };
}

export function readApiKey(settings?: PluginSettings): string | undefined {
	if (!settings) return undefined;
	const value = settings.apiKey;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

export function readBaseUrl(settings?: PluginSettings): string | undefined {
	if (!settings) return undefined;
	const value = settings.baseUrl;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

export function readDefaultUserId(settings?: PluginSettings): string | undefined {
	if (!settings) return undefined;
	const value = settings.defaultUserId;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}
