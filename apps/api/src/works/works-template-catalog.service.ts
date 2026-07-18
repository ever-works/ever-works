import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { GitFacadeService } from '@ever-works/agent/facades';

/**
 * Work-blueprint catalog (Works Templates spec, ADR-014).
 *
 * Reads the curated `manifest.json` index from the external, PUBLIC
 * `ever-works/works` repo, maps its `blueprints[]` to the stable
 * `WorkBlueprintEntry` shape the web app consumes, and caches it for 1h
 * in the shared `cache_entries` store.
 *
 * This mirrors `AgentTemplateCatalogService` with ONE deliberate
 * divergence: `ever-works/works` is a PUBLIC repo, so the primary read
 * is tokenless — a plain `fetch` of `raw.githubusercontent.com` with a
 * real `User-Agent` + a bounded timeout. A `GitFacadeService.getFileContent`
 * read (using the platform GitHub App installation token / env token) is
 * the rate-limit / future-private-repo fallback. Every failure path
 * (unreachable, rate-limited, malformed manifest) returns an empty array
 * — the web layer then falls back to its built-in blueprint list, so the
 * Create-Work chips + selector never break.
 *
 * Pin the source ref with `EVER_WORKS_WORKS_REF` (default `main`) — the
 * service warns once when a mutable branch ref is used so operators know
 * to pin a commit SHA / version tag in production (supply-chain-
 * substitution guard, copied from the agent service).
 */

export interface WorkBlueprintEntry {
    /** Stable id; becomes `CreateWorkDto.websiteTemplateId`. */
    slug: string;
    /** Short selector label. */
    name: string;
    /** Full card title. */
    title: string;
    /** From manifest `summary`. */
    description: string;
    /** website | landing | blog | directory | store | company | awesome. */
    chipType: string;
    /** Chip value / Work intent (landing-page, awesome-repo, …). */
    kind: string;
    /** Coarse search facet. */
    category?: string;
    /** PascalCase Lucide id, resolved at render time. */
    iconName?: string;
    /** Search-friendly tags. */
    tags?: string[];
    /** manifest `default: true`. */
    isDefault: boolean;
    /** manifest `featured: true`. */
    featured: boolean;
    /** production | beta | placeholder — placeholders are non-selectable. */
    status: WorkBlueprintStatus;
    // Resolution coordinates — consumed only server-side at create time.
    /** Parsed from `template.repo` (null for placeholder rows). */
    templateRepoOwner: string | null;
    templateRepoName: string | null;
    /** `sha` ?? `ref` (null when neither is set). */
    templateRef: string | null;
    /** → `CreateWorkDto.organization`. */
    isOrganization: boolean;
    gitProvider?: string;
    storageProvider?: string;
    deployProvider?: string;
}

export type WorkBlueprintStatus = 'production' | 'beta' | 'placeholder';

/** Shape of a `manifest.json` `blueprints[]` row in `ever-works/works`. */
interface RawBlueprint {
    slug?: unknown;
    name?: unknown;
    title?: unknown;
    summary?: unknown;
    kind?: unknown;
    chipType?: unknown;
    category?: unknown;
    tags?: unknown;
    isOrganization?: unknown;
    default?: unknown;
    featured?: unknown;
    status?: unknown;
    avatarIcon?: unknown;
    template?: unknown;
    defaults?: unknown;
}

const DEFAULT_WORKS_REPO = 'ever-works/works';
const MANIFEST_PATH = 'manifest.json';
const RAW_HOST = 'https://raw.githubusercontent.com';
const CACHE_TTL_MS = 60 * 60 * 1000;
const RAW_FETCH_TIMEOUT_MS = 8000;
// A real User-Agent — the raw host tolerates empty UAs, but we send one for
// parity with the CF-proxied `api.ever.works` (which 403s empty UAs) and for
// rate-limit etiquette.
const RAW_USER_AGENT = 'ever-works-platform (+https://ever.works)';

// Security: allowlist pattern for safe slug values from the external manifest.
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Security: `template.repo` MUST be inside the `ever-works` org — we only ever
// fork from repos we control, so a hostile/forked manifest cannot make the
// platform clone attacker-controlled code (SSRF / fork-source containment).
const SAFE_REPO_RE = /^ever-works\/[a-z0-9-]+$/;
// Security: max lengths to cap unbounded string fields from the external manifest.
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_TAG_LEN = 60;
const MAX_TAGS = 8;

/**
 * Security: strip HTML tags from a manifest string field so a compromised
 * `ever-works/works` repo cannot inject XSS payloads into values the web
 * frontend may render. Narrow regex, sufficient for the plain-text fields
 * we consume (no DOM sanitizer in the API runtime).
 */
function stripHtml(value: string): string {
    return value.replace(/<[^>]*>/g, '');
}

