import { describe, expect, it } from 'vitest';
import { matchHelpScreen, screenPattern } from './help-screen-map';
import { getHelpArticles } from './help-target';

const articles = getHelpArticles();

describe('screenPattern', () => {
    it('drops query and hash from literal routes and fills builder parameters', () => {
        expect(screenPattern('DASHBOARD_USAGE_COSTS')).toBe('/settings/usage');
        // Skills is a sub-tab of the Agents hub with a path of its own now; it
        // used to be an `#skills` anchor on /agents, and a hash is dropped here.
        expect(screenPattern('DASHBOARD_AGENTS_SKILLS')).toBe('/agents/skills');
        expect(screenPattern('DASHBOARD_AGENTS_ACTIVITY')).toBe('/agents/activity');
        expect(screenPattern('DASHBOARD_WORK_KB')).toBe('/works/:param/kb');
        expect(screenPattern('AUTH_LOGIN')).toBeNull();
        expect(screenPattern('NOT_A_ROUTE')).toBeNull();
    });
});

describe('matchHelpScreen (spec S-1 "On this screen")', () => {
    it('maps the home screen', () => {
        const match = matchHelpScreen('/', articles);
        expect(match.routeKeys).toContain('DASHBOARD');
        expect(match.articleIds).toEqual(expect.arrayContaining(['dashboard', 'getting-started']));
    });

    it('maps a list screen and its detail screen', () => {
        expect(matchHelpScreen('/missions', articles).articleIds).toEqual(['missions']);
        expect(matchHelpScreen('/missions/0f4c2a', articles).articleIds).toEqual(['missions']);
    });

    it('prefers the most specific screen: a Work sub-screen maps to the Knowledge Base, not the Work', () => {
        expect(matchHelpScreen('/works/abc/kb', articles).articleIds).toEqual(['knowledge-base']);
        expect(matchHelpScreen('/works/abc/kb/legal/privacy.md', articles).articleIds).toEqual([
            'knowledge-base',
        ]);
        expect(matchHelpScreen('/works/abc', articles).articleIds).toEqual(['creating-a-work']);
    });

    it('falls back to the nearest documented screen for an undocumented sub-screen', () => {
        expect(matchHelpScreen('/works/abc/items', articles).articleIds).toEqual([
            'creating-a-work',
        ]);
    });

    it('maps a settings sub-screen', () => {
        expect(matchHelpScreen('/settings/job-runtime', articles).articleIds).toEqual([
            'job-runtimes',
        ]);
        expect(matchHelpScreen('/settings/usage/', articles).articleIds).toEqual([
            'budgets-and-usage',
        ]);
    });

    it('returns an empty result rather than throwing for an unmapped or missing path', () => {
        expect(matchHelpScreen('/definitely/not/a/screen', articles)).toEqual({
            routeKeys: [],
            articleIds: [],
        });
        expect(matchHelpScreen(null, articles)).toEqual({ routeKeys: [], articleIds: [] });
        expect(matchHelpScreen('/missions', [])).toEqual({ routeKeys: [], articleIds: [] });
    });
});
