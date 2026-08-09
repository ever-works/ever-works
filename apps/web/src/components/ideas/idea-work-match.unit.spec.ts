import { describe, expect, it } from 'vitest';
import { findMatchingWork, matchIdeasToWorks, normalizeForMatch } from './idea-work-match';

/**
 * Content matching is the fallback that marks an Idea built when the Work
 * it produced carries no provenance link — the user built it outside the
 * `/works/new?proposal=…` flow. It must be generous about typography and
 * strict about everything else: a wrong match sends the user to an
 * unrelated Work under a green "Built" badge.
 */
const idea = {
    id: 'idea-1',
    title: 'Top AI coding assistants',
    description: 'A curated directory of the leading AI-powered coding tools, updated weekly.',
};

const work = {
    id: 'work-1',
    name: 'Top AI coding assistants',
    description: 'A curated directory of the leading AI-powered coding tools, updated weekly.',
};

describe('normalizeForMatch', () => {
    it('ignores case, punctuation and whitespace shape', () => {
        expect(normalizeForMatch('  Top AI — Coding, Assistants!\n')).toBe(
            normalizeForMatch('top ai coding assistants'),
        );
    });

    it('treats a missing value as empty', () => {
        expect(normalizeForMatch(null)).toBe('');
        expect(normalizeForMatch(undefined)).toBe('');
    });
});

describe('findMatchingWork', () => {
    it('matches an identical title + description', () => {
        expect(findMatchingWork(idea, [work])).toBe(work);
    });

    it('matches through typographic differences', () => {
        const typographic = {
            ...work,
            name: 'Top AI Coding Assistants',
            description: `${idea.description.replace(/,/g, '')}  `,
        };

        expect(findMatchingWork(idea, [typographic])).toBe(typographic);
    });

    it('matches when the Work description expands the Idea description', () => {
        // The Work form seeds its prompt from the Idea description and the
        // AI detail generator expands it, so the stored description
        // contains the original rather than equalling it.
        const expanded = {
            ...work,
            description: `${idea.description} Includes pricing, editor support and benchmarks.`,
        };

        expect(findMatchingWork(idea, [expanded])).toBe(expanded);
    });

    it('does not match on the name alone when the Work has a real description', () => {
        // The strongest guard against a false Built badge: two records can
        // share a generic name and be about entirely different things.
        expect(findMatchingWork(idea, [{ ...work, description: 'Something else entirely.' }])).toBe(
            null,
        );
    });

    describe('Works whose description says nothing the name has not', () => {
        // A description derived from the Work's own name is not
        // independent evidence, so it must not be able to veto an exact
        // name match — it left real builds reading "Not built yet".
        it('matches through the "Work for {name}" AI-failure placeholder', () => {
            // Verbatim from a real pair: the Work was created with no
            // working AI provider, so WorkDetailService fell back to the
            // placeholder while the Idea kept its own long description.
            const realIdea = {
                id: '1c0120a4',
                title: 'this is the 3th idea',
                description:
                    'Here is a casual, unexpected text you can send to a friend or crush to break the ice:',
            };
            const realWork = {
                id: 'e907dcb6',
                name: 'this is the 3th idea',
                description: 'Work for this is the 3th idea',
            };

            expect(findMatchingWork(realIdea, [realWork])).toBe(realWork);
        });

        it('matches an empty Work description', () => {
            const bare = { ...work, description: '' };
            expect(findMatchingWork(idea, [bare])).toBe(bare);
        });

        it('matches a Work description that just repeats the name', () => {
            const echo = { ...work, description: work.name };
            expect(findMatchingWork(idea, [echo])).toBe(echo);
        });

        it('still requires the name to be identical', () => {
            expect(
                findMatchingWork(idea, [
                    {
                        ...work,
                        name: 'An unrelated Work',
                        description: 'Work for an unrelated Work',
                    },
                ]),
            ).toBe(null);
        });
    });

    it('does not match on the description alone', () => {
        expect(findMatchingWork(idea, [{ ...work, name: 'A different Work' }])).toBe(null);
    });

    it('does not match an Idea with no description against a described Work', () => {
        // Nothing to corroborate the name with, and the Work does have a
        // real description to disagree with.
        expect(findMatchingWork({ ...idea, description: '' }, [work])).toBe(null);
    });

    it('requires substance before matching a short description by containment', () => {
        // "A directory" being a prefix of a longer text says nothing.
        const shortIdea = { ...idea, description: 'A directory.' };
        const longWork = { ...work, description: 'A directory of unrelated municipal records.' };

        expect(findMatchingWork(shortIdea, [longWork])).toBe(null);
    });

    it('ignores an Idea with no title', () => {
        expect(findMatchingWork({ ...idea, title: '   ' }, [{ ...work, name: '' }])).toBe(null);
    });

    it('returns the first match, so a newest-first list yields the newest Work', () => {
        const older = { ...work, id: 'work-0' };
        expect(findMatchingWork(idea, [work, older])).toBe(work);
    });
});

describe('matchIdeasToWorks', () => {
    it('maps only the Ideas that matched', () => {
        const unmatched = {
            id: 'idea-2',
            title: 'Nothing built',
            description: 'No Work for this.',
        };

        expect(matchIdeasToWorks([idea, unmatched], [work])).toEqual({ 'idea-1': 'work-1' });
    });
});