/** `folder-tree` → `FolderTree` so the client icon map (PascalCase lucide
 *  names) can resolve repo `avatarIcon` ids. */
function kebabToPascal(value: string): string {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((v): v is string => typeof v === 'string');
    return out.length > 0 ? out : undefined;
}

function toSafeSlug(value: unknown): string | null {
    return typeof value === 'string' && SAFE_SLUG_RE.test(value) ? value : null;
}

function toOptionalProvider(value: unknown): string | undefined {
    return typeof value === 'string' && SAFE_SLUG_RE.test(value) ? value : undefined;
}

function normalizeStatus(value: unknown): WorkBlueprintStatus {
    return value === 'beta' || value === 'placeholder' ? value : 'production';
}

/**
 * Map + sanitize one manifest `blueprints[]` row into a `WorkBlueprintEntry`.
 * Returns null for rows that fail the slug/chipType allowlist or (when not a
 * placeholder) lack a valid `ever-works/*` fork source.
 */
function mapBlueprint(row: RawBlueprint): WorkBlueprintEntry | null {
    // Security: reject slugs / chipTypes that don't match the strict allowlist
    // so a compromised manifest cannot inject arbitrary strings.
    const slug = toSafeSlug(row?.slug);
    if (!slug) return null;
    const chipType = toSafeSlug(row.chipType);
    if (!chipType) return null;
    // `kind` falls back to `chipType` when absent/invalid (chip value / intent).
    const kind = toSafeSlug(row.kind) ?? chipType;

    const status = normalizeStatus(row.status);

    // Security: strip HTML + cap lengths on every string field from the manifest.
    const rawTags = asStringArray(row.tags)
        ?.slice(0, MAX_TAGS)
        .map((t) => stripHtml(t).slice(0, MAX_TAG_LEN));
    const tags = rawTags && rawTags.length > 0 ? rawTags : undefined;

    const name = stripHtml((typeof row.name === 'string' && row.name) || slug).slice(
        0,
        MAX_TITLE_LEN,
    );
    const title = stripHtml(
        (typeof row.title === 'string' && row.title) ||
            (typeof row.name === 'string' && row.name) ||
            slug,
    ).slice(0, MAX_TITLE_LEN);
    const description = stripHtml(typeof row.summary === 'string' ? row.summary : '').slice(
        0,
        MAX_DESC_LEN,
    );

    const category = toSafeSlug(row.category) ?? undefined;

    // Template coordinates + SSRF containment.
    const template = (row.template && typeof row.template === 'object' ? row.template : {}) as {
        repo?: unknown;
        ref?: unknown;
        sha?: unknown;
    };
    let templateRepoOwner: string | null = null;
    let templateRepoName: string | null = null;
    if (typeof template.repo === 'string' && SAFE_REPO_RE.test(template.repo)) {
        const [owner, repoName] = template.repo.split('/');
        templateRepoOwner = owner;
        templateRepoName = repoName;
    }
    // A non-placeholder blueprint MUST carry a valid ever-works fork source; a
    // placeholder (store/company before their repos are public) may not.
    if (status !== 'placeholder' && !templateRepoName) return null;

    const sha = typeof template.sha === 'string' && template.sha.length > 0 ? template.sha : null;
    const ref = typeof template.ref === 'string' && template.ref.length > 0 ? template.ref : null;
    const templateRef = sha ?? ref;

    const defaults = (row.defaults && typeof row.defaults === 'object' ? row.defaults : {}) as {
        gitProvider?: unknown;
        storageProvider?: unknown;
        deployProvider?: unknown;
    };

    return {
        slug,
        name,
        title,
        description,
        chipType,
        kind,
        category,
        iconName: typeof row.avatarIcon === 'string' ? kebabToPascal(row.avatarIcon) : undefined,
        tags,
        isDefault: row.default === true,
        featured: row.featured === true,
        status,
        templateRepoOwner,
        templateRepoName,
        templateRef,
        isOrganization: row.isOrganization === true,
        gitProvider: toOptionalProvider(defaults.gitProvider),
        storageProvider: toOptionalProvider(defaults.storageProvider),
        deployProvider: toOptionalProvider(defaults.deployProvider),
    };
}

@Injectable()
export class WorksTemplateCatalogService {
    private readonly logger = new Logger(WorksTemplateCatalogService.name);
    private warnedFetchFailed = false;

    constructor(
        private readonly git: GitFacadeService,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
    ) {}

    private get repoCoords(): { owner: string; repo: string } {
        const spec = process.env.EVER_WORKS_WORKS_REPO || DEFAULT_WORKS_REPO;
        const [owner, repo] = spec.split('/');
        if (!owner || !repo) {
            return { owner: 'ever-works', repo: 'works' };
        }
        return { owner, repo };
    }

