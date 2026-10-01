/**
 * Unit spec for `firstWorkWithItemsTab` — the seeded-Work pick of
 * `flow-breadcrumbs-navigation.spec.ts`.
 *
 * That spec drives the Work tab strip as a breadcrumb trail and needs the
 * Items crumb. It used to take `works[0]` of the seeded user, and `GET
 * /api/works` lists the most recently updated first
 * (`WorkRepository.findAllAccessible`: `work.updatedAt DESC`), so the pick was
 * whichever Work an earlier spec in the same shard created or touched last. The App Works specs create App Works for
 * the seeded user, and kind `app` has no Items tab by design, so the pick
 * landed on a Work with no Items crumb (e2e run 36187829618, shard 7: the
 * seeded user's first-listed Work was `t19-app-…`, kind `app`).
 *
 * The rule is the product's own (`workKindHasItems`), so this spec also pins
 * that the helper follows `WORK_KIND_CAPABILITIES` for every kind rather than a
 * copy of it.
 */

import {
    getWorkCapabilities,
    WORK_KIND_CAPABILITIES,
    WORK_KINDS,
    workKindHasItems,
} from '@ever-works/contracts';
import { describe, expect, it } from 'vitest';

import { firstWorkWithItemsTab, firstWorkWithTaxonomy } from '../work-kind-fixtures';

describe('firstWorkWithItemsTab', () => {
    it('skips an earlier-listed App Work and answers the first Work whose kind has an Items tab', () => {
        // The listing CI served on shard 7, in its order (ids shortened).
        const works = [
            { id: 'app-listed-first', kind: 'app' },
            { id: 'website', kind: 'website' },
            { id: 'app-listed-later', kind: 'app' },
        ];

        expect(firstWorkWithItemsTab(works)?.id).toBe('website');
    });

    it('answers undefined when no listed Work has an Items tab', () => {
        expect(firstWorkWithItemsTab([{ id: 'a', kind: 'app' }])).toBeUndefined();
        expect(firstWorkWithItemsTab([])).toBeUndefined();
    });

    it('treats a missing or unknown kind as the default kind, which has Items', () => {
        expect(firstWorkWithItemsTab([{ id: 'no-kind' }])?.id).toBe('no-kind');
        expect(firstWorkWithItemsTab([{ id: 'null-kind', kind: null }])?.id).toBe('null-kind');
        expect(firstWorkWithItemsTab([{ id: 'future', kind: 'kind-from-the-future' }])?.id).toBe(
            'future',
        );
    });

    it('agrees with the capability table for every kind', () => {
        const kinds = Object.keys(WORK_KIND_CAPABILITIES);
        expect(kinds.length).toBeGreaterThan(0);
        for (const kind of kinds) {
            const picked = firstWorkWithItemsTab([{ id: kind, kind }]);
            expect(picked?.id, `kind ${kind}`).toBe(workKindHasItems(kind) ? kind : undefined);
        }
        // The kind this pick exists for must stay Items-less, or the pick is moot.
        expect(workKindHasItems('app')).toBe(false);
        expect(WORK_KINDS).toContain('app');
    });
});

/**
 * `GET /api/works` lists every Work the caller can see — its own AND the ones
 * it is only a member of (`WorkQueryService.getWorks`: `userRole` is `owner`
 * for the creator, the member role otherwise). `flow-app-spec-recheck` makes
 * the seeded user a VIEWER of another account's App Works, so "the seeded
 * user's Works" is not the same set as the listing. When the rows carry
 * `userRole`, an owned Work wins; a member-only one is the fallback rather than
 * a skip, so a shard where the seeded user owns nothing eligible still runs.
 */
describe('seeded-Work picks prefer a Work the seeded user owns', () => {
    it('picks an owned Work over an earlier-listed member-only Work of an eligible kind', () => {
        const works = [
            { id: 'member-directory', kind: 'directory', userRole: 'viewer' },
            { id: 'owned-website', kind: 'website', userRole: 'owner' },
        ];

        expect(firstWorkWithItemsTab(works)?.id).toBe('owned-website');
    });

    it('never prefers an owned Work whose kind lacks the surface', () => {
        const works = [
            { id: 'owned-app', kind: 'app', userRole: 'owner' },
            { id: 'member-directory', kind: 'directory', userRole: 'editor' },
        ];

        expect(firstWorkWithItemsTab(works)?.id).toBe('member-directory');
    });

    it('falls back to the first eligible member-only Work when none eligible is owned', () => {
        const works = [
            { id: 'member-blog', kind: 'blog', userRole: 'manager' },
            { id: 'member-directory', kind: 'directory', userRole: 'viewer' },
        ];

        expect(firstWorkWithItemsTab(works)?.id).toBe('member-blog');
    });

    it('keeps list order when the rows carry no userRole', () => {
        const works = [
            { id: 'first', kind: 'directory' },
            { id: 'second', kind: 'directory', userRole: null },
        ];

        expect(firstWorkWithItemsTab(works)?.id).toBe('first');
    });
});

/**
 * `flow-work-taxonomy-deep.spec.ts` reads the seeded user's Work taxonomy
 * (`/categories-tags`, `/count`) and pins the success envelope. Those reads
 * are the Taxonomy surface, which an App Work does not have
 * (`WORK_KIND_CAPABILITIES.app.taxonomy === false`) and whose backing data
 * repository it never provisions (`repos.data === false`) — the API only
 * answered 200 for one by tolerating the failed clone of a derived `-data`
 * name. The pick asks for the capability instead of relying on that.
 */
describe('firstWorkWithTaxonomy', () => {
    it('skips an earlier-listed App Work and a website Work (no taxonomy) for the first kind with taxonomy', () => {
        const works = [
            { id: 'app-listed-first', kind: 'app', userRole: 'owner' },
            { id: 'website', kind: 'website', userRole: 'owner' },
            { id: 'directory', kind: 'directory', userRole: 'owner' },
        ];

        expect(firstWorkWithTaxonomy(works)?.id).toBe('directory');
    });

    it('prefers an owned Work, falls back to a member-only one, else undefined', () => {
        expect(
            firstWorkWithTaxonomy([
                { id: 'member-default', kind: 'default', userRole: 'viewer' },
                { id: 'owned-blog', kind: 'blog', userRole: 'owner' },
            ])?.id,
        ).toBe('owned-blog');
        expect(
            firstWorkWithTaxonomy([{ id: 'member-default', kind: 'default', userRole: 'viewer' }])
                ?.id,
        ).toBe('member-default');
        expect(firstWorkWithTaxonomy([{ id: 'a', kind: 'app' }])).toBeUndefined();
        expect(firstWorkWithTaxonomy([])).toBeUndefined();
    });

    it('agrees with the capability table for every kind, including a missing kind', () => {
        for (const kind of WORK_KINDS) {
            const picked = firstWorkWithTaxonomy([{ id: kind, kind }]);
            expect(picked?.id, `kind ${kind}`).toBe(
                getWorkCapabilities(kind).taxonomy ? kind : undefined,
            );
        }
        expect(firstWorkWithTaxonomy([{ id: 'no-kind' }])?.id).toBe('no-kind');
        expect(getWorkCapabilities('app').taxonomy).toBe(false);
    });
});
