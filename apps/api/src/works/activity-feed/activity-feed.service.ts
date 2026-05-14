import { Injectable, Logger } from '@nestjs/common';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType } from '@ever-works/agent/entities';
import type { ActivityLog, Work } from '@ever-works/agent/entities';
import { WorkGenerationHistoryRepository, WorkRepository } from '@ever-works/agent/database';
import type { WorkGenerationHistory } from '@ever-works/agent/entities';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import type {
    DirectorySiteEntry,
    FeedCategory,
    FeedEntry,
    GenerationHistoryEntry,
    PlatformActivityLogEntry,
} from './dto/feed-entry.dto';
import type { FeedDegradedReason, FeedResponse } from './dto/feed-response.dto';
import type { FeedQueryDto } from './dto/feed-query.dto';
import {
    DirectoryWebsiteClient,
    type DirectoryEntryType,
} from './directory-website-client.service';

const DEFAULT_LIMIT = 50;

/**
 * Push-mode mapping: website-sourced categories are populated by activity-log
 * rows ingested via `POST /api/activity-log/ingest`, so they appear as ordinary
 * WEBSITE_* action types in the activity-log query.
 */
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
    users: [ActivityActionType.WEBSITE_USER_REGISTERED],
    submissions: [ActivityActionType.WEBSITE_ITEM_SUBMITTED],
    reports: [ActivityActionType.WEBSITE_REPORT_FILED, ActivityActionType.WEBSITE_REPORT_RESOLVED],
};

/** Set of action types that represent website-ingested events (push transport). */
const WEBSITE_ACTION_TYPES: ReadonlySet<ActivityActionType> = new Set([
    ActivityActionType.WEBSITE_USER_REGISTERED,
    ActivityActionType.WEBSITE_ITEM_SUBMITTED,
    ActivityActionType.WEBSITE_REPORT_FILED,
    ActivityActionType.WEBSITE_REPORT_RESOLVED,
]);

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

/**
 * Pull-mode mapping: website-sourced categories are populated by an on-demand
 * fetch against the deployed site (DirectoryWebsiteClient). The values map to
 * the upstream `types[]` filter.
 */
const DIRECTORY_TYPES_BY_CATEGORY: Record<FeedCategory, DirectoryEntryType[]> = {
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
    limit: number;
    category: FeedCategory;
    cursor?: string;
}

/**
 * Aggregator for the per-Work Activity Feed (EW-120). Composes three sources:
 *
 *  1. Platform activity-log (always)
 *  2. Per-Work generation history (always)
 *  3. Deployed-site events — populated by **one of two** transports based on
 *     `Work.activitySyncMode`:
 *       - `pull`    → on-demand HMAC-signed GET via DirectoryWebsiteClient
 *       - `push`    → ordinary activity-log rows ingested via the platform
 *                     `/api/activity-log/ingest` endpoint (WEBSITE_* types)
 *       - `disabled`→ never queried; users / submissions / reports chips empty
 *
 * Push-mode + Disabled-mode never set `response.degraded`. Pull-mode failures
 * surface via `response.degraded.directorySite` so the web client renders the
 * degraded banner with rotation / redeploy hints.
 */
@Injectable()
export class ActivityFeedService {
    private readonly logger = new Logger(ActivityFeedService.name);

    constructor(
        private readonly activityLogService: ActivityLogService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly workRepository: WorkRepository,
        private readonly directoryClient: DirectoryWebsiteClient,
    ) {}

