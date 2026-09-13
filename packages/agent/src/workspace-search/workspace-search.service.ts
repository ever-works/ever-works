import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
    WORKSPACE_SEARCH_DEFAULT_PER_KIND,
    WORKSPACE_SEARCH_MAX_PER_KIND,
    WORKSPACE_SEARCH_MAX_QUERY_LENGTH,
    WORKSPACE_SEARCH_MAX_RECENT,
    WORKSPACE_SEARCH_MAX_TOTAL,
    WORKSPACE_SEARCH_MIN_QUERY_LENGTH,
    type WorkspaceSearchGroup,
    type WorkspaceSearchHit,
    type WorkspaceSearchKind,
    type WorkspaceSearchResponse,
} from '@ever-works/contracts/api';
import { KIND_PRIORITY, orderAndCutGroups, scoreCandidate } from './ranking';
import { WORKSPACE_SEARCH_SOURCES } from './sources';
import {
    buildContainsPattern,
    buildPrefixPattern,
    buildSubsequencePattern,
    buildWordPrefixPatterns,
    runSource,
} from './sources/run-source';
import type {
    WorkspaceSearchFilters,
    WorkspaceSearchScope,
    WorkspaceSearchSourceQuery,
    WorkspaceSearchSourceResult,
} from './workspace-search.types';

/**
 * Port: answers one kind for one query. The default implementation is the live
 * fan-out over the kind's repository; an index-backed reader can replace it
 * without touching ranking or the wire contract.
 */
export interface WorkspaceSearchSourceReader {
    kinds(): WorkspaceSearchKind[];
    read(
        kind: WorkspaceSearchKind,
        query: WorkspaceSearchSourceQuery,
    ): Promise<WorkspaceSearchSourceResult>;
}

export const WORKSPACE_SEARCH_SOURCE_READER = Symbol('WORKSPACE_SEARCH_SOURCE_READER');

/** Candidates read per source, as a multiple of the rows the group can show. */
const CANDIDATE_MULTIPLIER = 5;
/** Never read fewer candidates than this, so ranking has room to reorder. */
const MIN_CANDIDATES = 25;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Workspace-wide search behind the dashboard command palette (AW-01 P1).
 *
 * Read-only. Fans out across every searchable kind in parallel; each kind runs
 * inside its own try/catch so one failing source degrades to "that group is
 * missing" (reported in `degradedKinds`) instead of failing the request —
 * the same per-source guard `SchedulesService` uses.
 */
@Injectable()
export class WorkspaceSearchService {
    private readonly logger = new Logger(WorkspaceSearchService.name);
    private readonly reader: WorkspaceSearchSourceReader;

    constructor(
        dataSource: DataSource,
        @Optional()
        @Inject(WORKSPACE_SEARCH_SOURCE_READER)
        reader?: WorkspaceSearchSourceReader,
    ) {
        this.reader = reader ?? {
            kinds: () =>
                KIND_PRIORITY.filter((kind) => WORKSPACE_SEARCH_SOURCES[kind] !== undefined),
            read: (kind, query) => {
                const definition = WORKSPACE_SEARCH_SOURCES[kind];
                if (!definition) return Promise.resolve({ candidates: [], total: 0 });
                return runSource(dataSource, definition, query);
            },
        };
    }

    async search(
        scope: WorkspaceSearchScope,
        filters: WorkspaceSearchFilters,
    ): Promise<WorkspaceSearchResponse> {
        const startedAt = Date.now();
        const query = (filters.query ?? '').trim().slice(0, WORKSPACE_SEARCH_MAX_QUERY_LENGTH);
        const empty: WorkspaceSearchResponse = {
            query,
            groups: [],
            degradedKinds: [],
            servedBy: 'fanout',
            tookMs: 0,
        };
        if (query.length < WORKSPACE_SEARCH_MIN_QUERY_LENGTH) return empty;

        const limit = clampInt(
            filters.limit,
            WORKSPACE_SEARCH_MAX_TOTAL,
            1,
            WORKSPACE_SEARCH_MAX_TOTAL,
        );
        const perKindLimit = clampInt(
            filters.perKindLimit,
            WORKSPACE_SEARCH_DEFAULT_PER_KIND,
            1,
            WORKSPACE_SEARCH_MAX_PER_KIND,
        );
        const available = this.reader.kinds();
        const requested = filters.kinds?.length
            ? available.filter((kind) => filters.kinds?.includes(kind))
            : available;
        const recent = new Set((filters.recent ?? []).slice(0, WORKSPACE_SEARCH_MAX_RECENT));

        const now = new Date();
        const sourceQuery: WorkspaceSearchSourceQuery = {
            scope,
            containsPattern: buildContainsPattern(query),
            subsequencePattern: buildSubsequencePattern(query),
            exactValue: query.toLowerCase(),
            prefixPattern: buildPrefixPattern(query),
            wordPrefixPatterns: buildWordPrefixPatterns(query),
            recentKeys: [...recent],
            now,
            cap: Math.max(MIN_CANDIDATES, perKindLimit * CANDIDATE_MULTIPLIER),
        };
        const degradedKinds: WorkspaceSearchKind[] = [];

        const groups = await Promise.all(
            requested.map(async (kind): Promise<WorkspaceSearchGroup | null> => {
                let result: WorkspaceSearchSourceResult;
                try {
                    result = await this.reader.read(kind, sourceQuery);
                } catch (error) {
                    degradedKinds.push(kind);
                    // Never log the query itself — only which source failed.
                    this.logger.warn(
                        `workspace-search source "${kind}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return null;
                }

                const hits: WorkspaceSearchHit[] = [];
                for (const candidate of result.candidates) {
                    const scored = scoreCandidate({
                        query,
                        title: candidate.title,
                        identifier: candidate.identifier,
                        secondary: candidate.secondary,
                        recentlyOpened: recent.has(`${candidate.kind}:${candidate.sourceId}`),
                        updatedAt: candidate.updatedAt,
                        now,
                    });
                    if (!scored) continue;
                    hits.push({
                        id: `${candidate.kind}:${candidate.sourceId}`,
                        kind: candidate.kind,
                        sourceId: candidate.sourceId,
                        title: candidate.title,
                        subtitle: candidate.subtitle,
                        statusLabel: candidate.statusLabel,
                        destination: candidate.destination,
                        score: scored.score,
                        matchReason: scored.matchReason,
                        updatedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : null,
                    });
                }
                return { kind, total: result.total, hits };
            }),
        );

        const ordered = orderAndCutGroups(
            groups.filter((group): group is WorkspaceSearchGroup => group !== null),
            { perKindLimit, limit },
        );

        return {
            query,
            groups: ordered as WorkspaceSearchGroup[],
            degradedKinds: KIND_PRIORITY.filter((kind) => degradedKinds.includes(kind)),
            servedBy: 'fanout',
            tookMs: Date.now() - startedAt,
        };
    }
}
