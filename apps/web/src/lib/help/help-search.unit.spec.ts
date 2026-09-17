import { describe, expect, it } from 'vitest';
import type { HelpSection } from '@ever-works/contracts/api';
import {
    foldForSearch,
    HELP_SEARCH_MAX_PER_SECTION,
    HELP_SEARCH_MAX_RESULTS,
    HELP_SEARCH_SCORES,
    rankHelpArticles,
} from './help-search';
import { getHelpArticles } from './help-target';
import type { HelpArticleMeta } from './help-types';

function article(
    id: string,
    overrides: Partial<Omit<HelpArticleMeta, 'id'>> & { section?: HelpSection } = {},
): HelpArticleMeta {
    return {
        id,
        section: 'start-here',
        order: 10,
        title: `Article ${id}`,
        label: id,
        summary: 'Nothing to see.',
        keywords: [],
        documents: [],
        related: [],
        reviewedAt: '2026-09-14',
        source: `docs/${id}.md`,
        docsUrl: `https://docs.example.org/${id}`,
        headings: [{ id: 'intro', text: 'Intro', level: 2 }],
        ...overrides,
    };
}

const scoreOf = (articles: HelpArticleMeta[], query: string, id: string, current: string[] = []) =>
    rankHelpArticles({ query, articles, currentArticleIds: current }).results.find(
        (r) => r.article.id === id,
    )?.score;

describe('foldForSearch (spec FR-18.3)', () => {
    it('folds case, diacritics and whitespace', () => {
        expect(foldForSearch('  Crème   BRÛLÉE ')).toBe('creme brulee');
    });
});

describe('rankHelpArticles — floor (spec FR-18.2)', () => {
    it('returns nothing below two trimmed characters', () => {
        const articles = [article('caps', { title: 'Caps' })];
        expect(rankHelpArticles({ query: 'c', articles }).total).toBe(0);
        expect(rankHelpArticles({ query: ' c ', articles }).total).toBe(0);
        expect(rankHelpArticles({ query: 'ca', articles }).total).toBe(1);
    });
});

describe('rankHelpArticles — score table (spec FR-18.5)', () => {
    it('scores each kind of match exactly as the table says', () => {
        const articles = [
            article('equals', { title: 'Budgets' }),
            article('starts', { title: 'Budgets and usage' }),
            article('heading-starts', {
                headings: [{ id: 'b', text: 'Budgets per work', level: 2 }],
            }),
            article('keyword', { keywords: ['budgets'] }),
            article('contains', { title: 'Your budgets' }),
            article('summary', { summary: 'Set budgets here.' }),
            // A different section, so the six-per-section cap keeps it in the results.
            article('heading-contains', {
                section: 'money-and-limits',
                headings: [{ id: 'b', text: 'Per work budgets', level: 3 }],
            }),
        ];
        expect(scoreOf(articles, 'budgets', 'equals')).toBe(HELP_SEARCH_SCORES.titleEquals);
        expect(scoreOf(articles, 'budgets', 'starts')).toBe(HELP_SEARCH_SCORES.titleStartsWith);
        expect(scoreOf(articles, 'budgets', 'heading-starts')).toBe(
            HELP_SEARCH_SCORES.headingStartsWith,
        );
        expect(scoreOf(articles, 'budgets', 'keyword')).toBe(HELP_SEARCH_SCORES.keywordEquals);
        expect(scoreOf(articles, 'budgets', 'contains')).toBe(HELP_SEARCH_SCORES.titleContains);
        expect(scoreOf(articles, 'budgets', 'summary')).toBe(HELP_SEARCH_SCORES.summaryContains);
        expect(scoreOf(articles, 'budgets', 'heading-contains')).toBe(
            HELP_SEARCH_SCORES.headingContains,
        );
    });

    it('scores a body match only when bodies are supplied, and below every title match', () => {
        const articles = [article('body'), article('title', { title: 'Queued runs' })];
        expect(
            rankHelpArticles({ query: 'queued', articles }).results.map((r) => r.article.id),
        ).toEqual(['title']);
        const withBodies = rankHelpArticles({
            query: 'queued',
            articles,
            bodies: new Map([['body', 'A run sits queued when…']]),
        });
        expect(withBodies.results.map((r) => [r.article.id, r.score])).toEqual([
            ['title', HELP_SEARCH_SCORES.titleStartsWith],
            ['body', HELP_SEARCH_SCORES.bodyContains],
        ]);
    });

    it('opens a heading match at that heading and every other match at the top (spec FR-18.7)', () => {
        const heading = { id: 'caps', text: 'Caps per agent', level: 2 as const };
        const outcome = rankHelpArticles({
            query: 'caps',
            articles: [article('a', { headings: [heading] }), article('b', { title: 'Caps' })],
        });
        expect(outcome.results.find((r) => r.article.id === 'a')?.heading).toEqual(heading);
        expect(outcome.results.find((r) => r.article.id === 'b')?.heading).toBeNull();
    });

    it('adds +5 for an article that documents the current screen, capped at 100', () => {
        const articles = [
            article('equals', { title: 'Tasks' }),
            article('contains', { title: 'My tasks' }),
        ];
        expect(scoreOf(articles, 'tasks', 'contains', ['contains'])).toBe(
            HELP_SEARCH_SCORES.titleContains + 5,
        );
        expect(scoreOf(articles, 'tasks', 'equals', ['equals'])).toBe(100);
    });
});

describe('rankHelpArticles — order and caps (spec FR-18.4, FR-18.6)', () => {
    it('breaks ties by current screen, then section order, then title', () => {
        const articles = [
            article('z', { title: 'Zeta memo', section: 'your-agents' }),
            article('y', { title: 'Alpha memo', section: 'your-agents' }),
            article('x', { title: 'Memo here', section: 'running-the-loop', summary: 'memo' }),
            article('w', { title: 'Beta memo', section: 'start-here' }),
        ];
        const ordered = rankHelpArticles({ query: 'memo', articles }).groups.map((g) => [
            g.section,
            g.results.map((r) => r.article.id),
        ]);
        expect(ordered).toEqual([
            ['start-here', ['w']],
            ['running-the-loop', ['x']],
            ['your-agents', ['y', 'z']],
        ]);
    });

    it('promotes the section holding an exact title match to the top', () => {
        const articles = [
            article('first', { title: 'Guide to runs', section: 'start-here' }),
            article('exact', { title: 'Runs', section: 'when-something-goes-wrong' }),
        ];
        expect(rankHelpArticles({ query: 'runs', articles }).groups[0].section).toBe(
            'when-something-goes-wrong',
        );
    });

    it('never returns more than 20 results or more than 6 per section', () => {
        const sections: HelpSection[] = [
            'start-here',
            'running-the-loop',
            'your-agents',
            'money-and-limits',
        ];
        const articles = sections.flatMap((section) =>
            Array.from({ length: 9 }, (_, i) =>
                article(`${section}-${i}`, { section, title: `Setup ${i}` }),
            ),
        );
        const outcome = rankHelpArticles({ query: 'setup', articles });
        expect(outcome.total).toBe(HELP_SEARCH_MAX_RESULTS);
        for (const group of outcome.groups) {
            expect(group.results.length).toBeLessThanOrEqual(HELP_SEARCH_MAX_PER_SECTION);
        }
        expect(outcome.results).toHaveLength(outcome.total);
    });

    it('is deterministic over the shipped catalog', () => {
        const run = () =>
            rankHelpArticles({ query: 'agent', articles: getHelpArticles() }).results.map(
                (r) => r.article.id,
            );
        expect(run()).toEqual(run());
        expect(run().length).toBeGreaterThan(0);
    });
});