    async compose(workId: string, _userId: string, query: FeedQueryDto): Promise<FeedResponse> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            // Controller's WorkOwnershipService.ensureAccess already rejects
            // missing/forbidden Works upstream; this is a defence-in-depth
            // fallback (no row → no events, no degraded).
            return { entries: [], nextCursor: null, serverTime: new Date().toISOString() };
        }

        const limit = query.limit ?? DEFAULT_LIMIT;
        const category = query.category ?? 'all';
        const cursorTimestamp = parseCursor(query.cursor);
        const ctx: ComposeContext = { work, limit, category, cursor: query.cursor };

        const isPullMode = work.activitySyncMode === 'pull';
        const isDisabled = work.activitySyncMode === 'disabled';

        const activityLogTypes = ACTIVITY_LOG_TYPES_BY_CATEGORY[category];
        const historyTypes = HISTORY_TYPES_BY_CATEGORY[category];
        const directoryTypes = isPullMode ? DIRECTORY_TYPES_BY_CATEGORY[category] : [];

        // In pull mode, the website chips are populated by DirectoryWebsiteClient,
        // so the activity-log query should NOT return WEBSITE_* rows (any present
        // would be stale push-mode leftovers from a prior mode flip).
        const filteredActivityLogTypes = isPullMode
            ? filterOutWebsiteTypes(activityLogTypes)
            : activityLogTypes;

        // Pass the FULL requested `limit` to each top-level source. The
        // previous design divided `limit / sourceCount` per source, which
        // could drop newer events from a dominant source — e.g. a deploy
        // burst on activity-log alongside a quiet history would lose
        // newer activity rows to older history rows after the merge.
        // Fetching `limit` from each source means we have up to
        // `limit * sources` candidate rows; `mergeEntries(..., limit)`
        // still trims to the caller's budget. Codex P1 review on
        // activity-feed.service.ts:101 (2026-05-13).
        const [activityLogResults, historyEntries, directoryResult] = await Promise.all([
            this.fetchActivityLog(ctx, limit, filteredActivityLogTypes, cursorTimestamp),
            this.fetchHistory(ctx, limit, historyTypes, cursorTimestamp),
            isPullMode && !isDisabled
                ? this.fetchDirectorySite(ctx, limit, directoryTypes)
                : Promise.resolve<{
                      entries: DirectorySiteEntry[];
                      degraded?: FeedDegradedReason;
                  }>({ entries: [] }),
        ]);

        const merged = mergeEntries(
            [...activityLogResults, ...historyEntries, ...directoryResult.entries],
            limit,
        );
        const nextCursor =
            merged.length === limit ? (merged[merged.length - 1]?.timestamp ?? null) : null;

        // Best-effort observability for pull-mode runs — never blocks the response.
        if (isPullMode) {
            this.recordSyncStatus(work, directoryResult.degraded).catch((err) =>
                this.logger.debug(`Failed to update platformSync* columns: ${err.message}`),
            );
        }

        const response: FeedResponse = {
            entries: merged,
            nextCursor,
            serverTime: new Date().toISOString(),
        };
        if (directoryResult.degraded) {
            response.degraded = { directorySite: directoryResult.degraded };
        }
        return response;
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
        // Single `IN (...)` query instead of N parallel per-type queries.
        // Previously we fanned out one query per action type, which made
        // the activity-log budget effectively `limit * types.length` —
        // for the `settings` category that's 18× over-fetch. The
        // repository now accepts an array (Codex P1 review followup).
        //
        // Note: bypasses the userId filter on purpose. Access is enforced
        // upstream by WorkOwnershipService.ensureAccess (controller); the
        // feed must surface every row scoped to the Work, including the
        // owner-attributed website-ingested events for member viewers.
        const { activities } = await this.activityLogService.findByWork({
            workId: ctx.work.id,
            actionType: types && types.length > 0 ? types : undefined,
            limit,
            offset: 0,
            dateTo: cursorTimestamp ? new Date(cursorTimestamp) : undefined,
        });
        return activities.map(toActivityLogEntry);
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
        // Push the cursor predicate to the DB so older rows beyond `limit`
        // aren't silently skipped when the top-N batch is all newer than
        // the cursor.
        const rows = await this.generationHistoryRepository.findByWorkFiltered(
            ctx.work.id,
            limit,
            0,
            types ?? undefined,
            cursorTimestamp ? new Date(cursorTimestamp) : undefined,
        );
        return rows.map(toHistoryEntry);
    }

    private async fetchDirectorySite(
        ctx: ComposeContext,
        limit: number,
        types: DirectoryEntryType[],
    ): Promise<{ entries: DirectorySiteEntry[]; degraded?: FeedDegradedReason }> {
        if (types.length === 0) {
            return { entries: [] };
        }
        const result = await this.directoryClient.fetchActivityFeed(ctx.work, {
            limit,
            types,
            since: ctx.cursor,
        });
        if (result.ok === true) {
            return { entries: result.entries };
        }
        return {
            entries: [],
            degraded: {
                ...result.degraded,
                lastSuccessAt: ctx.work.platformSyncLastSuccessAt?.toISOString() ?? null,
            },
        };
    }

    private async recordSyncStatus(
        work: Work,
        degraded: FeedDegradedReason | undefined,
    ): Promise<void> {
        if (degraded) {
            await this.workRepository.updatePlatformSyncStatus(work.id, {
                lastErrorAt: new Date(),
                lastErrorMessage: `${degraded.reason}: ${degraded.detail ?? ''}`.trim(),
            });
        } else {
            await this.workRepository.updatePlatformSyncStatus(work.id, {
                lastSuccessAt: new Date(),
                lastErrorMessage: null,
            });
        }
    }
}

function filterOutWebsiteTypes(types: ActivityActionType[] | null): ActivityActionType[] | null {
    if (types === null) {
        // `all` category — keep the "no filter" semantics but make the
        // findByWork pass filter post-hoc by switching to an explicit
        // allow-list of everything EXCEPT website types. We accept the
        // verbosity here because the pull path is the legacy default and
        // misrouting WEBSITE_* rows there would surface duplicates.
        return Object.values(ActivityActionType).filter(
            (t) => !WEBSITE_ACTION_TYPES.has(t),
        ) as ActivityActionType[];
    }
    return types.filter((t) => !WEBSITE_ACTION_TYPES.has(t));
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
    if (type === ActivityActionType.WEBSITE_USER_REGISTERED) return 'users';
    if (type === ActivityActionType.WEBSITE_ITEM_SUBMITTED) return 'submissions';
    if (
        type === ActivityActionType.WEBSITE_REPORT_FILED ||
        type === ActivityActionType.WEBSITE_REPORT_RESOLVED
    ) {
        return 'reports';
    }
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
