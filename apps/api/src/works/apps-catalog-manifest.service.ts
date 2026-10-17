import { Injectable, Logger } from '@nestjs/common';
import {
    APPS_CATALOG_CACHE_TTL_MS,
    APPS_CATALOG_ENTRY_STATUSES,
    APPS_CATALOG_FAILURE_TTL_MS,
    APPS_CATALOG_FETCH_TIMEOUT_MS,
    APPS_CATALOG_MANIFEST_MAX_BYTES,
    APPS_CATALOG_MAX_ENTRIES,
    APPS_CATALOG_PAGE_SIZE,
    APPS_CATALOG_PAGE_SIZE_MAX,
    APPS_CATALOG_SEARCH_MIN_CHARS,
    type AppsCatalogEntryStatus,
    type AppsCatalogListingItem,
    type AppsCatalogListingResponse,
} from '@ever-works/contracts';
import { GitFacadeService } from '@ever-works/agent/facades';

/**
 * APW-03 — the manifest-backed Apps catalog (`GET /api/apps-catalog`).
 *
 * Reads `manifest.json` from the catalog repository
 * (`EVER_WORKS_APPS_CATALOG_REPO`, default `ever-works/templates`) at
 * `EVER_WORKS_APPS_CATALOG_REF` (default `main`; production pins a tag or a
 * commit), keeps the `kind: app` rows, and projects them onto
 * {@link AppsCatalogListingItem}. Both file shapes are read:
 *
 *  - the live **listing** (catalog.md §2, "A pure listing"): `templates[]` rows
 *    with `kind`, `template { repo, ref, sha }`, `appSource`, `blueprint`,
 *    `upstreams`, `license`, `managedHosting`, `trademark`;
 *  - the catalog.md §3 **entries** shape: `apps[]` rows with `id`, `upstreams`,
 *    `blueprint { repo, version, sha }`, `verified`.
 *
 * ## What it refuses, row by row (catalog.md §3.1, R-3)
 *
 * A row is dropped on its own — never the whole file — when its id is not
 * `^[a-z0-9][a-z0-9-]{0,63}$`, its Blueprint repository is not
 * `ever-works/<name>`, its upstream is not `owner/repo`, its licence class is
 * `red` (never listed, R-3), or its status is not one of the three. Text is
 * reduced to plain text (tags and control characters stripped) and capped at
 * the catalog.md lengths, so nothing in the file reaches a page as markup.
 *
 * ## Reading the file
 *
 * With a platform token (`EVER_WORKS_APPS_CATALOG_TOKEN`, then `GITHUB_TOKEN`,
 * the resolver's chain) the file is read through the GitHub plugin — which is
 * also what makes the e2e lane's fake GitHub answer it. Without one it is read
 * tokenless from `raw.githubusercontent.com` (the catalog repository is
 * public). The repository and ref come only from the environment and are
 * validated before any URL is built, so no request input can steer the fetch.
 *
 * Cached for `APPS_CATALOG_CACHE_TTL_MS` (1 h), `APPS_CATALOG_FAILURE_TTL_MS`
 * (30 s) after a failure; an uncached read of a mutable ref (a branch) logs a
 * warning, as catalog.md §2 asks.
 */

const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._\-/]{1,255}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BLUEPRINT_REPO_PATTERN = /^ever-works\/[a-z0-9-]+$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const DEFAULT_APPS_CATALOG_REPO = 'ever-works/templates';
export const DEFAULT_APPS_CATALOG_REF = 'main';
export const APPS_CATALOG_MANIFEST_PATH = 'manifest.json';

/** The catalog repository and ref this instance reads, validated. */
export function appsCatalogSource(env: NodeJS.ProcessEnv = process.env): {
    repo: string;
    ref: string;
} {
    const repo = (env.EVER_WORKS_APPS_CATALOG_REPO ?? '').trim();
    const ref = (env.EVER_WORKS_APPS_CATALOG_REF ?? '').trim();
    return {
        repo: REPO_PATTERN.test(repo) ? repo : DEFAULT_APPS_CATALOG_REPO,
        ref: REF_PATTERN.test(ref) && !ref.includes('..') ? ref : DEFAULT_APPS_CATALOG_REF,
    };
}

/** A ref that cannot move: a 40-hex commit or a `v…` release tag. */
export function isPinnedRef(ref: string): boolean {
    return SHA_PATTERN.test(ref) || /^v\d/.test(ref);
}

/** Plain text, capped: tags and control characters out, whitespace collapsed. */
export function plainText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    return value
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

function statusOf(value: unknown): AppsCatalogEntryStatus | null {
    return typeof value === 'string' &&
        (APPS_CATALOG_ENTRY_STATUSES as readonly string[]).includes(value)
        ? (value as AppsCatalogEntryStatus)
        : null;
}

