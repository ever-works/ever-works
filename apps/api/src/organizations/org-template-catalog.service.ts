import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { GitFacadeService } from '@ever-works/agent/facades';

/**
 * Prebuilt-company catalog (teams-and-companies spec §6, ADR-014).
 *
 * Reads the `manifest.json` index from the external `ever-works/orgs`
 * repo (agentcompanies/v1 packages), maps it to the stable
 * `OrgTemplateEntry` shape the Create-Organization wizard consumes, and
 * caches it for 1h in the shared `cache_entries` store. Every failure
 * path returns an empty list — the wizard then simply skips its
 * template step, so org creation never breaks.
 *
 * Mirrors `agents/agent-template-catalog.service.ts` (same token
 * resolution: GitHub App installation on `ever-works` →
 * `EVER_WORKS_ORGS_TOKEN` / `GITHUB_TOKEN`; ref pin via
 * `EVER_WORKS_ORGS_REF`, default `main`).
 */

/** Public wire shape — file inventory intentionally excluded (importer-only). */
export interface OrgTemplateEntry {
    slug: string;
    name: string;
    description: string;
    category: string;
    agents: number;
    teams: number;
    skills: number;
    projects: number;
    iconName?: string;
    tags?: string[];
    featured?: boolean;
}

/** Importer view: repo path + full file inventory of one package. */
export interface OrgTemplatePackage extends OrgTemplateEntry {
    path: string;
    files: string[];
}

interface RawManifestCompany {
    slug?: unknown;
    path?: unknown;
    name?: unknown;
    description?: unknown;
    category?: unknown;
    agents?: unknown;
    teams?: unknown;
    skills?: unknown;
    projects?: unknown;
    avatarIcon?: unknown;
    tags?: unknown;
    featured?: unknown;
    files?: unknown;
}

export const ORGS_REPO_OWNER = 'ever-works';
export const ORGS_REPO_NAME = 'orgs';
const MANIFEST_PATH = 'manifest.json';
const CACHE_TTL_MS = 60 * 60 * 1000;

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Security: repo-relative file paths from the external manifest — no
// leading slash, no dot-segments, conservative charset.
const SAFE_FILE_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const MAX_NAME_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_TAG_LEN = 60;
const MAX_FILES = 400;

function stripHtml(value: string): string {
    return value.replace(/<[^>]*>/g, '');
}

// Refs are operator-controlled env values (tag/sha/branch); reject anything
// that couldn't be a git ref before it reaches a URL.
const SAFE_REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * Tokenless read of a file from a PUBLIC ever-works catalog repo via
 * raw.githubusercontent.com. Used when no GitHub App installation / token
 * resolves: raw serving has no meaningful anonymous rate cap (unlike the
 * 60 req/h/IP contents API), which matters for multi-file company imports.
 * Explicit User-Agent — GitHub 403s raw `fetch` calls without one.
 * Callers pass paths already validated against SAFE_FILE_RE / SLUG
 * conventions; the ref is validated here.
 */
