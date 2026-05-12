import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CACHE_MANAGER, type Cache } from '@ever-works/agent/cache';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType } from '@ever-works/agent/entities';
import type { ActivityLog } from '@ever-works/agent/entities';
import { WorkGenerationHistoryRepository, WorkRepository } from '@ever-works/agent/database';
import type { Work, WorkGenerationHistory } from '@ever-works/agent/entities';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import type {
    DirectorySiteEntry,
    FeedCategory,
    FeedEntry,
    GenerationHistoryEntry,
    PlatformActivityLogEntry,
} from './dto/feed-entry.dto';
import type { FeedResponse } from './dto/feed-response.dto';
import type { FeedQueryDto } from './dto/feed-query.dto';
import {
    DirectoryWebsiteClient,
    type DirectoryEntryType,
} from './directory-website-client.service';

const DEFAULT_LIMIT = 50;
const CACHE_TTL_MS = 30_000;

const ACTIVITY_LOG_TYPES_BY_CATEGORY: Record<FeedCategory, ActivityActionType[] | null> = {
    all: null,
    generation: [ActivityActionType.GENERATION, ActivityActionType.COMPARISON_GENERATION],
    items: [
        ActivityActionType.ITEM_ADDED,
        ActivityActionType.ITEM_UPDATED,
        ActivityActionType.ITEM_REMOVED,
    ],
    deployment: [ActivityActionType.DEPLOYMENT],
    settings: [
        ActivityActionType.SETTINGS_UPDATED,
        ActivityActionType.WEBSITE_SETTINGS_UPDATED,
        ActivityActionType.PROMPTS_UPDATED,
        ActivityActionType.WORKS_CONFIG_SYNC,
        ActivityActionType.PLUGIN_ENABLED,
        ActivityActionType.PLUGIN_DISABLED,
        ActivityActionType.PLUGIN_CONFIGURED,
        ActivityActionType.TEMPLATE_ADDED,
        ActivityActionType.TEMPLATE_UPDATED,
        ActivityActionType.TEMPLATE_FORKED,
        ActivityActionType.TEMPLATE_ARCHIVED,
        ActivityActionType.TEMPLATE_DEFAULT_SET,
        ActivityActionType.WORK_UPDATED,
        ActivityActionType.WORK_CREATED,
        ActivityActionType.SCHEDULE_CREATED,
        ActivityActionType.SCHEDULE_UPDATED,
        ActivityActionType.SCHEDULE_DELETED,
        ActivityActionType.SCHEDULE_EXECUTED,
    ],
    comparisons: [ActivityActionType.COMPARISON_GENERATION],
    communityPr: [ActivityActionType.COMMUNITY_PR_MERGED],
    // Directory-site-only categories — no platform activity-log rows produce
    // these. Return an empty array so the activity-log query is skipped.
    users: [],
    submissions: [],
    reports: [],
};

const HISTORY_TYPES_BY_CATEGORY: Record<FeedCategory, WorkHistoryActivityType[] | null> = {
    all: null,
    generation: [WorkHistoryActivityType.GENERATION],
    items: [WorkHistoryActivityType.ITEM_ADDED, WorkHistoryActivityType.ITEM_UPDATED],
    deployment: [],
    settings: [],
    comparisons: [
        WorkHistoryActivityType.COMPARISON_ADDED,
        WorkHistoryActivityType.COMPARISON_REMOVED,
    ],
    communityPr: [WorkHistoryActivityType.COMMUNITY_PR_MERGED],
    users: [],
    submissions: [],
    reports: [],
};

const DIRECTORY_TYPES_BY_CATEGORY: Record<FeedCategory, DirectoryEntryType[] | null> = {
    all: ['all'],
    generation: [],
    items: ['items'],
    deployment: [],
    settings: [],
    comparisons: [],
    communityPr: [],
    users: ['users'],
    submissions: ['items'],
    reports: ['reports'],
};

interface ComposeContext {
    work: Work;
    userId: string;
    limit: number;
    category: FeedCategory;
    cursor?: string;
}

/**
 * Composes the three Activity Feed sources (platform activity-log,
 * per-Work generation history, deployed-site events) into one
 * timestamp-ordered timeline. See `docs/specs/features/activity-feed-per-directory/plan.md`
 * §5.1 for the architecture.
 */
@Injectable()
export class ActivityFeedService {
    private readonly logger = new Logger(ActivityFeedService.name);

    constructor(
        private readonly activityLogService: ActivityLogService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly directoryWebsiteClient: DirectoryWebsiteClient,
        private readonly workRepository: WorkRepository,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
    ) {}

