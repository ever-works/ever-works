import { Injectable, Logger, Optional } from '@nestjs/common';
import type { KbMemoryHealth } from '@ever-works/contracts';
import { KbRetrievalLogRepository } from '../database/repositories/kb-retrieval-log.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    computeMemoryHealth,
    emptyMemoryHealth,
    MEMORY_HEALTH_DEFAULT_STALE_DAYS,
    MEMORY_HEALTH_DEFAULT_WINDOW_DAYS,
    type CitationRow,
    type HealthDocumentRow,
    type RetrievalEventRow,
} from './memory-health';

/** Cap on documents scanned per health computation (mirrors consolidation). */
export const MEMORY_HEALTH_MAX_DOCS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryHealthOptions {
    /** Rolling window in days. Default 30, clamped to 1…365. */
    windowDays?: number;
    /** Age at which an untouched accepted decision counts stale. Default 90. */
    staleAfterDays?: number;
    /** Injected clock — deterministic in tests. */
    now?: Date;
}

/**
 * Memory health (memory upgrades M10) — the eval loop that turns the
 * retrieval log + citation rows into three plain-language numbers:
 *
 *  - **recall-hit rate** — were the documents we injected actually cited?
 *  - **stale-decision rate** — how much of the decision log has gone
 *    untouched past its freshness horizon?
 *  - **proposed-backlog age** — how much agent-written memory is waiting
 *    for review (and therefore excluded from every prompt)?
 *
 * plus the **gap topics** (queries that returned nothing) which the
 * gap-fed synthesis prompt (M11) carries into consolidation.
 *
 * All arithmetic lives in the pure `memory-health.ts` helpers; this
 * class is orchestration + scope plumbing only.
 *
 * **Scope.** Identical plumbing to `MemoryConsolidationService` /
 * `aggregateOrgMemory`: the org's Work ids come from
 * `WorkRepository.findIdNamesByOrganization` and every read is bounded
 * by that id list, so an unscoped cross-tenant scan is impossible. The
 * CALLER authorizes org membership before this service runs — same
 * contract as the aggregation endpoint.
 */
@Injectable()
export class MemoryHealthService {
    private readonly logger = new Logger(MemoryHealthService.name);

    constructor(
        private readonly retrievalLogRepository: KbRetrievalLogRepository,
        private readonly citationRepository: WorkKnowledgeCitationRepository,
        private readonly documentRepository: WorkKnowledgeDocumentRepository,
        // Optional to mirror `MemoryConsolidationService`'s posture —
        // isolated unit tests construct without it, and the scan then
        // degrades to the org's own org-scoped rows.
        @Optional() private readonly workRepository?: WorkRepository,
    ) {}

    /**
     * Compute health for one organization. Never throws for an empty or
     * unknown org — it returns the all-`null` payload, which the panel
     * renders as "not measurable yet" rather than as zeroes.
     */
    async getOrgHealth(
        organizationId: string,
        options: MemoryHealthOptions = {},
    ): Promise<KbMemoryHealth> {
        const now = options.now ?? new Date();
        const windowDays = clamp(options.windowDays ?? MEMORY_HEALTH_DEFAULT_WINDOW_DAYS, 1, 365);
        const staleAfterDays = clamp(
            options.staleAfterDays ?? MEMORY_HEALTH_DEFAULT_STALE_DAYS,
            1,
            3650,
        );
        const since = new Date(now.getTime() - windowDays * DAY_MS);

        const workRows = this.workRepository
            ? await this.workRepository.findIdNamesByOrganization(organizationId)
            : [];
        const workIds = workRows.map((row) => row.id);

        const [retrievalRows, citationRows, docPage] = await Promise.all([
            this.retrievalLogRepository.listForWorksSince(workIds, since),
            this.citationRepository.listForWorksSince(workIds, since),
            this.documentRepository.listForOrgAggregate({
                workIds,
                organizationId,
                limit: MEMORY_HEALTH_MAX_DOCS,
            }),
        ]);

        const retrievals: RetrievalEventRow[] = retrievalRows.map((row) => ({
            createdAt: row.createdAt,
            queryText: row.queryText ?? null,
            resultCount: row.resultCount,
            documentIds: row.documentIds ?? [],
        }));
        const citations: CitationRow[] = citationRows.map((row) => ({
            documentId: row.documentId,
            createdAt: row.createdAt,
        }));
        const documents: HealthDocumentRow[] = docPage.items.map((doc) => ({
            id: doc.id,
            title: doc.title,
            kbDocumentClass: doc.kbDocumentClass,
            updatedAt: doc.updatedAt,
            createdAt: doc.createdAt,
            decisionStatus: doc.decision?.status ?? null,
            reviewState: doc.reviewState ?? null,
        }));

        return computeMemoryHealth({
            retrievals,
            citations,
            documents,
            now,
            windowDays,
            staleAfterDays,
        });
    }

    /**
     * The empty payload, exposed so controllers can answer an
     * org-less (personal / bare-tenant) request without branching on
     * the shape.
     */
    emptyHealth(options: MemoryHealthOptions = {}): KbMemoryHealth {
        return emptyMemoryHealth(
            options.now ?? new Date(),
            clamp(options.windowDays ?? MEMORY_HEALTH_DEFAULT_WINDOW_DAYS, 1, 365),
            clamp(options.staleAfterDays ?? MEMORY_HEALTH_DEFAULT_STALE_DAYS, 1, 3650),
        );
    }

    /**
     * Best-effort variant used by the consolidation cadence: a health
     * computation must never be able to fail the scheduled pass, so a
     * throwing read downgrades to `null` and the pass runs with no gap
     * section in its prompt.
     */
    async tryGetOrgHealth(
        organizationId: string,
        options: MemoryHealthOptions = {},
    ): Promise<KbMemoryHealth | null> {
        try {
            return await this.getOrgHealth(organizationId, options);
        } catch (error) {
            this.logger.warn(
                `Memory health computation failed for org=${organizationId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(Math.trunc(value), min), max);
}
