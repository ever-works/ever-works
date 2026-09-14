import { describe, expect, it } from 'vitest';
import {
    formatHelpTarget,
    getHelpArticle,
    getHelpArticles,
    groupHelpArticlesBySection,
    parseHelpTarget,
    resolveHelpTarget,
    suggestHelpArticles,
    type HelpTarget,
} from './help-target';

describe('parseHelpTarget / formatHelpTarget', () => {
    it('round-trips an article and an article at a heading', () => {
        expect(parseHelpTarget('missions')).toEqual({ articleId: 'missions', headingId: null });
        expect(parseHelpTarget('missions#creating-a-mission')).toEqual({
            articleId: 'missions',
            headingId: 'creating-a-mission',
        });
        expect(formatHelpTarget('missions')).toBe('missions');
        expect(formatHelpTarget('missions', 'creating-a-mission')).toBe(
            'missions#creating-a-mission',
        );
        expect(formatHelpTarget('missions', null)).toBe('missions');
    });

    it('rejects empty and heading-only values', () => {
        expect(parseHelpTarget('')).toBeNull();
        expect(parseHelpTarget('   ')).toBeNull();
        expect(parseHelpTarget('#heading')).toBeNull();
        expect(parseHelpTarget('missions#')).toEqual({ articleId: 'missions', headingId: null });
    });
});

describe('resolveHelpTarget (spec FR-22, S-15)', () => {
    it('resolves a known article and heading', () => {
        const resolved = resolveHelpTarget('tasks#creating-a-task');
        expect(resolved?.article.id).toBe('tasks');
        expect(resolved?.heading?.id).toBe('creating-a-task');
        expect(resolved?.headingMissing).toBe(false);
    });

    it('resolves an unknown article to null', () => {
        expect(resolveHelpTarget('agent-computers')).toBeNull();
        expect(resolveHelpTarget('')).toBeNull();
    });

    it('resolves a known article with an unknown heading and flags it', () => {
        const resolved = resolveHelpTarget('missions#writing-a-brief');
        expect(resolved?.article.id).toBe('missions');
        expect(resolved?.heading).toBeNull();
        expect(resolved?.headingId).toBe('writing-a-brief');
        expect(resolved?.headingMissing).toBe(true);
    });
});

describe('HelpTarget type (spec FR-5.3)', () => {
    it('accepts real targets and rejects ones this build does not have at compile time', () => {
        const ok: HelpTarget[] = ['missions', 'job-runtimes#settings--job-runtime'];
        // @ts-expect-error — not an article in this build
        const missingArticle: HelpTarget = 'agent-computers';
        // @ts-expect-error — not a heading of the Missions article
        const missingHeading: HelpTarget = 'missions#writing-a-brief';
        expect(ok.every((target) => resolveHelpTarget(target) !== null)).toBe(true);
        expect(
            [missingArticle, missingHeading].map(
                (target) => resolveHelpTarget(target)?.headingMissing,
            ),
        ).toEqual([undefined, true]);
    });
});

describe('catalog helpers', () => {
    it('looks articles up by id', () => {
        expect(getHelpArticle('memory')?.title).toBeTruthy();
        expect(getHelpArticle('nope')).toBeNull();
    });

    it('groups articles by section in reading order and omits empty sections', () => {
        const groups = groupHelpArticlesBySection();
        expect(groups[0].section).toBe('start-here');
        expect(groups.flatMap((group) => group.articles)).toHaveLength(getHelpArticles().length);
        expect(
            groupHelpArticlesBySection(
                getHelpArticles().filter((a) => a.section === 'your-agents'),
            ),
        ).toEqual([expect.objectContaining({ section: 'your-agents' })]);
    });

    it('suggests up to three near titles for a slug and nothing for an unrelated one', () => {
        const suggestions = suggestHelpArticles('agent-computers');
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions.length).toBeLessThanOrEqual(3);
        expect(suggestions.map((article) => article.id)).toContain('agents');
        expect(suggestHelpArticles('zzzqqq')).toEqual([]);
        expect(suggestHelpArticles('')).toEqual([]);
    });
});
