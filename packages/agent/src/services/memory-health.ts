import type { KbMemoryGapTopic, KbMemoryHealth, KbMemoryUncitedDoc } from '@ever-works/contracts';

/**
 * Pure math behind the Memory health panel (memory upgrades M10).
 *
 * Every metric lives here as a total function over plain rows so the
 * numbers are explainable and unit-testable without a database — the
 * same split `memory-consolidation.ts` uses for the consolidation
 * scores. `MemoryHealthService` is orchestration only.
 *
 * The cardinal rule: **a metric that cannot be measured is `null`, never
 * `0`.** A 0% recall-hit rate and "we have no citation signal yet" are
 * different facts, and conflating them is how a health panel starts
 * lying. This mirrors the loud-empty rule the recall-injection path
 * already follows.
 */

/** Default rolling window for the health metrics. */
export const MEMORY_HEALTH_DEFAULT_WINDOW_DAYS = 30;

/** Default age at which an untouched accepted decision counts as stale. */
export const MEMORY_HEALTH_DEFAULT_STALE_DAYS = 90;

/** Upper bound on the uncited-document list rendered in the panel. */
export const MEMORY_HEALTH_MAX_UNCITED = 10;

/** Upper bound on the gap-topic list (also what feeds the M11 prompt). */
export const MEMORY_HEALTH_MAX_GAP_TOPICS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One retrieval event as the math sees it. */
export interface RetrievalEventRow {
    createdAt: Date;
    queryText?: string | null;
    resultCount: number;
    documentIds?: string[] | null;
}

/** One citation row as the math sees it. */
export interface CitationRow {
    documentId: string;
    createdAt: Date;
}

/** One KB document as the math sees it. */
export interface HealthDocumentRow {
    id: string;
    title: string;
    kbDocumentClass: string;
    updatedAt: Date;
    decisionStatus?: string | null;
    reviewState?: string | null;
    createdAt: Date;
}

export interface ComputeMemoryHealthInput {
    retrievals: RetrievalEventRow[];
    citations: CitationRow[];
    documents: HealthDocumentRow[];
    now: Date;
    windowDays: number;
    staleAfterDays: number;
}

/**
 * Whole days between two instants, floored at 0. Used for every age
 * reported by the panel so "today" reads as `0 days`, not `-0`.
 */
export function ageInDays(from: Date, now: Date): number {
    const ms = now.getTime() - from.getTime();
    return ms <= 0 ? 0 : Math.floor(ms / DAY_MS);
}

/** Round a ratio to 4 decimals so the wire value is stable + readable. */
function ratio(numerator: number, denominator: number): number | null {
    if (denominator <= 0) return null;
    return Math.round((numerator / denominator) * 10000) / 10000;
}

/**
 * **Recall-hit rate** — of the documents we injected into prompts, how
 * many were actually cited back by a consumer afterwards?
 *
 * A document counts as "hit" when a citation row exists for it dated at
 * or after the retrieval that injected it. Citations that predate every
 * retrieval of that document are ignored: they measure an older
 * injection, not this one.
 *
 * Returns `null` when there is nothing to divide by — no retrievals in
 * the window, or no citation rows at all (see `citationSignal`).
 */
export function computeRecallHit(
    retrievals: RetrievalEventRow[],
    citations: CitationRow[],
): {
    recallHitRate: number | null;
    documentsRetrieved: number;
    documentsCited: number;
    citationSignal: boolean;
    uncitedDocs: Array<{ documentId: string; retrievals: number }>;
} {
    // Earliest retrieval per document — a citation only counts if it
    // came after the document was actually put in front of a model.
    const firstRetrievalAt = new Map<string, number>();
    const retrievalCount = new Map<string, number>();
    for (const event of retrievals) {
        for (const docId of event.documentIds ?? []) {
            const at = event.createdAt.getTime();
            const seen = firstRetrievalAt.get(docId);
            if (seen === undefined || at < seen) firstRetrievalAt.set(docId, at);
            retrievalCount.set(docId, (retrievalCount.get(docId) ?? 0) + 1);
        }
    }

    const citationSignal = citations.length > 0;
    const documentsRetrieved = firstRetrievalAt.size;

    const cited = new Set<string>();
    for (const citation of citations) {
        const injectedAt = firstRetrievalAt.get(citation.documentId);
        if (injectedAt === undefined) continue;
        if (citation.createdAt.getTime() >= injectedAt) cited.add(citation.documentId);
    }

    const uncitedDocs = [...retrievalCount.entries()]
        .filter(([docId]) => !cited.has(docId))
        .map(([documentId, count]) => ({ documentId, retrievals: count }))
        .sort((a, b) => b.retrievals - a.retrievals || a.documentId.localeCompare(b.documentId))
        .slice(0, MEMORY_HEALTH_MAX_UNCITED);

    return {
        // No citation signal at all ⇒ unknowable, NOT 0%.
        recallHitRate: citationSignal ? ratio(cited.size, documentsRetrieved) : null,
        documentsRetrieved,
        documentsCited: cited.size,
        citationSignal,
        uncitedDocs,
    };
}

/**
 * **Stale-decision rate** — of the settled (accepted) decisions, how
 * many has nobody touched for `staleAfterDays`? A high rate means the
 * decision log is drifting away from how the team actually works.
 */
