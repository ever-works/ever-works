import { Injectable, NotFoundException } from '@nestjs/common';
import {
    catalogSearchRank,
    playbookSearchFields,
    PLAYBOOK_CATALOG_CACHE_MS,
    type PlaybookCatalogEntry,
    type PlaybookDetailResponse,
    type PlaybookListResponse,
    type PlaybookPreflightReport,
    type PlaybookSummary,
} from '@ever-works/contracts';
import { PlaybookCatalogFacadeService } from '@ever-works/agent/facades';
import { PlaybookReadinessService, planAdoption } from '@ever-works/agent/services';
import {
    PLAYBOOK_LIST_DEFAULT_LIMIT,
    PLAYBOOK_LIST_MAX_LIMIT,
    type ListPlaybooksDto,
    type PreflightPlaybookDto,
} from './catalog.dto';

/** Bounds the per-caller cache so a busy replica cannot grow it without limit. */
const MAX_CACHED_CALLERS = 1000;

interface CachedCatalogue {
    readonly entries: readonly PlaybookCatalogEntry[];
    readonly expiresAt: number;
}

/**
 * Rank of the best field a search term matched: title above tags above
 * summary above step titles. `null` when nothing matched. The rule itself
 * lives in the contracts package so the catalogue page ranks identically.
 */
export function playbookSearchRank(entry: PlaybookCatalogEntry, search: string): number | null {
    return catalogSearchRank(
        playbookSearchFields({ ...entry, stepTitles: entry.steps.map((step) => step.title) }),
        search,
    );
}

/**
 * Capability & playbook catalogue (AW-21) — the API-side read model over the
 * playbook facade.
 *
 * Holds the merged catalogue per caller for at most 60 s (which providers are
 * enabled differs per caller), filters and ranks it, and attaches the
 * caller's readiness. It writes nothing.
 */
@Injectable()
export class PlaybookCatalogService {
    private readonly cache = new Map<string, CachedCatalogue>();

    constructor(
        private readonly facade: PlaybookCatalogFacadeService,
        private readonly readiness: PlaybookReadinessService,
    ) {}

    async list(userId: string, query: ListPlaybooksDto): Promise<PlaybookListResponse> {
        const entries = await this.entries(userId);
        const ranked = entries
            .map((entry, index) => ({
                entry,
                index,
                rank: query.search ? playbookSearchRank(entry, query.search) : 0,
            }))
            .filter(
                (row): row is { entry: PlaybookCatalogEntry; index: number; rank: number } =>
                    row.rank !== null && (!query.category || row.entry.category === query.category),
            )
            .sort((a, b) => a.rank - b.rank || a.index - b.index);

        const limit = Math.min(query.limit ?? PLAYBOOK_LIST_DEFAULT_LIMIT, PLAYBOOK_LIST_MAX_LIMIT);
        const offset = query.offset ?? 0;

        // Without a readiness filter the page and the total are known before
        // any readiness is resolved, so only the returned entries pay for it.
        if (!query.readiness) {
            const items = await Promise.all(
                ranked
                    .slice(offset, offset + limit)
                    .map(async ({ entry }) => this.summarise(entry, userId)),
            );
            return { items, total: ranked.length };
        }

        // Filtering by readiness needs every candidate's state; the readiness
        // service coalesces the capability lookups those entries share.
        const summaries = await Promise.all(
            ranked.map(async ({ entry }) => this.summarise(entry, userId)),
        );
        const filtered = summaries.filter((summary) => summary.readiness === query.readiness);
        return { items: filtered.slice(offset, offset + limit), total: filtered.length };
    }

    async detail(userId: string, slug: string): Promise<PlaybookDetailResponse> {
        const entry = await this.find(userId, slug);
        const readiness = await this.readiness.getReadiness(
            entry,
            { userId },
            { checkNameCollision: true },
        );
        return { entry, readiness };
    }

    /** Read-only: resolves readiness and the itemised plan, and creates nothing. */
    async preflight(
        userId: string,
        slug: string,
        body: PreflightPlaybookDto,
    ): Promise<PlaybookPreflightReport> {
        const entry = await this.find(userId, slug);
        const readiness = await this.readiness.getReadiness(
            entry,
            { userId, workId: body.workId },
            { checkNameCollision: true },
        );
        const collision = readiness.collisions.find((item) => item.type === 'agent_name');
        const plan = planAdoption(entry, {
            instanceName: body.instanceName,
            agentName: collision?.suggested,
        });
        return { ...readiness, plan };
    }

    private async find(userId: string, slug: string): Promise<PlaybookCatalogEntry> {
        const cached = (await this.entries(userId)).find((entry) => entry.slug === slug);
        if (cached) return cached;
        throw new NotFoundException({
            code: 'playbook_not_found',
            message: `Playbook "${slug}" is not in the catalogue.`,
        });
    }

    private async summarise(entry: PlaybookCatalogEntry, userId: string): Promise<PlaybookSummary> {
        const readiness = await this.readiness.getReadiness(entry, { userId });
        return {
            slug: entry.slug,
            title: entry.title,
            outcome: entry.outcome,
            summary: entry.summary,
            category: entry.category,
            version: entry.version,
            icon: entry.icon,
            triggerKind: entry.trigger.kind,
            triggerDescription: entry.trigger.description,
            costBand: entry.costBand,
            estimatedTokensPerRun: entry.estimatedTokensPerRun,
            tags: entry.tags,
            stepTitles: entry.steps.map((step) => step.title),
            requiredCapabilities: entry.connections
                .filter((need) => need.required)
                .map((need) => need.capability),
            readiness: readiness.state,
            missingRequired: readiness.missingRequired,
        };
    }

    private async entries(userId: string): Promise<readonly PlaybookCatalogEntry[]> {
        const now = Date.now();
        const cached = this.cache.get(userId);
        if (cached && cached.expiresAt > now) return cached.entries;
        const entries = await this.facade.listEntries({ userId });
        if (this.cache.size >= MAX_CACHED_CALLERS) {
            for (const [key, value] of this.cache) {
                if (value.expiresAt <= now) this.cache.delete(key);
            }
            if (this.cache.size >= MAX_CACHED_CALLERS) this.cache.clear();
        }
        this.cache.set(userId, { entries, expiresAt: now + PLAYBOOK_CATALOG_CACHE_MS });
        return entries;
    }
}