function licenseOf(raw: unknown): AppsCatalogListingItem['license'] | null {
    const license = isObject(raw) ? raw : {};
    const cls = str(license.class);
    if (cls === 'red') return null; // R-3: a red row is never listed.
    return {
        spdx: plainText(license.spdx, 200) || null,
        class: cls === 'green' || cls === 'amber' ? cls : 'unknown',
    };
}

function upstreamOf(row: Json): AppsCatalogListingItem['upstream'] {
    const appSource = isObject(row.appSource) ? row.appSource : null;
    const upstreams = Array.isArray(row.upstreams) ? row.upstreams.filter(isObject) : [];
    const repo = str(appSource?.repo) ?? str(upstreams[0]?.repo);
    if (!repo || !REPO_PATTERN.test(repo)) return null;
    const branches = isObject(upstreams[0]?.refs)
        ? (upstreams[0].refs as Json).branches
        : undefined;
    const defaultBranch =
        str(appSource?.defaultBranch) ??
        (Array.isArray(branches) && typeof branches[0] === 'string' && !branches[0].includes('*')
            ? branches[0]
            : null);
    return { repo, url: `https://github.com/${repo}`, defaultBranch };
}

/** One manifest row ⇒ one listing item, or `null` when the row must not be listed. */
export function toListingItem(row: unknown): AppsCatalogListingItem | null {
    if (!isObject(row)) return null;
    // The listing shape carries website rows too; only App rows belong here.
    if (row.kind !== undefined && row.kind !== 'app') return null;

    const blueprint = isObject(row.blueprint) ? row.blueprint : {};
    const template = isObject(row.template) ? row.template : {};
    const id = str(blueprint.id) ?? str(row.id) ?? str(row.slug);
    if (!id || !ID_PATTERN.test(id)) return null;

    const status = statusOf(row.status);
    if (!status) return null;

    const blueprintRepo = str(blueprint.repo) ?? str(template.repo);
    if (!blueprintRepo || !BLUEPRINT_REPO_PATTERN.test(blueprintRepo)) return null;

    const license = licenseOf(row.license);
    if (!license) return null;

    const upstream = upstreamOf(row);
    if (!upstream && status !== 'placeholder') return null;

    const managed = isObject(row.managedHosting) ? row.managedHosting : {};
    const trademark = isObject(row.trademark) ? row.trademark : null;
    const sha = str(blueprint.sha) ?? str(template.sha);
    const verifiedFlag = row.verified === true || blueprint.verified === true;
    const tags = Array.isArray(row.tags)
        ? row.tags
              .filter((tag): tag is string => typeof tag === 'string' && TAG_PATTERN.test(tag))
              .slice(0, 8)
        : [];

    return {
        id,
        name: plainText(row.name, 60) || id,
        summary: plainText(row.summary, 160),
        status,
        selectable: status !== 'placeholder' && upstream !== null,
        featured: row.featured === true,
        tags,
        upstream,
        blueprint: {
            repo: blueprintRepo,
            version: str(blueprint.version),
            ref:
                str(template.ref) ?? (str(blueprint.version) ? `v${str(blueprint.version)}` : null),
            sha: sha && SHA_PATTERN.test(sha) ? sha : null,
            verified: verifiedFlag,
        },
        license,
        managedHosting: {
            // Amber is never managed without a recorded upstream agreement (C6, R-3).
            allowed:
                managed.allowed === true &&
                (license.class === 'green' ||
                    (license.class === 'amber' && isObject(managed.upstreamAgreement))),
            reason: plainText(managed.reason, 200) || null,
        },
        trademark: trademark
            ? {
                  notice: plainText(trademark.notice, 300) || null,
                  displayNameSuffix: plainText(trademark.displayNameSuffix, 40) || null,
              }
            : null,
        yourCluster: true,
    };
}

/** Every listable row of a parsed manifest (either shape), unique by id, capped. */
export function listingItemsOf(manifest: unknown): AppsCatalogListingItem[] {
    if (!isObject(manifest)) return [];
    const rows = Array.isArray(manifest.templates)
        ? manifest.templates
        : Array.isArray(manifest.apps)
          ? manifest.apps
          : [];
    const seen = new Set<string>();
    const items: AppsCatalogListingItem[] = [];
    for (const row of rows.slice(0, APPS_CATALOG_MAX_ENTRIES)) {
        const item = toListingItem(row);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
    }
    // Featured first, then selectable, then by name.
    return items.sort(
        (a, b) =>
            Number(b.featured) - Number(a.featured) ||
            Number(b.selectable) - Number(a.selectable) ||
            a.name.localeCompare(b.name),
    );
}

export interface AppsCatalogListQueryInput {
    q?: string;
    status?: string;
    page?: number;
    limit?: number;
}

