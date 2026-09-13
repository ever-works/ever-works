import type { ObjectLiteral } from 'typeorm';
import { FRESH_WINDOW_MS, MATCH_SCORES, MAX_SCORE } from '../ranking';
import { knowledgeDocumentDestination, knowledgeSource } from '../sources/knowledge.source';
import {
    buildPrefixPattern,
    buildRelevanceOrder,
    buildWordPrefixPatterns,
    recentIdsForKind,
    WORD_SEPARATORS,
} from '../sources/run-source';
import { taskSource } from '../sources/task.source';
import type {
    WorkspaceSearchSourceDefinition,
    WorkspaceSearchSourceQuery,
} from '../workspace-search.types';

const MISSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TASK_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function sourceQuery(
    overrides: Partial<WorkspaceSearchSourceQuery> = {},
): WorkspaceSearchSourceQuery {
    return {
        scope: { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' },
        containsPattern: '%invoice%',
        subsequencePattern: '%i%n%v%o%i%c%e%',
        exactValue: 'invoice',
        prefixPattern: 'invoice%',
        wordPrefixPatterns: buildWordPrefixPatterns('invoice'),
        recentKeys: [],
        now: new Date('2026-09-13T12:00:00.000Z'),
        cap: 25,
        ...overrides,
    };
}

describe('workspace-search source query helpers', () => {
    it('escapes LIKE wildcards in the prefix pattern', () => {
        expect(buildPrefixPattern('  100%_Off ')).toBe('100\\%\\_off%');
    });

    it('builds one escaped word-start pattern per separator', () => {
        const patterns = buildWordPrefixPatterns('Inv');
        expect(patterns).toHaveLength(WORD_SEPARATORS.length);
        expect(patterns).toContain('% inv%');
        expect(patterns).toContain('%-inv%');
        expect(patterns).toContain('%\\_inv%');
    });

    it('builds no word-start pattern for a query that spans words', () => {
        expect(buildWordPrefixPatterns('invoice run')).toEqual([]);
        expect(buildWordPrefixPatterns('t-418')).toEqual([]);
        expect(buildWordPrefixPatterns('   ')).toEqual([]);
    });

    it("keeps only this kind's uuid-shaped recent ids, once each", () => {
        expect(
            recentIdsForKind('mission', [
                `mission:${MISSION_ID}`,
                `mission:${MISSION_ID}`,
                `task:${TASK_ID}`,
                'mission:not-a-uuid',
                `missionary:${MISSION_ID}`,
            ]),
        ).toEqual([MISSION_ID]);
    });
});

describe('buildRelevanceOrder', () => {
    const task = taskSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>;

    it('orders the ranking bands from strongest to weakest and caps the score', () => {
        const { expression } = buildRelevanceOrder(task, sourceQuery());
        const band = (score: number) => expression.indexOf(`THEN ${score} `);
        const order = [
            MATCH_SCORES.exact,
            MATCH_SCORES.prefix,
            MATCH_SCORES.wordPrefix,
            MATCH_SCORES.contains,
            MATCH_SCORES.identifier,
            MATCH_SCORES.secondary,
            MATCH_SCORES.fuzzy,
        ].map(band);
        expect(order.every((position) => position > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(expression.startsWith('CASE WHEN (')).toBe(true);
        expect(expression).toContain(`> ${MAX_SCORE} THEN ${MAX_SCORE} ELSE`);
        expect(expression).toContain('LOWER(task.slug) = :wsExact');
        expect(expression).not.toMatch(/\bILIKE\b|~\*/i);
    });

    it('binds every query-derived value as a parameter', () => {
        const now = new Date('2026-09-13T12:00:00.000Z');
        const { expression, parameters } = buildRelevanceOrder(
            task,
            sourceQuery({ now, recentKeys: [`task:${TASK_ID}`, `mission:${MISSION_ID}`] }),
        );
        expect(expression).not.toContain('invoice');
        expect(expression).toContain('task.id IN (:...wsRecentIds)');
        expect(parameters).toMatchObject({
            wsExact: 'invoice',
            wsPrefix: 'invoice%',
            wsContains: '%invoice%',
            wsSubsequence: '%i%n%v%o%i%c%e%',
            wsWord0: '% invoice%',
            wsRecentIds: [TASK_ID],
            wsNow: now,
        });
        expect((parameters.wsFreshSince as Date).getTime()).toBe(now.getTime() - FRESH_WINDOW_MS);
    });

    it('leaves out the bands and boosts the query cannot use', () => {
        const { expression, parameters } = buildRelevanceOrder(
            task,
            sourceQuery({ subsequencePattern: null, wordPrefixPatterns: [], recentKeys: [] }),
        );
        expect(expression).not.toContain(`THEN ${MATCH_SCORES.wordPrefix} `);
        expect(expression).not.toContain(`THEN ${MATCH_SCORES.fuzzy} `);
        expect(expression).not.toContain('wsRecentIds');
        expect(parameters).not.toHaveProperty('wsSubsequence');
        expect(parameters).not.toHaveProperty('wsRecentIds');
    });
});

describe('knowledge destinations', () => {
    it('percent-encodes each path segment but keeps the separators', () => {
        expect(knowledgeDocumentDestination('work-1', 'legal/q&a #1?.md')).toBe(
            '/works/work-1/kb/legal/q%26a%20%231%3F.md',
        );
        expect(knowledgeDocumentDestination('work-1', 'brand/voice.md')).toBe(
            '/works/work-1/kb/brand/voice.md',
        );
    });

    it('keeps a stored # or ? inside the route path', () => {
        const candidate = knowledgeSource.toCandidate({
            id: 'doc-1',
            workId: 'work-1',
            path: 'faq/why?#top.md',
            title: 'Why',
            slug: 'why',
            tags: [],
            status: 'active',
            updatedAt: null,
        } as never);
        const url = new URL(candidate.destination, 'https://app.example');
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(decodeURIComponent(url.pathname)).toBe('/works/work-1/kb/faq/why?#top.md');
    });
});