export async function fetchPublicRawFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
): Promise<string | null> {
    if (!SAFE_REF_RE.test(ref) || path.includes('..')) return null;
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Ever Works' } });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

function kebabToPascal(value: string): string {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function asCount(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function mapCompany(row: RawManifestCompany): OrgTemplatePackage | null {
    if (typeof row?.slug !== 'string' || !SAFE_SLUG_RE.test(row.slug)) return null;
    // The path is convention-locked to the slug — never trust a free-form
    // path from the manifest (defense against traversal into other repo areas).
    const path = `companies/${row.slug}`;
    if (typeof row.path === 'string' && row.path !== path) return null;

    const files = Array.isArray(row.files)
        ? row.files
              .filter((f): f is string => typeof f === 'string' && SAFE_FILE_RE.test(f) && !f.includes('..'))
              .slice(0, MAX_FILES)
        : [];

    const rawTags = Array.isArray(row.tags)
        ? row.tags
              .filter((t): t is string => typeof t === 'string')
              .map((t) => stripHtml(t).slice(0, MAX_TAG_LEN))
        : [];

    return {
        slug: row.slug,
        path,
        name: stripHtml(typeof row.name === 'string' ? row.name : row.slug).slice(0, MAX_NAME_LEN),
        description: stripHtml(typeof row.description === 'string' ? row.description : '').slice(0, MAX_DESC_LEN),
        category: stripHtml(typeof row.category === 'string' ? row.category : 'general').slice(0, MAX_TAG_LEN),
        agents: asCount(row.agents),
        teams: asCount(row.teams),
        skills: asCount(row.skills),
        projects: asCount(row.projects),
        iconName: typeof row.avatarIcon === 'string' ? kebabToPascal(stripHtml(row.avatarIcon)) : undefined,
        tags: rawTags.length > 0 ? rawTags : undefined,
        featured: row.featured === true ? true : undefined,
        files,
    };
}

@Injectable()
export class OrgTemplateCatalogService {
    private readonly logger = new Logger(OrgTemplateCatalogService.name);
    private warnedNoToken = false;

    constructor(
        private readonly git: GitFacadeService,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
    ) {}

    /** Public catalog for the wizard — no file inventories. */
    async list(): Promise<OrgTemplateEntry[]> {
        const packages = await this.listPackages();
        return packages.map(({ path: _path, files: _files, ...entry }) => entry);
    }

    /** One package incl. file inventory — importer-side only. */
    async getPackage(slug: string): Promise<OrgTemplatePackage | null> {
        if (!SAFE_SLUG_RE.test(slug)) return null;
        const packages = await this.listPackages();
        return packages.find((p) => p.slug === slug) ?? null;
    }

    /** Token the importer reuses to fetch the package's individual files. */
    async resolveToken(): Promise<string | null> {
        const appToken = await this.git
            .getInstallationTokenForOwner(ORGS_REPO_OWNER)
            .catch(() => null);
        if (appToken) return appToken;
        return process.env.EVER_WORKS_ORGS_TOKEN || process.env.GITHUB_TOKEN || null;
    }

    ref(): string {
        return process.env.EVER_WORKS_ORGS_REF || 'main';
    }

    private async listPackages(): Promise<OrgTemplatePackage[]> {
        const ref = this.ref();
        const isPinnedRef = /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+(\.\d+)?$/.test(ref);
        if (!isPinnedRef) {
            this.logger.warn(
                `EVER_WORKS_ORGS_REF is set to a mutable ref '${ref}'. Pin to a commit SHA or vX.Y.Z tag in production to prevent supply-chain substitution after cache expiry.`,
            );
        }
        const cacheKey = `org-templates:${ref}`;

        const cached = await this.cache.get<OrgTemplatePackage[]>(cacheKey).catch(() => undefined);
        if (Array.isArray(cached)) return cached;

        const packages = await this.fetchFromRepo(ref);
        if (packages.length > 0) {
            await this.cache.set(cacheKey, packages, CACHE_TTL_MS).catch(() => undefined);
        }
        return packages;
    }

    private async fetchFromRepo(ref: string): Promise<OrgTemplatePackage[]> {
        // ever-works/orgs is a PUBLIC community catalog — a token is an
        // optimization (higher rate limits), never a requirement. When none
        // resolves we read unauthenticated (createOctokit omits auth for a
        // falsy token); the 1h manifest cache keeps us far under the
        // 60 req/h/IP anonymous cap.
        const token = await this.resolveToken();
        if (!token && !this.warnedNoToken) {
            this.warnedNoToken = true;
            this.logger.log(
                'org-template catalog: no GitHub App installation / token resolved — reading the public ever-works/orgs repo unauthenticated.',
            );
        }

        try {
            let content: string | null;
            if (token) {
                const file = await this.git.getFileContent(
                    ORGS_REPO_OWNER,
                    ORGS_REPO_NAME,
                    MANIFEST_PATH,
                    { token, providerId: 'github' },
                    ref,
                );
                content = file?.content ?? null;
            } else {
                content = await fetchPublicRawFile(ORGS_REPO_OWNER, ORGS_REPO_NAME, ref, MANIFEST_PATH);
            }
            if (!content) return [];
            const manifest = JSON.parse(content) as { companies?: RawManifestCompany[] };
            const rows = Array.isArray(manifest.companies) ? manifest.companies : [];
            return rows
                .map(mapCompany)
                .filter((entry): entry is OrgTemplatePackage => entry !== null);
        } catch (err) {
            this.logger.warn(
                `org-template catalog fetch failed (${ref}): ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
        }
    }
}