export function computeStaleDecisions(
    documents: HealthDocumentRow[],
    now: Date,
    staleAfterDays: number,
): { staleDecisionRate: number | null; decisionsAccepted: number; decisionsStale: number } {
    const accepted = documents.filter(
        (doc) => doc.kbDocumentClass === 'decision' && doc.decisionStatus === 'accepted',
    );
    const stale = accepted.filter((doc) => ageInDays(doc.updatedAt, now) >= staleAfterDays);
    return {
        staleDecisionRate: ratio(stale.length, accepted.length),
        decisionsAccepted: accepted.length,
        decisionsStale: stale.length,
    };
}

/**
 * **Proposed-backlog age** — how much unreviewed agent-written memory is
 * queued, and how long the oldest item has been waiting. Because
 * `proposed` documents are excluded from context injection, a growing
 * backlog means agent learning is being captured and then discarded.
 */
export function computeProposedBacklog(
    documents: HealthDocumentRow[],
    now: Date,
): {
    proposedBacklog: number;
    proposedOldestAgeDays: number | null;
    proposedAverageAgeDays: number | null;
} {
    const proposed = documents.filter((doc) => doc.reviewState === 'proposed');
    if (proposed.length === 0) {
        return {
            proposedBacklog: 0,
            proposedOldestAgeDays: null,
            proposedAverageAgeDays: null,
        };
    }
    const ages = proposed.map((doc) => ageInDays(doc.createdAt, now));
    const total = ages.reduce((sum, age) => sum + age, 0);
    return {
        proposedBacklog: proposed.length,
        proposedOldestAgeDays: Math.max(...ages),
        proposedAverageAgeDays: Math.round(total / ages.length),
    };
}

/**
 * **Gap topics** — the questions retrieval could not answer. Grouped by
 * normalized query text (case-folded + whitespace-collapsed) so "Deploy
 * process" and "deploy  process" are one gap, ordered by how often they
 * came up. This list is exactly what the gap-fed synthesis prompt (M11)
 * carries into consolidation.
 */
export function computeGapTopics(retrievals: RetrievalEventRow[]): {
    gapTopics: KbMemoryGapTopic[];
    zeroResultRetrievals: number;
} {
    const zeroResult = retrievals.filter(
        (event) => event.resultCount === 0 && typeof event.queryText === 'string',
    );

    const groups = new Map<string, { query: string; occurrences: number; lastSeenAt: Date }>();
    for (const event of zeroResult) {
        const raw = (event.queryText ?? '').trim();
        if (raw.length === 0) continue;
        const key = raw.toLowerCase().replace(/\s+/g, ' ');
        const existing = groups.get(key);
        if (existing) {
            existing.occurrences += 1;
            if (event.createdAt > existing.lastSeenAt) existing.lastSeenAt = event.createdAt;
        } else {
            groups.set(key, { query: raw, occurrences: 1, lastSeenAt: event.createdAt });
        }
    }

    const gapTopics = [...groups.values()]
        .sort(
            (a, b) =>
                b.occurrences - a.occurrences ||
                b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
                a.query.localeCompare(b.query),
        )
        .slice(0, MEMORY_HEALTH_MAX_GAP_TOPICS)
        .map((entry) => ({
            query: entry.query,
            occurrences: entry.occurrences,
            lastSeenAt: entry.lastSeenAt.toISOString(),
        }));

    return { gapTopics, zeroResultRetrievals: zeroResult.length };
}

/**
 * Assemble the full health payload from raw rows. Deterministic for a
 * fixed `now` + fixed rows — no clock reads, no I/O.
 */
export function computeMemoryHealth(input: ComputeMemoryHealthInput): KbMemoryHealth {
    const recall = computeRecallHit(input.retrievals, input.citations);
    const decisions = computeStaleDecisions(input.documents, input.now, input.staleAfterDays);
    const backlog = computeProposedBacklog(input.documents, input.now);
    const gaps = computeGapTopics(input.retrievals);

    const titleById = new Map(input.documents.map((doc) => [doc.id, doc.title]));
    const uncitedDocs: KbMemoryUncitedDoc[] = recall.uncitedDocs.map((entry) => ({
        documentId: entry.documentId,
        title: titleById.get(entry.documentId) ?? entry.documentId,
        retrievals: entry.retrievals,
    }));

    return {
        windowDays: input.windowDays,
        computedAt: input.now.toISOString(),

        recallHitRate: recall.recallHitRate,
        retrievalEvents: input.retrievals.length,
        documentsRetrieved: recall.documentsRetrieved,
        documentsCited: recall.documentsCited,
        citationSignal: recall.citationSignal,
        uncitedDocs,

        staleDecisionRate: decisions.staleDecisionRate,
        decisionsAccepted: decisions.decisionsAccepted,
        decisionsStale: decisions.decisionsStale,
        staleAfterDays: input.staleAfterDays,

        ...backlog,

        gapTopics: gaps.gapTopics,
        zeroResultRetrievals: gaps.zeroResultRetrievals,
    };
}

/** An all-zero, all-`null` payload — used for an empty / unscoped org. */
export function emptyMemoryHealth(
    now: Date,
    windowDays = MEMORY_HEALTH_DEFAULT_WINDOW_DAYS,
    staleAfterDays = MEMORY_HEALTH_DEFAULT_STALE_DAYS,
): KbMemoryHealth {
    return computeMemoryHealth({
        retrievals: [],
        citations: [],
        documents: [],
        now,
        windowDays,
        staleAfterDays,
    });
}