    async compose(workId: string, userId: string, query: FeedQueryDto): Promise<FeedResponse> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            // Caller (controller) is expected to have already verified access via
            // WorkOwnershipService.ensureAccess; this is a defensive fallback.
            return emptyResponse();
        }
        const limit = query.limit ?? DEFAULT_LIMIT;
        const category = query.category ?? 'all';
        const cursorTimestamp = parseCursor(query.cursor);

        const cacheKey = makeCacheKey(workId, category, limit, cursorTimestamp);
        const cached = await this.cache.get<FeedResponse>(cacheKey);
        if (cached) {
            return cached;
        }

        const response = await this.composeFresh(
            { work, userId, limit, category, cursor: query.cursor },
            cursorTimestamp,
        );

        try {
            await this.cache.set(cacheKey, response, CACHE_TTL_MS);
        } catch (err) {
            this.logger.warn(`Failed to cache activity-feed response: ${(err as Error).message}`);
        }
        return response;
    }

    private async composeFresh(
        ctx: ComposeContext,
        cursorTimestamp: number | null,
    ): Promise<FeedResponse> {
        const activityLogTypes = ACTIVITY_LOG_TYPES_BY_CATEGORY[ctx.category];
        const historyTypes = HISTORY_TYPES_BY_CATEGORY[ctx.category];
        const directoryTypes = DIRECTORY_TYPES_BY_CATEGORY[ctx.category];

        const sourceCount = countActiveSources(activityLogTypes, historyTypes, directoryTypes);
        const perSourceLimit =
            sourceCount > 0 ? Math.max(Math.ceil(ctx.limit / sourceCount), 5) : ctx.limit;

        const [activityLogResults, historyEntries, directoryResult] = await Promise.all([
            this.fetchActivityLog(ctx, perSourceLimit, activityLogTypes, cursorTimestamp),
            this.fetchHistory(ctx, perSourceLimit, historyTypes, cursorTimestamp),
            this.fetchDirectorySite(ctx, perSourceLimit, directoryTypes),
        ]);

        const merged = mergeEntries(
            [...activityLogResults, ...historyEntries, ...directoryResult.entries],
            ctx.limit,
        );
        const nextCursor =
            merged.length === ctx.limit ? (merged[merged.length - 1]?.timestamp ?? null) : null;

        // Best-effort update of observability columns; never blocks the response.
        this.recordSyncStatus(ctx.work, directoryResult).catch((err) =>
            this.logger.debug(`Failed to update platformSync* columns: ${err.message}`),
        );

        return {
            entries: merged,
            nextCursor,
            serverTime: new Date().toISOString(),
            ...(directoryResult.degraded
                ? { degraded: { directorySite: directoryResult.degraded } }
                : {}),
        };
    }

    private async fetchActivityLog(
        ctx: ComposeContext,
        limit: number,
        types: ActivityActionType[] | null,
        cursorTimestamp: number | null,
    ): Promise<PlatformActivityLogEntry[]> {
        if (types !== null && types.length === 0) {
            return [];
        }
        const collected: PlatformActivityLogEntry[] = [];
        // ActivityLogService.findAll only filters by a single actionType. For
        // categories that span multiple types we run the queries in parallel
        // and dedupe by id at merge time.
        const typeIterable = types && types.length > 0 ? types : [undefined];
        const results = await Promise.all(
            typeIterable.map((actionType) =>
                this.activityLogService.findAll({
                    userId: ctx.userId,
                    workId: ctx.work.id,
                    actionType,
                    limit,
                    offset: 0,
                    dateTo: cursorTimestamp ? new Date(cursorTimestamp) : undefined,
                }),
            ),
        );
        const seen = new Set<string>();
        for (const { activities } of results) {
            for (const log of activities) {
                if (seen.has(log.id)) continue;
                seen.add(log.id);
                collected.push(toActivityLogEntry(log));
            }
        }
        return collected;
    }

    private async fetchHistory(
        ctx: ComposeContext,
        limit: number,
        types: WorkHistoryActivityType[] | null,
        cursorTimestamp: number | null,
    ): Promise<GenerationHistoryEntry[]> {
        if (types !== null && types.length === 0) {
            return [];
        }
        const rows = await this.generationHistoryRepository.findByWorkFiltered(
            ctx.work.id,
            limit,
            0,
            types ?? undefined,
        );
        const filtered = cursorTimestamp
            ? rows.filter(
                  (r) => (r.startedAt?.getTime() ?? r.createdAt?.getTime() ?? 0) < cursorTimestamp,
              )
            : rows;
        return filtered.map(toHistoryEntry);
    }

    private async fetchDirectorySite(
        ctx: ComposeContext,
        limit: number,
        types: DirectoryEntryType[] | null,
    ): Promise<{
        entries: DirectorySiteEntry[];
        degraded?: FeedResponse['degraded']['directorySite'];
    }> {
        if (types === null || types.length === 0) {
            return { entries: [] };
        }
        const result = await this.directoryWebsiteClient.fetchActivityFeed(ctx.work, {
            limit,
            types,
            since: ctx.cursor,
        });
        if (result.ok === true) {
            return { entries: result.entries };
        }
        const degraded = (
            result as { ok: false; degraded: FeedResponse['degraded']['directorySite'] }
        ).degraded;
        return {
            entries: [],
            degraded: {
                ...degraded,
                lastSuccessAt: ctx.work.platformSyncLastSuccessAt?.toISOString() ?? null,
            },
        };
    }

    private async recordSyncStatus(
        work: Work,
        directoryResult: { degraded?: FeedResponse['degraded']['directorySite'] },
    ): Promise<void> {
        if (!work.platformSyncEnabled) {
            return;
        }
        if (directoryResult.degraded) {
            await this.workRepository.updatePlatformSyncStatus(work.id, {
                lastError:
                    `${directoryResult.degraded.reason}: ${directoryResult.degraded.detail ?? ''}`.trim(),
            });
        } else {
            await this.workRepository.updatePlatformSyncStatus(work.id, {
                lastSuccessAt: new Date(),
                lastError: null,
            });
        }
    }

    // Cache invalidation — best-effort; failures only logged.

    @OnEvent('activity-log.created')
    @OnEvent('work-generation.completed')
    @OnEvent('work-generation.failed')
    async onWorkEvent(payload: { workId?: string } | undefined): Promise<void> {
        if (!payload?.workId) {
            return;
        }
        try {
            // cache-manager v5 doesn't expose a prefix-scan; we approximate by
            // touching the small set of category × limit × cursor keys this
            // service might write. With TTL 30s the staleness is bounded
            // anyway, so this is a "be polite to active users" optimisation.
            await this.cache.del(`activity-feed:${payload.workId}:all:50:null`);
            await this.cache.del(`activity-feed:${payload.workId}:generation:50:null`);
        } catch (err) {
            this.logger.debug(`Cache invalidation failed: ${(err as Error).message}`);
        }
    }
}

