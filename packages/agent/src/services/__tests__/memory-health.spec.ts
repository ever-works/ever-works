import {
    ageInDays,
    computeGapTopics,
    computeMemoryHealth,
    computeProposedBacklog,
    computeRecallHit,
    computeStaleDecisions,
    emptyMemoryHealth,
    MEMORY_HEALTH_MAX_GAP_TOPICS,
    MEMORY_HEALTH_MAX_UNCITED,
    type CitationRow,
    type HealthDocumentRow,
    type RetrievalEventRow,
} from '../memory-health';

/**
 * Memory eval loop (M10) — the metric math, on seeded logs.
 *
 * The behaviour under test that matters most is the `null` discipline:
 * "we measured 0%" and "we cannot measure this" are different facts,
 * and a health panel that renders the second as the first is worse than
 * one that renders nothing.
 */

const NOW = new Date('2026-07-26T12:00:00Z');

function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function retrieval(overrides: Partial<RetrievalEventRow> = {}): RetrievalEventRow {
    return {
        createdAt: daysAgo(1),
        queryText: 'how do we deploy',
        resultCount: 1,
        documentIds: ['doc-a'],
        ...overrides,
    };
}

function citation(overrides: Partial<CitationRow> = {}): CitationRow {
    return { documentId: 'doc-a', createdAt: daysAgo(1), ...overrides };
}

function doc(overrides: Partial<HealthDocumentRow> = {}): HealthDocumentRow {
    return {
        id: 'doc-a',
        title: 'Deploy runbook',
        kbDocumentClass: 'output',
        updatedAt: daysAgo(1),
        createdAt: daysAgo(1),
        decisionStatus: null,
        reviewState: null,
        ...overrides,
    };
}

describe('computeRecallHit', () => {
    it('reports the share of injected documents that were cited afterwards', () => {
        const retrievals = [retrieval({ documentIds: ['doc-a', 'doc-b'], createdAt: daysAgo(3) })];
        const citations = [citation({ documentId: 'doc-a', createdAt: daysAgo(2) })];

        const result = computeRecallHit(retrievals, citations);

        expect(result.documentsRetrieved).toBe(2);
        expect(result.documentsCited).toBe(1);
        expect(result.recallHitRate).toBe(0.5);
        expect(result.citationSignal).toBe(true);
    });

    it('returns null — never 0% — when no citation row exists at all', () => {
        const result = computeRecallHit([retrieval()], []);

        expect(result.citationSignal).toBe(false);
        expect(result.recallHitRate).toBeNull();
        expect(result.documentsCited).toBe(0);
    });

    it('returns null when nothing was retrieved in the window', () => {
        const result = computeRecallHit([], [citation()]);
        expect(result.recallHitRate).toBeNull();
        expect(result.documentsRetrieved).toBe(0);
    });

    it('ignores citations that predate the retrieval — they measure an older injection', () => {
        const retrievals = [retrieval({ documentIds: ['doc-a'], createdAt: daysAgo(2) })];
        const citations = [citation({ documentId: 'doc-a', createdAt: daysAgo(10) })];

        const result = computeRecallHit(retrievals, citations);

        expect(result.documentsCited).toBe(0);
        expect(result.recallHitRate).toBe(0);
    });

    it('ranks the never-cited documents by how often they were injected, and caps the list', () => {
        const retrievals: RetrievalEventRow[] = [];
        // 12 distinct docs, doc-00 injected most often — the list is
        // capped, so the WORST offenders must survive the cut.
        for (let i = 0; i < 12; i++) {
            const id = `doc-${String(i).padStart(2, '0')}`;
            for (let n = 0; n <= 12 - i; n++) {
                retrievals.push(retrieval({ documentIds: [id] }));
            }
        }
        const result = computeRecallHit(retrievals, [citation({ documentId: 'doc-99' })]);

        expect(result.uncitedDocs).toHaveLength(MEMORY_HEALTH_MAX_UNCITED);
        expect(result.uncitedDocs[0].documentId).toBe('doc-00');
        expect(result.uncitedDocs[0].retrievals).toBe(13);
    });
});

describe('computeStaleDecisions', () => {
    it('counts only ACCEPTED decisions untouched past the threshold', () => {
        const documents = [
            doc({
                id: 'd1',
                kbDocumentClass: 'decision',
                decisionStatus: 'accepted',
                updatedAt: daysAgo(200),
            }),
            doc({
                id: 'd2',
                kbDocumentClass: 'decision',
                decisionStatus: 'accepted',
                updatedAt: daysAgo(10),
            }),
            // Not accepted → not part of the settled set at all.
            doc({
                id: 'd3',
                kbDocumentClass: 'decision',
                decisionStatus: 'superseded',
                updatedAt: daysAgo(400),
            }),
            // Not a decision → irrelevant however old it is.
            doc({ id: 'd4', kbDocumentClass: 'output', updatedAt: daysAgo(400) }),
        ];

        const result = computeStaleDecisions(documents, NOW, 90);

        expect(result.decisionsAccepted).toBe(2);
        expect(result.decisionsStale).toBe(1);
        expect(result.staleDecisionRate).toBe(0.5);
    });

    it('returns null when the org has no accepted decisions yet', () => {
        const result = computeStaleDecisions([doc()], NOW, 90);
        expect(result.staleDecisionRate).toBeNull();
        expect(result.decisionsAccepted).toBe(0);
    });
});

