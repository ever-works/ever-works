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
 * Auth: the repo is currently private, so a token is required. It is
 * resolved from `EVER_WORKS_AGENTS_TOKEN` (preferred) or `GITHUB_TOKEN`
 * (shared platform PAT). When neither is set the service logs once and
 * returns []. Pin a ref with `EVER_WORKS_AGENTS_REF` (default `main`).
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
    if (typeof row?.slug !== 'string' || row.slug.length === 0) return null;
    const tags = asStringArray(row.tags);
    const title =
        (typeof row.title === 'string' && row.title) ||
        (typeof row.name === 'string' && row.name) ||
        row.slug;
    return {
        slug: row.slug,
        title,
        description: typeof row.summary === 'string' ? row.summary : '',
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
        const cacheKey = `agent-templates:${entity}:${ref}`;

        const cached = await this.cache.get<AstTemplateEntry[]>(cacheKey).catch(() => undefined);
        if (Array.isArray(cached)) return cached;

        const templates = await this.fetchFromRepo(ref);
        if (templates.length > 0) {
            await this.cache.set(cacheKey, templates, CACHE_TTL_MS).catch(() => undefined);
        }
        return templates;
    }

    private async fetchFromRepo(ref: string): Promise<AstTemplateEntry[]> {
        const token = process.env.EVER_WORKS_AGENTS_TOKEN || process.env.GITHUB_TOKEN;
        if (!token) {
            if (!this.warnedNoToken) {
                this.warnedNoToken = true;
                this.logger.warn(
                    'No EVER_WORKS_AGENTS_TOKEN / GITHUB_TOKEN set — agent-template catalog is unavailable; the web app falls back to its built-in list.',
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
