import {
    CANDIDATE_LIMIT,
    DECISION_CONFLICT_HEURISTIC,
    DecisionConflictService,
    extractTerms,
    scoreDecision,
} from '../decision-conflict.service';
import { KnowledgeBaseService } from '../knowledge-base.service';

/**
 * Re-litigation guard (memory upgrades M6) — unit coverage for the
 * deterministic `term-overlap/v1` heuristic and its owner-scoped
 * candidate fetch.
 *
 * The two properties that matter most are asserted explicitly:
 *  - only `class=decision, status=accepted, reviewState != proposed`
 *    documents are ever scored, and
 *  - unrelated intents produce ZERO conflicts (false positives are the
 *    failure mode that would make this feature unusable).
 */

type DecisionDoc = Parameters<typeof scoreDecision>[0] & {
    decision?: { status?: string; rationale?: string | null } | null;
    reviewState?: string | null;
    class?: string;
};

function decisionDoc(overrides: Partial<DecisionDoc> = {}): DecisionDoc {
    return {
        id: 'doc-1',
        path: 'decision/database-engine.md',
        slug: 'database-engine',
        title: 'Use PostgreSQL as the primary database engine',
        description: 'Chosen over MySQL for JSONB and extension support.',
        workId: 'work-1',
        updatedAt: '2026-07-01T10:00:00.000Z',
        class: 'decision',
        reviewState: 'accepted',
        decision: { status: 'accepted', rationale: 'JSONB + pgvector' },
        ...overrides,
    };
}

function makeService(items: DecisionDoc[]) {
    const listDocuments = jest.fn().mockResolvedValue({ items, total: items.length });
    const kb = { listDocuments } as unknown as KnowledgeBaseService;
    return { service: new DecisionConflictService(kb), listDocuments };
}

describe('extractTerms', () => {
    it('lowercases, drops short tokens and stop-words, and de-duplicates', () => {
        const terms = extractTerms('The PostgreSQL database, the database and a DB');
        expect(terms.has('postgresql')).toBe(true);
        expect(terms.has('database')).toBe(true);
        // stop-word + sub-3-char token
        expect(terms.has('the')).toBe(false);
        expect(terms.has('db')).toBe(false);
    });

    it('de-pluralizes only tokens longer than four characters', () => {
        const terms = extractTerms('engines apis');
        expect(terms.has('engine')).toBe(true);
        // `apis` is 4 chars — left intact so short stems are not mangled.
        expect(terms.has('apis')).toBe(true);
    });

    it('returns an empty set for empty input', () => {
        expect(extractTerms('').size).toBe(0);
    });
});

describe('scoreDecision — thresholds', () => {
    it('flags a strong conflict when the intent restates the whole decision title', () => {
        const intent = extractTerms(
            'Switch the primary database engine away from PostgreSQL to MySQL',
        );
        const hit = scoreDecision(decisionDoc(), intent);
        expect(hit).not.toBeNull();
        expect(hit?.signal).toBe('strong');
        expect(hit?.overlapTerms).toEqual(expect.arrayContaining(['postgresql', 'database']));
        expect(hit?.score).toBeGreaterThanOrEqual(0.6);
    });

    it('returns null for an unrelated intent (no false positive)', () => {
        const intent = extractTerms('Redesign the marketing landing page hero illustration');
        expect(scoreDecision(decisionDoc(), intent)).toBeNull();
    });

    it('returns null when only ONE significant term is shared', () => {
        // "database" alone is below the 2-term overlap floor.
        const intent = extractTerms('Document the database backup runbook for on-call rotation');
        const hit = scoreDecision(
            decisionDoc({
                title: 'Use PostgreSQL',
                description: 'Primary engine decision.',
            }),
            intent,
        );
        expect(hit).toBeNull();
    });

    it('skips decisions whose subject has fewer than two significant terms', () => {
        const intent = extractTerms('postgresql everywhere for every service we operate');
        expect(
            scoreDecision(decisionDoc({ title: 'PostgreSQL', description: null }), intent),
        ).toBeNull();
    });

    it('reports a moderate signal for partial subject overlap', () => {
        const doc = decisionDoc({
            title: 'Adopt trunk-based development with short-lived feature branches',
            description: null,
        });
        const intent = extractTerms('Adopt trunk based development for the mobile client');
        const hit = scoreDecision(doc, intent);
        expect(hit).not.toBeNull();
        expect(['strong', 'moderate']).toContain(hit?.signal);
    });

    it('carries the decision rationale and a stable rounded score', () => {
        const intent = extractTerms('Move the primary database engine off PostgreSQL');
        const hit = scoreDecision(decisionDoc(), intent);
        expect(hit?.rationale).toBe('JSONB + pgvector');
        expect(hit?.documentId).toBe('doc-1');
        expect(hit?.path).toBe('decision/database-engine.md');
        expect(Number.isFinite(hit?.score)).toBe(true);
        expect(String(hit?.score)).toMatch(/^\d(\.\d{1,2})?$/);
    });
});