describe('computeProposedBacklog', () => {
    it('reports the count plus the oldest and average wait in whole days', () => {
        const documents = [
            doc({ id: 'p1', reviewState: 'proposed', createdAt: daysAgo(41) }),
            doc({ id: 'p2', reviewState: 'proposed', createdAt: daysAgo(1) }),
            doc({ id: 'p3', reviewState: 'accepted', createdAt: daysAgo(99) }),
        ];

        const result = computeProposedBacklog(documents, NOW);

        expect(result.proposedBacklog).toBe(2);
        expect(result.proposedOldestAgeDays).toBe(41);
        expect(result.proposedAverageAgeDays).toBe(21);
    });

    it('reports null ages (not zero) for an empty backlog', () => {
        const result = computeProposedBacklog([doc()], NOW);
        expect(result.proposedBacklog).toBe(0);
        expect(result.proposedOldestAgeDays).toBeNull();
        expect(result.proposedAverageAgeDays).toBeNull();
    });
});

describe('computeGapTopics', () => {
    it('groups zero-result queries case- and whitespace-insensitively, most frequent first', () => {
        const retrievals = [
            retrieval({ queryText: 'Deploy process', resultCount: 0, createdAt: daysAgo(3) }),
            retrieval({ queryText: 'deploy  process', resultCount: 0, createdAt: daysAgo(1) }),
            retrieval({ queryText: 'oncall rotation', resultCount: 0, createdAt: daysAgo(2) }),
            // Answered → not a gap.
            retrieval({ queryText: 'runbook', resultCount: 4 }),
        ];

        const result = computeGapTopics(retrievals);

        expect(result.zeroResultRetrievals).toBe(3);
        expect(result.gapTopics).toHaveLength(2);
        expect(result.gapTopics[0]).toMatchObject({ query: 'Deploy process', occurrences: 2 });
        // Most recent occurrence of the group, not the first.
        expect(result.gapTopics[0].lastSeenAt).toBe(daysAgo(1).toISOString());
        expect(result.gapTopics[1]).toMatchObject({ query: 'oncall rotation', occurrences: 1 });
    });

    it('ignores zero-result events with no query text (always-injected bundles)', () => {
        const result = computeGapTopics([
            retrieval({ queryText: null, resultCount: 0 }),
            retrieval({ queryText: '   ', resultCount: 0 }),
        ]);
        expect(result.gapTopics).toHaveLength(0);
    });

    it('caps the gap list so the M11 prompt can never be flooded', () => {
        const retrievals = Array.from({ length: 25 }, (_, i) =>
            retrieval({ queryText: `question ${i}`, resultCount: 0 }),
        );
        expect(computeGapTopics(retrievals).gapTopics).toHaveLength(MEMORY_HEALTH_MAX_GAP_TOPICS);
    });
});

describe('computeMemoryHealth', () => {
    it('assembles the full payload and resolves uncited document titles', () => {
        const health = computeMemoryHealth({
            retrievals: [
                retrieval({ documentIds: ['doc-a'], createdAt: daysAgo(5) }),
                retrieval({ queryText: 'sso setup', resultCount: 0, documentIds: [] }),
            ],
            citations: [citation({ documentId: 'doc-z', createdAt: daysAgo(1) })],
            documents: [
                doc({ id: 'doc-a', title: 'Deploy runbook' }),
                doc({ id: 'p1', reviewState: 'proposed', createdAt: daysAgo(4) }),
            ],
            now: NOW,
            windowDays: 30,
            staleAfterDays: 90,
        });

        expect(health.windowDays).toBe(30);
        expect(health.computedAt).toBe(NOW.toISOString());
        expect(health.retrievalEvents).toBe(2);
        expect(health.zeroResultRetrievals).toBe(1);
        expect(health.gapTopics[0].query).toBe('sso setup');
        expect(health.uncitedDocs).toEqual([
            { documentId: 'doc-a', title: 'Deploy runbook', retrievals: 1 },
        ]);
        expect(health.proposedBacklog).toBe(1);
        expect(health.proposedOldestAgeDays).toBe(4);
    });

    it('falls back to the document id when a retrieved document is no longer in the scan window', () => {
        const health = computeMemoryHealth({
            retrievals: [retrieval({ documentIds: ['ghost'] })],
            citations: [citation({ documentId: 'other' })],
            documents: [],
            now: NOW,
            windowDays: 30,
            staleAfterDays: 90,
        });
        expect(health.uncitedDocs[0]).toEqual({
            documentId: 'ghost',
            title: 'ghost',
            retrievals: 1,
        });
    });

    it('emptyMemoryHealth reports zeroes for counts and null for every rate', () => {
        const health = emptyMemoryHealth(NOW);

        expect(health.retrievalEvents).toBe(0);
        expect(health.proposedBacklog).toBe(0);
        expect(health.recallHitRate).toBeNull();
        expect(health.staleDecisionRate).toBeNull();
        expect(health.proposedOldestAgeDays).toBeNull();
        expect(health.citationSignal).toBe(false);
    });
});

describe('ageInDays', () => {
    it('floors to whole days and never goes negative for a future timestamp', () => {
        expect(ageInDays(daysAgo(2.9), NOW)).toBe(2);
        expect(ageInDays(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
    });
});
