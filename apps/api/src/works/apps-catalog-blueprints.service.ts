import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@ever-works/agent/facades';
import type { GitRepository } from '@ever-works/plugin';

/**
 * The Apps catalog the App Work create form browses ("Browse the Apps catalog",
 * APW-01 T22 / APW-03 §5), read from where the Blueprints actually live.
 *
 * ## Why this reads GitHub and not a manifest
 *
 * APW-03's full catalog (`AppsCatalogService`: a `catalog.json` manifest in
 * `ever-works/templates`, the sanitiser, managed-hosting availability, README
 * details — `GET /api/apps-catalog`) is not built yet. What IS real today is
 * the rule every other Blueprint reader on the platform uses: a Blueprint is an
 * `ever-works/*` repository carrying the `ever-works-app-blueprint` topic
 * (`packages/agent/src/apps-catalog/app-blueprint.constants.ts`; the resolver
 * and website-template discovery recognise it by that topic). So this lists
 * exactly those repositories. A pick hands the form the Blueprint's repository
 * URL, and **inspect** settles the Blueprint server-side — the browser never
 * claims a match the platform has not made.
 *
 * It lives at `GET /api/apps-catalog/blueprints` — deliberately NOT at
 * `/api/apps-catalog`, whose response contract (`AppsCatalogListResponse`)
 * belongs to the manifest-backed service and must not be squatted by a reduced
 * shape. When that service lands, the browser moves to it and this read stays
 * as a fallback.
 *
 * Tokenless and cached (10 minutes; 30 seconds after a failure), so the form's
 * catalog tab costs at most a few public GitHub reads per instance per window.
 */

/** The topic every Blueprint repository carries — the value of `APP_BLUEPRINT_TOPIC`. */
export const APPS_CATALOG_BLUEPRINT_TOPIC = 'ever-works-app-blueprint';

/** The organisation the Blueprints live in (`APP_BLUEPRINT_OWNER`). */
export const APPS_CATALOG_BLUEPRINT_OWNER = 'ever-works';

/** A successful listing is reused this long. */
export const APPS_CATALOG_BLUEPRINTS_TTL_MS = 600_000;

/** A failed listing is retried after this long. */
export const APPS_CATALOG_BLUEPRINTS_FAILURE_TTL_MS = 30_000;

/** Pages of 100 repositories read at most per listing. */
export const APPS_CATALOG_BLUEPRINTS_MAX_PAGES = 5;

/** One Blueprint, as the catalog tab shows it. */
export interface AppsCatalogBlueprintItem {
    /** The repository name without its `-template` suffix (`umami-template` ⇒ `umami`). */
    id: string;
    /** A display name derived from the id (`cal-com` ⇒ `Cal Com`). */
    name: string;
    /** The repository description, or `''`. */
    summary: string;
    /** `ever-works/umami-template`. */
    repo: string;
    /** The URL the form pastes and inspects. */
    url: string;
    stars: number | null;
    /** The provider-detected licence of the Blueprint repository, when reported. */
    spdx: string | null;
    topics: string[];
}

export interface AppsCatalogBlueprintList {
    items: AppsCatalogBlueprintItem[];
    total: number;
    /** `false` when the listing could not be read; `items` is then empty. */
    available: boolean;
    /** Where the rows come from, so a client never mistakes this for the manifest catalog. */
    source: 'github-topic';
}

/** `umami-template` ⇒ `umami`; anything else unchanged. */
export function blueprintIdOf(repositoryName: string): string {
    return repositoryName.replace(/-template$/i, '').toLowerCase();
}

/** `cal-com` ⇒ `Cal Com`. */
export function blueprintDisplayName(id: string): string {
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

/** Map a listed repository to a catalog row, or `null` when it is not a Blueprint. */
export function toBlueprintItem(repository: GitRepository): AppsCatalogBlueprintItem | null {
    const topics = Array.isArray(repository.topics) ? [...repository.topics] : [];
    if (!topics.includes(APPS_CATALOG_BLUEPRINT_TOPIC)) return null;
    if (repository.isPrivate || repository.archived === true) return null;
    if ((repository.owner ?? '').toLowerCase() !== APPS_CATALOG_BLUEPRINT_OWNER) return null;
    const id = blueprintIdOf(repository.name);
    return {
        id,
        name: blueprintDisplayName(id),
        summary: (repository.description ?? '').slice(0, 300),
        repo: repository.fullName,
        url: repository.url || `https://github.com/${repository.fullName}`,
        stars: typeof repository.stars === 'number' ? repository.stars : null,
        spdx: repository.licenseSpdx ?? null,
        topics,
    };
}

/** Case-insensitive search over id, name, summary and repository (min 2 characters). */
export function filterBlueprints(
    items: readonly AppsCatalogBlueprintItem[],
    query: string | undefined,
): AppsCatalogBlueprintItem[] {
    const needle = (query ?? '').trim().toLowerCase();
    if (needle.length < 2) return [...items];
    return items.filter((item) =>
        [item.id, item.name, item.summary, item.repo].some((field) =>
            field.toLowerCase().includes(needle),
        ),
    );
}

@Injectable()
export class AppsCatalogBlueprintsService {
    private readonly logger = new Logger(AppsCatalogBlueprintsService.name);
    private cache: { list: AppsCatalogBlueprintList; expiresAt: number } | null = null;
    private inFlight: Promise<AppsCatalogBlueprintList> | null = null;

    constructor(private readonly git: GitFacadeService) {}

    /** Every listed Blueprint, filtered by `q`, newest listing at most {@link APPS_CATALOG_BLUEPRINTS_TTL_MS} old. */
    async list(query?: string, now: () => number = Date.now): Promise<AppsCatalogBlueprintList> {
        const all = await this.read(now);
        const items = filterBlueprints(all.items, query);
        return { ...all, items, total: items.length };
    }

    private async read(now: () => number): Promise<AppsCatalogBlueprintList> {
        if (this.cache && this.cache.expiresAt > now()) return this.cache.list;
        // One listing at a time: concurrent first paints share it.
        this.inFlight ??= this.fetch(now).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async fetch(now: () => number): Promise<AppsCatalogBlueprintList> {
        try {
            const items: AppsCatalogBlueprintItem[] = [];
            for (let page = 1; page <= APPS_CATALOG_BLUEPRINTS_MAX_PAGES; page += 1) {
                const repositories = await this.git.listPublicRepositories('github', page, 100, {
                    owner: APPS_CATALOG_BLUEPRINT_OWNER,
                    type: 'org',
                });
                for (const repository of repositories) {
                    const item = toBlueprintItem(repository);
                    if (item) items.push(item);
                }
                if (repositories.length < 100) break;
            }
            items.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name));
            const list: AppsCatalogBlueprintList = {
                items,
                total: items.length,
                available: true,
                source: 'github-topic',
            };
            this.cache = { list, expiresAt: now() + APPS_CATALOG_BLUEPRINTS_TTL_MS };
            return list;
        } catch (error) {
            this.logger.warn(
                `Apps catalog listing failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            const list: AppsCatalogBlueprintList = {
                items: [],
                total: 0,
                available: false,
                source: 'github-topic',
            };
            this.cache = { list, expiresAt: now() + APPS_CATALOG_BLUEPRINTS_FAILURE_TTL_MS };
            return list;
        }
    }
}
