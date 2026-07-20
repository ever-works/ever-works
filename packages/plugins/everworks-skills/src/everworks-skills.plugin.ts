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
	SkillFrontmatter
} from '@ever-works/plugin';

import matter from 'gray-matter';

const RAW_CONTENT_BASE = 'https://raw.githubusercontent.com';
const DEFAULT_CATALOG_REPO = 'ever-works/skills';
const DEFAULT_CATALOG_BRANCH = 'main';
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
// Guard rails so a malformed admin setting can't build a surprising URL.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_PATTERN = /^[\w./-]+$/;

/**
 * One row of the `ever-works/skills` `manifest.json` (ADR-014). All
 * fields are treated as optional/untrusted at parse time — the loader
 * validates `slug` + `skillPath` before building a catalog entry.
 */
interface SkillsManifestRow {
	slug?: string;
	name?: string;
	summary?: string;
	skillPath?: string;
	path?: string;
	tags?: string[];
	version?: string;
	license?: string;
	sourceUrl?: string;
}

/**
 * Ever Works Skills — first-party `skills-provider` plugin (ADR-012).
 *
 * Sources its catalog from the public [`ever-works/skills`](https://github.com/ever-works/skills)
 * GitHub repo (per ADR-014). The loader fetches `manifest.json` from
 * the configured repo/branch over a plain HTTPS GET (the repo is
 * public — no auth), then fetches each row's `SKILL.md`, parses its
 * frontmatter via `gray-matter`, and caches the union in memory with
 * a configurable TTL. If the repo is unreachable (or the manifest is
 * malformed) the loader falls back to the small `BUILTIN_CATALOG`
 * below so the plugin always returns SOMETHING — the platform
 * self-recovers when the repo becomes reachable again.
 */