    /**
     * Return the blueprint catalog. Without `chipType` returns the full
     * catalog; with a `chipType` returns the filtered slice. Placeholder
     * rows are included (flagged `status: 'placeholder'`) so coming-soon
     * chips can render — the web selector filters them out of the pickable
     * options.
     */
    async list(chipType?: string): Promise<WorkBlueprintEntry[]> {
        const ref = process.env.EVER_WORKS_WORKS_REF || 'main';
        // Security: warn operators when a mutable branch ref (not a pinned
        // commit SHA or semver tag) is used, so they know to set
        // EVER_WORKS_WORKS_REF to a commit SHA (40 hex chars) or a version tag
        // (vX.Y.Z) in production to prevent supply-chain substitution after
        // cache expiry.
        const isPinnedRef = /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+(\.\d+)?$/.test(ref);
        if (!isPinnedRef) {
            this.logger.warn(
                `EVER_WORKS_WORKS_REF is set to a mutable ref '${ref}'. ` +
                    'Pin to a commit SHA (40 hex chars) or a version tag (vX.Y.Z) in production ' +
                    'to prevent supply-chain substitution after cache expiry.',
            );
        }

        // Single cache entry for the whole (unfiltered) catalog, keyed by ref;
        // chipType filtering happens in-memory so a ref change invalidates
        // cleanly and we never fan out one cache row per chip.
        const cacheKey = `work-templates:${ref}`;
        let catalog = await this.cache.get<WorkBlueprintEntry[]>(cacheKey).catch(() => undefined);

        if (!Array.isArray(catalog)) {
            catalog = await this.fetchCatalog(ref);
            // Only cache non-empty results so a transient failure doesn't pin
            // [] for an hour.
            if (catalog.length > 0) {
                await this.cache.set(cacheKey, catalog, CACHE_TTL_MS).catch(() => undefined);
            }
        }

        if (!chipType) return catalog;
        const normalized = toSafeSlug(chipType);
        if (!normalized) return [];
        return catalog.filter((entry) => entry.chipType === normalized);
    }

    private async fetchCatalog(ref: string): Promise<WorkBlueprintEntry[]> {
        const raw = (await this.readManifestTokenless(ref)) ?? (await this.readManifestViaGit(ref));
        if (!raw) return [];
        try {
            const manifest = JSON.parse(raw) as { blueprints?: RawBlueprint[] };
            const rows = Array.isArray(manifest.blueprints) ? manifest.blueprints : [];
            return rows
                .map(mapBlueprint)
                .filter((entry): entry is WorkBlueprintEntry => entry !== null);
        } catch (err) {
            this.logger.warn(
                `work-blueprint catalog parse failed (${ref}): ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
        }
    }

    /**
     * Primary read: tokenless `raw.githubusercontent.com` GET — `ever-works/works`
     * is public. Returns the manifest text, or null on any non-2xx / timeout so
     * the caller can fall through to the authenticated GitFacade read.
     */
    private async readManifestTokenless(ref: string): Promise<string | null> {
        const { owner, repo } = this.repoCoords;
        const url = `${RAW_HOST}/${owner}/${repo}/${encodeURIComponent(ref)}/${MANIFEST_PATH}`;
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': RAW_USER_AGENT,
                    Accept: 'application/json,text/plain,*/*',
                },
                signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
            });
            if (!res.ok) return null;
            return await res.text();
        } catch {
            return null;
        }
    }

    /**
     * Fallback read for rate limits / a future private repo: authenticated
     * `GitFacadeService.getFileContent` using the platform GitHub App
     * installation token on the org, or an env token. Returns null (never
     * throws) so the top-level `list()` degrades to [].
     */
    private async readManifestViaGit(ref: string): Promise<string | null> {
        const { owner, repo } = this.repoCoords;
        const token = await this.resolveToken();
        if (!token) return null;
        try {
            const file = await this.git.getFileContent(
                owner,
                repo,
                MANIFEST_PATH,
                { token, providerId: 'github' },
                ref,
            );
            return file?.content ?? null;
        } catch (err) {
            if (!this.warnedFetchFailed) {
                this.warnedFetchFailed = true;
                this.logger.warn(
                    `work-blueprint catalog fetch failed (${ref}): ${err instanceof Error ? err.message : String(err)} — the web app falls back to its built-in list.`,
                );
            }
            return null;
        }
    }

    /**
     * Resolve a GitHub token for the authenticated fallback read. Prefer the
     * platform GitHub App's installation on the `ever-works` org (no extra
     * secret); fall back to an explicit env override.
     */
    private async resolveToken(): Promise<string | null> {
        const { owner } = this.repoCoords;
        const appToken = await this.git.getInstallationTokenForOwner(owner).catch(() => null);
        if (appToken) return appToken;
        return process.env.EVER_WORKS_WORKS_TOKEN || process.env.GITHUB_TOKEN || null;
    }
}
