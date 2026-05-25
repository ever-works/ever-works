import type {
	IPlugin,
	ISkillsProviderPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginSettings,
	SkillCatalogEntry,
	SkillCatalogListOptions,
	SkillCatalogListResult,
	SkillCatalogUpdate,
} from '@ever-works/plugin';

import matter from 'gray-matter';

/**
 * Ever Works Skills — first-party `skills-provider` plugin (ADR-012).
 *
 * Sources its catalog from the [`ever-works/skills`](https://github.com/ever-works/skills)
 * GitHub repo (per ADR-014). v1 ships with a small built-in fallback
 * catalog so the plugin works out of the box even before the
 * upstream repo is created — the platform self-recovers when the
 * repo appears.
 *
 * Future iteration: replace the built-in fallback with a real
 * git-clone + cache loader that pulls `.md` files from the repo's
 * `catalog/` subtree, parses frontmatter via `gray-matter`, and
 * caches in memory with a configurable TTL.
 */
const BUILTIN_CATALOG: SkillCatalogEntry[] = [
	{
		slug: 'cron-defaults',
		title: 'Cron defaults to UTC',
		description: 'When you see a cron expression, default the timezone to UTC unless the user explicitly says otherwise.',
		frontmatter: {
			name: 'cron-defaults',
			description: 'Cron timezone default',
			tags: ['scheduling', 'time'],
		},
		body: `When working with cron expressions:\n\n- Default to UTC unless the user explicitly says otherwise.\n- Match the platform's existing scheduling code which is UTC throughout.\n- When showing a cron expression to the user, also format the next 3 fire times in their local timezone for clarity.`,
		version: '1.0.0',
		tags: ['scheduling', 'time'],
	},
	{
		slug: 'secret-handling',
		title: 'Never log or echo secrets',
		description: 'Hard rule: never write API keys, tokens, or credentials to logs, chat, or Agent files.',
		frontmatter: {
			name: 'secret-handling',
			description: 'Secret handling policy',
			tags: ['security'],
		},
		body: `Secrets MUST NEVER appear in:\n\n- Log output (file, stdout, run-log rows).\n- Chat messages.\n- Agent definition files (SOUL.md, AGENTS.md, etc.).\n- Task descriptions or comments.\n\nIf you need to reference a secret, refer to its environment variable name only (e.g. \`OPENAI_API_KEY\`). The platform secret-scanner will reject writes containing values matching common secret patterns (\`sk-\`, \`ghp_\`, \`AKIA\`, \`glpat-\`, \`xoxb-\`, \`pat_\`).`,
		version: '1.0.0',
		tags: ['security'],
	},
	{
		slug: 'commit-message-style',
		title: 'Conventional commit messages',
		description: 'Format git commit messages following the conventional-commits spec.',
		frontmatter: {
			name: 'commit-message-style',
			description: 'Commit message format',
			tags: ['git', 'style'],
		},
		body: `When creating a git commit, follow conventional-commits:\n\n- Subject line: \`<type>(<scope>): <imperative description>\`\n- \`<type>\` is one of: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`.\n- \`<scope>\` is optional and names the affected package or module.\n- The body explains \`why\`, not \`what\` — the diff already shows \`what\`.\n- Wrap body lines at ~72 chars.`,
		version: '1.0.0',
		tags: ['git', 'style'],
	},
];

export class EverWorksSkillsPlugin implements IPlugin, ISkillsProviderPlugin {
	readonly id = 'everworks-skills';
	readonly name = 'Ever Works Skills';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility' as PluginCategory;
	readonly capabilities: readonly string[] = ['skills-provider'];
	readonly providerName = 'Ever Works Skills';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			catalogRepo: {
				type: 'string',
				title: 'Catalog GitHub repo',
				description: 'Owner/repo of the Skills catalog source. Defaults to ever-works/skills (ADR-014).',
				default: 'ever-works/skills',
				'x-envVar': 'PLUGIN_EVERWORKS_SKILLS_REPO',
			},
			catalogBranch: {
				type: 'string',
				title: 'Branch',
				default: 'main',
				'x-envVar': 'PLUGIN_EVERWORKS_SKILLS_BRANCH',
			},
			cacheTtlSeconds: {
				type: 'number',
				title: 'Cache TTL (seconds)',
				description: 'How long to cache the cloned catalog locally.',
				default: 3600,
				minimum: 0,
				maximum: 86400,
			},
		},
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;
	private cache: { entries: SkillCatalogEntry[]; fetchedAt: number } | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Ever Works Skills provider loaded (v1: builtin fallback catalog).');
	}

	async onUnload(): Promise<void> {
		this.cache = null;
	}

	isAvailable(_settings?: PluginSettings): boolean {
		return true;
	}

	async listEntries(options: SkillCatalogListOptions): Promise<SkillCatalogListResult> {
		const all = await this.loadAll(options.settings);
		const filtered = filterCatalog(all, options);
		const sliced = filtered.slice(options.offset, options.offset + options.limit);
		return { entries: sliced, total: filtered.length };
	}

	async getEntry(slug: string, settings?: PluginSettings): Promise<SkillCatalogEntry | null> {
		const all = await this.loadAll(settings);
		return all.find((e) => e.slug === slug) ?? null;
	}

	async checkForUpdates(
		installedVersions: Record<string, string>,
		settings?: PluginSettings,
	): Promise<{ updated: SkillCatalogUpdate[] }> {
		const all = await this.loadAll(settings);
		const updated: SkillCatalogUpdate[] = [];
		for (const entry of all) {
			const installed = installedVersions[entry.slug];
			if (installed && installed !== entry.version) {
				updated.push({ slug: entry.slug, oldVersion: installed, newVersion: entry.version });
			}
		}
		return { updated };
	}

	private async loadAll(settings?: PluginSettings): Promise<SkillCatalogEntry[]> {
		const ttl = Number(settings?.cacheTtlSeconds ?? 3600) * 1000;
		const now = Date.now();
		if (this.cache && now - this.cache.fetchedAt < ttl) {
			return this.cache.entries;
		}

		// TODO: Replace builtin fallback with a real git clone + cache
		// of `ever-works/skills` per ADR-014. When the upstream repo
		// is reachable, parse every `*.md` file via `gray-matter` into
		// a SkillCatalogEntry. Fall back to the builtin if the clone
		// fails so the plugin always returns SOMETHING.
		this.cache = { entries: BUILTIN_CATALOG.slice(), fetchedAt: now };
		void matter; // silence unused import warning until the loader wires up
		return this.cache.entries;
	}
}

function filterCatalog(
	entries: SkillCatalogEntry[],
	options: SkillCatalogListOptions,
): SkillCatalogEntry[] {
	let out = entries;
	if (options.search) {
		const q = options.search.toLowerCase();
		out = out.filter(
			(e) =>
				e.slug.includes(q) ||
				e.title.toLowerCase().includes(q) ||
				e.description.toLowerCase().includes(q),
		);
	}
	if (options.tags && options.tags.length > 0) {
		const requested = new Set(options.tags.map((t) => t.toLowerCase()));
		out = out.filter((e) => e.tags.some((t) => requested.has(t.toLowerCase())));
	}
	return out;
}
