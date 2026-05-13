import { Injectable } from '@nestjs/common';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType } from '@ever-works/agent/entities';
import type { ActivityLog } from '@ever-works/agent/entities';
import { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import type { WorkGenerationHistory } from '@ever-works/agent/entities';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import type {
    FeedCategory,
    FeedEntry,
    GenerationHistoryEntry,
    PlatformActivityLogEntry,
} from './dto/feed-entry.dto';
import type { FeedResponse } from './dto/feed-response.dto';
import type { FeedQueryDto } from './dto/feed-query.dto';

const DEFAULT_LIMIT = 50;

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
    // Website-sourced categories — populated by activity-log rows ingested
    // from the deployed directory site (see EW-120 push flow). The
    // corresponding action types are added in Step 2.
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

interface ComposeContext {
    workId: string;
    userId: string;
    limit: number;
    category: FeedCategory;
}

@Injectable()
export class ActivityFeedService {
    constructor(
        private readonly activityLogService: ActivityLogService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
    ) {}

    async compose(workId: string, userId: string, query: FeedQueryDto): Promise<FeedResponse> {
        const limit = query.limit ?? DEFAULT_LIMIT;
        const category = query.category ?? 'all';
        const cursorTimestamp = parseCursor(query.cursor);

        const ctx: ComposeContext = { workId, userId, limit, category };
        const activityLogTypes = ACTIVITY_LOG_TYPES_BY_CATEGORY[category];
        const historyTypes = HISTORY_TYPES_BY_CATEGORY[category];

        const sourceCount = countActiveSources(activityLogTypes, historyTypes);
        const perSourceLimit =
            sourceCount > 0 ? Math.max(Math.ceil(limit / sourceCount), 5) : limit;

        const [activityLogResults, historyEntries] = await Promise.all([
            this.fetchActivityLog(ctx, perSourceLimit, activityLogTypes, cursorTimestamp),
            this.fetchHistory(ctx, perSourceLimit, historyTypes, cursorTimestamp),
        ]);

        const merged = mergeEntries([...activityLogResults, ...historyEntries], limit);
        const nextCursor =
            merged.length === limit ? (merged[merged.length - 1]?.timestamp ?? null) : null;

        return {
            entries: merged,
            nextCursor,
            serverTime: new Date().toISOString(),
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
        const typeIterable = types && types.length > 0 ? types : [undefined];
        const results = await Promise.all(
            typeIterable.map((actionType) =>
                this.activityLogService.findAll({
                    userId: ctx.userId,
                    workId: ctx.workId,
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
            ctx.workId,
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
}

function countActiveSources(
    activityLogTypes: ActivityActionType[] | null,
    historyTypes: WorkHistoryActivityType[] | null,
): number {
    let n = 0;
    if (activityLogTypes === null || activityLogTypes.length > 0) n += 1;
    if (historyTypes === null || historyTypes.length > 0) n += 1;
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

function parseCursor(cursor: string | undefined): number | null {
    if (!cursor) return null;
    const t = Date.parse(cursor);
    return Number.isFinite(t) ? t : null;
}
