import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { KB_RETRIEVAL_LOG_QUERY_MAX, KbRetrievalLog } from '../../entities/kb-retrieval-log.entity';

/** Hard cap on rows returned by any aggregate read (OOM guard). */
export const KB_RETRIEVAL_LOG_SCAN_LIMIT = 2000;

/**
 * Append-only access to the KB retrieval log (memory upgrades M10).
 *
 * Reads are ALWAYS scope-bounded: every method takes explicit
 * `workIds` (or a single `workId`), so an unscoped cross-tenant scan is
 * impossible by construction — the same mandatory-scope discipline the
 * KB document repository enforces.
 */
@Injectable()
export class KbRetrievalLogRepository {
    constructor(
        @InjectRepository(KbRetrievalLog)
        private readonly repository: Repository<KbRetrievalLog>,
    ) {}

    /**
     * Append one retrieval event. `queryText` is trimmed and capped at
     * the column length before it ever reaches the driver.
     */
    async record(data: {
        workId: string;
        organizationId?: string | null;
        queryText?: string | null;
        resultCount: number;
        documentIds?: string[] | null;
        consumerKind?: string | null;
    }): Promise<KbRetrievalLog> {
        const entity = this.repository.create({
            workId: data.workId,
            organizationId: data.organizationId ?? null,
            queryText: capQuery(data.queryText),
            resultCount: data.resultCount,
            documentIds: data.documentIds ?? null,
            consumerKind: data.consumerKind ?? null,
        });
        return this.repository.save(entity);
    }

    /**
     * Every retrieval event for the given Works since `since`, newest
     * first, bounded by `limit`. Returns `[]` for an empty scope rather
     * than scanning — an org with no Works has no retrieval history.
     */
    async listForWorksSince(
        workIds: string[],
        since: Date,
        limit = KB_RETRIEVAL_LOG_SCAN_LIMIT,
    ): Promise<KbRetrievalLog[]> {
        if (workIds.length === 0) return [];
        return this.repository.find({
            where: { workId: In(workIds), createdAt: MoreThanOrEqual(since) },
            order: { createdAt: 'DESC' },
            take: Math.min(limit, KB_RETRIEVAL_LOG_SCAN_LIMIT),
        });
    }

    /**
     * Retrieval events for ONE Work since `since` — the read behind the
     * per-document "Ask why" trail. Filtering down to the requested
     * document happens in the service (the id list is `simple-json`, so
     * a portable SQL containment predicate does not exist across the
     * Postgres + SQLite driver pair this repo supports).
     */
    async listForWorkSince(
        workId: string,
        since: Date,
        limit = KB_RETRIEVAL_LOG_SCAN_LIMIT,
    ): Promise<KbRetrievalLog[]> {
        return this.repository.find({
            where: { workId, createdAt: MoreThanOrEqual(since) },
            order: { createdAt: 'DESC' },
            take: Math.min(limit, KB_RETRIEVAL_LOG_SCAN_LIMIT),
        });
    }
}

/** Trim + cap a query string to the persisted column width. */
function capQuery(value?: string | null): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > KB_RETRIEVAL_LOG_QUERY_MAX
        ? trimmed.slice(0, KB_RETRIEVAL_LOG_QUERY_MAX)
        : trimmed;
}
