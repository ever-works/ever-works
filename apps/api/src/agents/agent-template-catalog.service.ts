import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { GitFacadeService } from '@ever-works/agent/facades';

/**
 * Agent-template catalog (ADR-011, spec FR-26..FR-30).
 *
 * Reads the curated `manifest.json` index from the external
 * `ever-works/agents` repo, maps it to the stable `AstTemplateEntry`
 * shape the web app already consumes, and caches it for 1h in the
 * shared `cache_entries` store. Every failure path (no token, repo
 * unreachable, malformed manifest) returns an empty array — the web
 * layer then falls back to its built-in catalog, so the chips +
 * `View All` panel never break.
 *
 * Auth: the repo is private. The token is resolved in priority order:
 *   1. The platform GitHub App's installation on the `ever-works` org —
 *      the same App that already lets the platform create repos there.
 *      No extra secret needed in the standard hosted deployment.
 *   2. `EVER_WORKS_AGENTS_TOKEN` / `GITHUB_TOKEN` env override — for
 *      self-hosted installs that don't run the GitHub App, or local dev.
 * When none resolve, the service logs once and returns []. Pin a ref
 * with `EVER_WORKS_AGENTS_REF` (default `main`).
 */

export type AstTemplateEntityType = 'agent' | 'skill' | 'task';

export interface AstTemplateEntry {
    slug: string;
    title: string;
    description: string;
    category?: string;
    iconName?: string;
    tags?: string[];
}

/** Shape of a `manifest.json` `templates[]` row in `ever-works/agents`. */
interface RawManifestTemplate {
    slug?: unknown;
    name?: unknown;
    title?: unknown;
    summary?: unknown;
    scope?: unknown;
    avatarIcon?: unknown;
    tags?: unknown;
}

const AGENTS_REPO_OWNER = 'ever-works';
const AGENTS_REPO_NAME = 'agents';
const MANIFEST_PATH = 'manifest.json';
const CACHE_TTL_MS = 60 * 60 * 1000;

// Security: allowlist pattern for safe slug values from the external manifest.
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Security: max lengths to cap unbounded string fields from the external manifest.
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_TAG_LEN = 60;

/**
 * Security: strip HTML tags from a manifest string field so that a
 * compromised ever-works/agents repo cannot inject XSS payloads into
 * values that the web frontend may render.  Uses a simple regex that is
 * sufficient for the narrow set of plain-text fields we consume; a
 * full DOM-based sanitizer is not available in the API runtime.
 */
function stripHtml(value: string): string {
    return value.replace(/<[^>]*>/g, '');
}

/** `kanban-square` → `KanbanSquare` so the client icon map (PascalCase
 *  lucide names) can resolve repo `avatarIcon` ids. */
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

function mapTemplate(row: RawManifestTemplate): AstTemplateEntry | null {
    // Security: reject slugs that don't match the strict allowlist so that
    // a compromised manifest cannot inject arbitrary strings as template ids.
    if (typeof row?.slug !== 'string' || row.slug.length === 0) return null;
    if (!SAFE_SLUG_RE.test(row.slug)) return null;

    // Security: strip HTML tags and cap lengths on every string field sourced
    // from the external manifest to prevent XSS payloads reaching the frontend.
    const rawTags = asStringArray(row.tags)?.map((t) => stripHtml(t).slice(0, MAX_TAG_LEN));
    const tags = rawTags && rawTags.length > 0 ? rawTags : undefined;

    const rawTitle =
        (typeof row.title === 'string' && row.title) ||
        (typeof row.name === 'string' && row.name) ||
        row.slug;
    const title = stripHtml(rawTitle).slice(0, MAX_TITLE_LEN);

    const rawDescription = typeof row.summary === 'string' ? row.summary : '';
    const description = stripHtml(rawDescription).slice(0, MAX_DESC_LEN);

    return {
        slug: row.slug,
        title,
        description,
        // First tag makes a friendlier chip label than the raw scope enum.
        category: tags?.[0] ? tags[0].charAt(0).toUpperCase() + tags[0].slice(1) : undefined,
        iconName: typeof row.avatarIcon === 'string' ? kebabToPascal(row.avatarIcon) : undefined,
        tags,
    };
}

@Injectable()
export class AgentTemplateCatalogService {
    private readonly logger = new Logger(AgentTemplateCatalogService.name);
    private warnedNoToken = false;

    constructor(
        private readonly git: GitFacadeService,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
    ) {}

    /**
     * Returns the catalog for an entity type. Only `agent` is backed by
     * the repo today; `skill`/`task` return [] (the web layer keeps its
     * own fallback for those).
     */
    async list(entity: AstTemplateEntityType = 'agent'): Promise<AstTemplateEntry[]> {
        if (entity !== 'agent') return [];

        const ref = process.env.EVER_WORKS_AGENTS_REF || 'main';
        // Security: warn operators when a mutable branch ref (not a pinned commit SHA
        // or semver tag) is used, so they know to set EVER_WORKS_AGENTS_REF to a
        // commit SHA (40 hex chars) or a version tag (vX.Y.Z) in production.
        const isPinnedRef = /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+(\.\d+)?$/.test(ref);
        if (!isPinnedRef) {
            this.logger.warn(
                `EVER_WORKS_AGENTS_REF is set to a mutable ref '${ref}'. ` +
                    'Pin to a commit SHA (40 hex chars) or a version tag (vX.Y.Z) in production ' +
                    'to prevent supply-chain substitution after cache expiry.',
            );
        }
        const cacheKey = `agent-templates:${entity}:${ref}`;

        const cached = await this.cache.get<AstTemplateEntry[]>(cacheKey).catch(() => undefined);
        if (Array.isArray(cached)) return cached;

        const templates = await this.fetchFromRepo(ref);
        if (templates.length > 0) {
            await this.cache.set(cacheKey, templates, CACHE_TTL_MS).catch(() => undefined);
        }
        return templates;
    }

    /**
     * Resolve a GitHub token that can read `ever-works/agents`. Prefer
     * the platform GitHub App's installation on the org (no extra
     * secret); fall back to an explicit env override.
     */
    private async resolveToken(): Promise<string | null> {
        const appToken = await this.git
            .getInstallationTokenForOwner(AGENTS_REPO_OWNER)
            .catch(() => null);
        if (appToken) return appToken;
        return process.env.EVER_WORKS_AGENTS_TOKEN || process.env.GITHUB_TOKEN || null;
    }

    private async fetchFromRepo(ref: string): Promise<AstTemplateEntry[]> {
        const token = await this.resolveToken();
        if (!token) {
            if (!this.warnedNoToken) {
                this.warnedNoToken = true;
                this.logger.warn(
                    'No GitHub App installation on the ever-works org and no EVER_WORKS_AGENTS_TOKEN / GITHUB_TOKEN set — agent-template catalog is unavailable; the web app falls back to its built-in list.',
                );
            }
            return [];
        }

        try {
            const file = await this.git.getFileContent(
                AGENTS_REPO_OWNER,
                AGENTS_REPO_NAME,
                MANIFEST_PATH,
                { token, providerId: 'github' },
                ref,
            );
            if (!file) return [];
            const manifest = JSON.parse(file.content) as { templates?: RawManifestTemplate[] };
            const rows = Array.isArray(manifest.templates) ? manifest.templates : [];
            return rows
                .map(mapTemplate)
                .filter((entry): entry is AstTemplateEntry => entry !== null);
        } catch (err) {
            this.logger.warn(
                `agent-template catalog fetch failed (${ref}): ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
        }
    }
}