function countActiveSources(
    activityLogTypes: ActivityActionType[] | null,
    historyTypes: WorkHistoryActivityType[] | null,
    directoryTypes: DirectoryEntryType[] | null,
): number {
    let n = 0;
    if (activityLogTypes === null || activityLogTypes.length > 0) n += 1;
    if (historyTypes === null || historyTypes.length > 0) n += 1;
    if (directoryTypes !== null && directoryTypes.length > 0) n += 1;
    return n;
}

function toActivityLogEntry(log: ActivityLog): PlatformActivityLogEntry {
    return {
        id: log.id,
        source: 'platform-activity-log',
        type: log.actionType,
        category: categoryForActivityLog(log.actionType),
        timestamp: log.createdAt.toISOString(),
        summary: log.summary,
        status: log.status,
        details: log.details ?? null,
    };
}

function toHistoryEntry(row: WorkGenerationHistory): GenerationHistoryEntry {
    const timestamp = (row.startedAt ?? row.createdAt ?? new Date()).toISOString();
    return {
        id: `hist-${row.id}`,
        source: 'generation-history',
        type: row.activityType,
        category: categoryForHistory(row.activityType),
        timestamp,
        summary: summariseHistoryRow(row),
        status: String(row.status),
        runId: row.id,
        newItemsCount: row.newItemsCount,
        updatedItemsCount: row.updatedItemsCount,
        totalItemsCount: row.totalItemsCount,
        durationInSeconds: row.durationInSeconds ?? null,
    };
}

function summariseHistoryRow(row: WorkGenerationHistory): string {
    const counts: string[] = [];
    if (row.newItemsCount > 0) counts.push(`${row.newItemsCount} new`);
    if (row.updatedItemsCount > 0) counts.push(`${row.updatedItemsCount} updated`);
    const countsPart = counts.length ? ` (${counts.join(', ')})` : '';
    return `${row.activityType}${countsPart}`;
}

function categoryForActivityLog(type: ActivityActionType): FeedCategory {
    if (type === ActivityActionType.GENERATION) return 'generation';
    if (type === ActivityActionType.COMPARISON_GENERATION) return 'comparisons';
    if (type === ActivityActionType.DEPLOYMENT) return 'deployment';
    if (
        type === ActivityActionType.ITEM_ADDED ||
        type === ActivityActionType.ITEM_UPDATED ||
        type === ActivityActionType.ITEM_REMOVED
    ) {
        return 'items';
    }
    if (type === ActivityActionType.COMMUNITY_PR_MERGED) return 'communityPr';
    return 'settings';
}

function categoryForHistory(type: WorkHistoryActivityType): FeedCategory {
    if (type === WorkHistoryActivityType.GENERATION) return 'generation';
    if (
        type === WorkHistoryActivityType.COMPARISON_ADDED ||
        type === WorkHistoryActivityType.COMPARISON_REMOVED
    ) {
        return 'comparisons';
    }
    if (type === WorkHistoryActivityType.COMMUNITY_PR_MERGED) return 'communityPr';
    return 'items';
}

function mergeEntries(entries: FeedEntry[], limit: number): FeedEntry[] {
    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

function makeCacheKey(
    workId: string,
    category: FeedCategory,
    limit: number,
    cursorTimestamp: number | null,
): string {
    return `activity-feed:${workId}:${category}:${limit}:${cursorTimestamp ?? 'null'}`;
}

function parseCursor(cursor: string | undefined): number | null {
    if (!cursor) return null;
    const t = Date.parse(cursor);
    return Number.isFinite(t) ? t : null;
}

function emptyResponse(): FeedResponse {
    return { entries: [], nextCursor: null, serverTime: new Date().toISOString() };
}