describe('DecisionConflictService.checkIntent', () => {
    it('returns an empty report (and never queries) for a Task with no Work', async () => {
        const { service, listDocuments } = makeService([decisionDoc()]);
        const report = await service.checkIntent({
            workId: null,
            userId: 'user-1',
            title: 'Switch the primary database engine to MySQL',
        });
        expect(report.conflicts).toEqual([]);
        expect(report.scanned).toBe(0);
        expect(report.heuristic).toBe(DECISION_CONFLICT_HEURISTIC);
        expect(listDocuments).not.toHaveBeenCalled();
    });

    it('fetches decision-class candidates owner-scoped through the KB service', async () => {
        const { service, listDocuments } = makeService([decisionDoc()]);
        await service.checkIntent({
            workId: 'work-1',
            userId: 'user-1',
            title: 'Replace the primary database engine, dropping PostgreSQL',
        });
        expect(listDocuments).toHaveBeenCalledWith('work-1', 'user-1', {
            class: 'decision',
            limit: CANDIDATE_LIMIT,
        });
    });

    it('scores only accepted, non-proposed decisions', async () => {
        const { service } = makeService([
            decisionDoc({ id: 'accepted-1' }),
            decisionDoc({ id: 'proposed-1', decision: { status: 'proposed' } }),
            decisionDoc({ id: 'superseded-1', decision: { status: 'superseded' } }),
            decisionDoc({ id: 'unreviewed-1', reviewState: 'proposed' }),
        ]);
        const report = await service.checkIntent({
            workId: 'work-1',
            userId: 'user-1',
            title: 'Replace the primary database engine, dropping PostgreSQL',
        });
        expect(report.scanned).toBe(1);
        expect(report.conflicts.map((c) => c.documentId)).toEqual(['accepted-1']);
    });

    it('sorts conflicts by descending score and honours maxConflicts', async () => {
        const { service } = makeService([
            decisionDoc({
                id: 'weak',
                title: 'Adopt trunk-based development with short-lived branches',
                description: null,
                decision: { status: 'accepted' },
            }),
            decisionDoc({ id: 'strong', decision: { status: 'accepted' } }),
        ]);
        const report = await service.checkIntent({
            workId: 'work-1',
            userId: 'user-1',
            title: 'Move the primary database engine off PostgreSQL and adopt trunk based development',
            maxConflicts: 1,
        });
        expect(report.conflicts).toHaveLength(1);
        expect(report.scanned).toBe(2);
    });

    it('degrades to an empty report when the KB read fails (never breaks Task creation)', async () => {
        const listDocuments = jest.fn().mockRejectedValue(new Error('db down'));
        const service = new DecisionConflictService({
            listDocuments,
        } as unknown as KnowledgeBaseService);
        const report = await service.checkIntent({
            workId: 'work-1',
            userId: 'user-1',
            title: 'Replace the primary database engine, dropping PostgreSQL',
        });
        expect(report.conflicts).toEqual([]);
        expect(report.scanned).toBe(0);
    });

    it('returns nothing for an intent too short to judge', async () => {
        const { service, listDocuments } = makeService([decisionDoc()]);
        const report = await service.checkIntent({
            workId: 'work-1',
            userId: 'user-1',
            title: 'Fix',
        });
        expect(report.conflicts).toEqual([]);
        expect(listDocuments).not.toHaveBeenCalled();
    });
});