const BUILTIN_CATALOG: SkillCatalogEntry[] = [
	{
		slug: 'cron-defaults',
		title: 'Cron defaults to UTC',
		description:
			'When you see a cron expression, default the timezone to UTC unless the user explicitly says otherwise.',
		frontmatter: {
			name: 'cron-defaults',
			description: 'Cron timezone default',
			tags: ['scheduling', 'time']
		},
		body: `When working with cron expressions:\n\n- Default to UTC unless the user explicitly says otherwise.\n- Match the platform's existing scheduling code which is UTC throughout.\n- When showing a cron expression to the user, also format the next 3 fire times in their local timezone for clarity.`,
		version: '1.0.0',
		tags: ['scheduling', 'time']
	},
	{
		slug: 'secret-handling',
		title: 'Never log or echo secrets',
		description: 'Hard rule: never write API keys, tokens, or credentials to logs, chat, or Agent files.',
		frontmatter: {
			name: 'secret-handling',
			description: 'Secret handling policy',
			tags: ['security']
		},
		body: `Secrets MUST NEVER appear in:\n\n- Log output (file, stdout, run-log rows).\n- Chat messages.\n- Agent definition files (SOUL.md, AGENTS.md, etc.).\n- Task descriptions or comments.\n\nIf you need to reference a secret, refer to its environment variable name only (e.g. \`OPENAI_API_KEY\`). The platform secret-scanner will reject writes containing values matching common secret patterns (\`sk-\`, \`ghp_\`, \`AKIA\`, \`glpat-\`, \`xoxb-\`, \`pat_\`).`,
		version: '1.0.0',
		tags: ['security']
	},
	{
		slug: 'commit-message-style',
		title: 'Conventional commit messages',
		description: 'Format git commit messages following the conventional-commits spec.',
		frontmatter: {
			name: 'commit-message-style',
			description: 'Commit message format',
			tags: ['git', 'style']
		},
		body: `When creating a git commit, follow conventional-commits:\n\n- Subject line: \`<type>(<scope>): <imperative description>\`\n- \`<type>\` is one of: \`feat\`, \`fix\`, \`docs\`, \`refactor\`, \`test\`, \`chore\`.\n- \`<scope>\` is optional and names the affected package or module.\n- The body explains \`why\`, not \`what\` — the diff already shows \`what\`.\n- Wrap body lines at ~72 chars.`,
		version: '1.0.0',
		tags: ['git', 'style']
	}
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
				'x-envVar': 'PLUGIN_EVERWORKS_SKILLS_REPO'
			},
			catalogBranch: {
				type: 'string',
				title: 'Branch',
				default: 'main',
				'x-envVar': 'PLUGIN_EVERWORKS_SKILLS_BRANCH'
			},
			cacheTtlSeconds: {
				type: 'number',
				title: 'Cache TTL (seconds)',
				description: 'How long to cache the cloned catalog locally.',
				default: 3600,
				minimum: 0,
				maximum: 86400
			}
		}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;
	private cache: { entries: SkillCatalogEntry[]; fetchedAt: number } | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Ever Works Skills provider loaded (catalog: ever-works/skills, builtin fallback).');
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
		settings?: PluginSettings
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
		// Security: clamp TTL to [0, 86400] at runtime to prevent Infinity/NaN bypass of schema-only constraint
		const rawTtl = Number(settings?.cacheTtlSeconds ?? 3600);
		const ttlSeconds = isNaN(rawTtl) ? 3600 : Math.max(0, Math.min(rawTtl, 86400));
		const ttl = ttlSeconds * 1000;
		const now = Date.now();
		if (this.cache && now - this.cache.fetchedAt < ttl) {
			return this.cache.entries;
		}

		const repo = resolveRepo(settings?.catalogRepo);
		const branch = resolveBranch(settings?.catalogBranch);

		try {
			const entries = await this.fetchCatalog(repo, branch);
			if (entries.length === 0) {
				throw new Error('catalog manifest yielded no entries');
			}
			this.cache = { entries, fetchedAt: now };
			return entries;
		} catch (err) {
			// Fall back to the builtin catalog on ANY failure (network,
			// non-200, malformed manifest/frontmatter) so the plugin
			// always returns SOMETHING. Cache the fallback so a sustained
			// outage doesn't re-hit the upstream on every request; the
			// TTL governs when we retry the live fetch.
			this.context?.logger.warn(
				`Ever Works Skills: catalog fetch from ${repo}@${branch} failed; using builtin fallback. ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
			this.cache = { entries: BUILTIN_CATALOG.slice(), fetchedAt: now };
			return this.cache.entries;
		}
	}

	private async fetchCatalog(repo: string, branch: string): Promise<SkillCatalogEntry[]> {
		const manifestUrl = `${RAW_CONTENT_BASE}/${repo}/${branch}/manifest.json`;
		const manifestText = await fetchText(manifestUrl);
		const rows = extractManifestRows(JSON.parse(manifestText));

		// Fetch every SKILL.md in parallel; a single failure rejects the
		// batch and trips the builtin fallback in loadAll().
		return Promise.all(rows.map((row) => this.fetchEntry(repo, branch, row)));
	}

	private async fetchEntry(repo: string, branch: string, row: SkillsManifestRow): Promise<SkillCatalogEntry> {
		const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
		const skillPath = typeof row.skillPath === 'string' ? row.skillPath.trim() : '';
		if (!slug || !skillPath) {
			throw new Error(`invalid manifest row (missing slug/skillPath): ${JSON.stringify(row)}`);
		}

		const skillUrl = `${RAW_CONTENT_BASE}/${repo}/${branch}/${skillPath.replace(/^\/+/, '')}`;
		const markdown = await fetchText(skillUrl);
		const parsed = matter(markdown);
		const frontmatter = normalizeFrontmatter(parsed.data, slug, row);

		return {
			slug,
			title: firstNonEmpty(row.name, frontmatter.name, slug),
			description: firstNonEmpty(row.summary, frontmatter.description, ''),
			frontmatter,
			body: parsed.content.trim(),
			version: firstNonEmpty(row.version, asString(parsed.data.version), '1.0.0'),
			tags: normalizeTags(row.tags, frontmatter.tags),
			...(typeof row.sourceUrl === 'string' && row.sourceUrl ? { sourceUrl: row.sourceUrl } : {})
		};
	}
}

/**
 * Fetch a URL as text with a hard timeout. Rejects on any transport
 * error or non-2xx response so callers can uniformly fall back.
 */
async function fetchText(url: string): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: 'text/plain, application/json, */*' }
		});
		if (!res.ok) {
			throw new Error(`GET ${url} -> HTTP ${res.status}`);
		}
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

/** Accept either a bare array or the `{ skills: [...] }` envelope. */
function extractManifestRows(parsed: unknown): SkillsManifestRow[] {
	if (Array.isArray(parsed)) {
		return parsed as SkillsManifestRow[];
	}
	if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { skills?: unknown }).skills)) {
		return (parsed as { skills: SkillsManifestRow[] }).skills;
	}
	throw new Error('manifest.json does not contain a skills array');
}

/**
 * Build a `SkillFrontmatter` from the parsed SKILL.md frontmatter,
 * preserving any extra keys (`allowedTools`, etc.) while guaranteeing
 * the required `name`/`description` strings.
 */
function normalizeFrontmatter(data: Record<string, unknown>, slug: string, row: SkillsManifestRow): SkillFrontmatter {
	const name = firstNonEmpty(asString(data.name), row.name, slug);
	const description = firstNonEmpty(asString(data.description), row.summary, '');
	return { ...data, name, description };
}

/** Prefer the curated manifest tags; fall back to frontmatter tags. */
function normalizeTags(rowTags: unknown, frontmatterTags: unknown): string[] {
	const source = Array.isArray(rowTags) ? rowTags : Array.isArray(frontmatterTags) ? frontmatterTags : [];
	return source.filter((t): t is string => typeof t === 'string');
}

function resolveRepo(value: unknown): string {
	const repo = asString(value);
	return repo && REPO_PATTERN.test(repo) ? repo : DEFAULT_CATALOG_REPO;
}

function resolveBranch(value: unknown): string {
	const branch = asString(value);
	return branch && BRANCH_PATTERN.test(branch) ? branch : DEFAULT_CATALOG_BRANCH;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** First argument that is a non-empty (trimmed) string. */
function firstNonEmpty(...values: Array<string | undefined>): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return '';
}

function filterCatalog(entries: SkillCatalogEntry[], options: SkillCatalogListOptions): SkillCatalogEntry[] {
	let out = entries;
	if (options.search) {
		const q = options.search.toLowerCase();
		out = out.filter(
			(e) => e.slug.includes(q) || e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
		);
	}
	if (options.tags && options.tags.length > 0) {
		const requested = new Set(options.tags.map((t) => t.toLowerCase()));
		out = out.filter((e) => e.tags.some((t) => requested.has(t.toLowerCase())));
	}
	return out;
}