/** Search (min 2 characters), status filter and paging over the listing. */
export function pageListing(
    items: readonly AppsCatalogListingItem[],
    query: AppsCatalogListQueryInput,
): { items: AppsCatalogListingItem[]; total: number; page: number; limit: number } {
    const needle = (query.q ?? '').trim().toLowerCase();
    const status = statusOf(query.status);
    const filtered = items.filter((item) => {
        if (status && item.status !== status) return false;
        if (needle.length < APPS_CATALOG_SEARCH_MIN_CHARS) return true;
        return [item.id, item.name, item.summary, item.upstream?.repo ?? '', ...item.tags].some(
            (field) => field.toLowerCase().includes(needle),
        );
    });
    const limit = Math.min(
        APPS_CATALOG_PAGE_SIZE_MAX,
        Math.max(1, Math.floor(Number(query.limit) || APPS_CATALOG_PAGE_SIZE)),
    );
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const start = (page - 1) * limit;
    return { items: filtered.slice(start, start + limit), total: filtered.length, page, limit };
}

type FetchLike = (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;

@Injectable()
export class AppsCatalogManifestService {
    private readonly logger = new Logger(AppsCatalogManifestService.name);
    private cache: {
        items: AppsCatalogListingItem[];
        available: boolean;
        key: string;
        expiresAt: number;
    } | null = null;
    private inFlight: Promise<{ items: AppsCatalogListingItem[]; available: boolean }> | null =
        null;

    /** Seams for the unit spec (plain fields, so Nest injects only the facade). */
    fetchImpl: FetchLike = (url, init) => fetch(url, init);
    now: () => number = () => Date.now();

    constructor(private readonly git: GitFacadeService) {}

    async list(query: AppsCatalogListQueryInput = {}): Promise<AppsCatalogListingResponse> {
        const source = appsCatalogSource();
        const { items, available } = await this.read(source);
        return { ...pageListing(items, query), available, source: 'manifest', ...source };
    }

    async get(id: string): Promise<AppsCatalogListingItem | null> {
        if (!ID_PATTERN.test(id)) return null;
        const { items } = await this.read(appsCatalogSource());
        return items.find((item) => item.id === id) ?? null;
    }

    private async read(source: { repo: string; ref: string }) {
        const key = `${source.repo}@${source.ref}`;
        if (this.cache && this.cache.key === key && this.cache.expiresAt > this.now())
            return this.cache;
        this.inFlight ??= this.fetchManifest(source).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async fetchManifest(source: { repo: string; ref: string }) {
        const key = `${source.repo}@${source.ref}`;
        if (!isPinnedRef(source.ref)) {
            this.logger.warn(
                `Apps catalog: reading ${key}, a mutable ref — pin EVER_WORKS_APPS_CATALOG_REF to a tag or commit in production.`,
            );
        }
        try {
            const text = await this.readText(source);
            if (text.length > APPS_CATALOG_MANIFEST_MAX_BYTES) {
                throw new Error(
                    `manifest.json is larger than ${APPS_CATALOG_MANIFEST_MAX_BYTES} bytes`,
                );
            }
            const items = listingItemsOf(JSON.parse(text));
            const entry = {
                items,
                available: true,
                key,
                expiresAt: this.now() + APPS_CATALOG_CACHE_TTL_MS,
            };
            this.cache = entry;
            return entry;
        } catch (error) {
            this.logger.warn(
                `Apps catalog: could not read ${key}/${APPS_CATALOG_MANIFEST_PATH}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            const entry = {
                items: [],
                available: false,
                key,
                expiresAt: this.now() + APPS_CATALOG_FAILURE_TTL_MS,
            };
            this.cache = entry;
            return entry;
        }
    }

    private async readText(source: { repo: string; ref: string }): Promise<string> {
        const [owner, repo] = source.repo.split('/');
        const token = (
            process.env.EVER_WORKS_APPS_CATALOG_TOKEN ||
            process.env.GITHUB_TOKEN ||
            ''
        ).trim();
        if (token) {
            const file = await this.git.getFileContent(
                owner,
                repo,
                APPS_CATALOG_MANIFEST_PATH,
                { token, providerId: 'github' },
                source.ref,
            );
            if (typeof file?.content !== 'string') throw new Error('manifest.json not found');
            return file.content;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), APPS_CATALOG_FETCH_TIMEOUT_MS);
        try {
            const url = `https://raw.githubusercontent.com/${owner}/${repo}/${source.ref
                .split('/')
                .map(encodeURIComponent)
                .join('/')}/${APPS_CATALOG_MANIFEST_PATH}`;
            const response = await this.fetchImpl(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } finally {
            clearTimeout(timer);
        }
    }
}
