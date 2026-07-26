import { getWorkRepoFullName, matchWorkByRepo, parseRepoFullName } from './work-repo-match';
import type { Work } from '../entities/work.entity';

/**
 * The single repo→Work matcher. Both the PR reviewer and the ingest
 * `workHint` resolver route through this, so its edge cases are pinned
 * here once rather than duplicated in each caller's spec.
 */

function makeWork(
    id: string,
    repos: Partial<Record<'work' | 'website' | 'data', { owner: string; name: string }>>,
): Work {
    return {
        id,
        getRepoOwner: (role: 'work' | 'website' | 'data') => repos[role]?.owner,
        getMainRepo: () => repos.work?.name,
        getWebsiteRepo: () => repos.website?.name,
        getDataRepo: () => repos.data?.name,
    } as unknown as Work;
}

describe('matchWorkByRepo', () => {
    it('matches the main (work) repo role', () => {
        const work = makeWork('w1', { work: { owner: 'acme', name: 'site' } });
        expect(matchWorkByRepo([work], 'acme', 'site')?.id).toBe('w1');
    });

    it('matches the website and data repo roles too', () => {
        const website = makeWork('w-site', { website: { owner: 'acme', name: 'www' } });
        const data = makeWork('w-data', { data: { owner: 'acme', name: 'content' } });
        expect(matchWorkByRepo([website, data], 'acme', 'www')?.id).toBe('w-site');
        expect(matchWorkByRepo([website, data], 'acme', 'content')?.id).toBe('w-data');
    });

    it('compares case-insensitively (GitHub owners/repos are case-preserving, not case-sensitive)', () => {
        const work = makeWork('w1', { work: { owner: 'Acme', name: 'Site' } });
        expect(matchWorkByRepo([work], 'acme', 'SITE')?.id).toBe('w1');
    });

    it('returns null when nothing claims the repo', () => {
        const work = makeWork('w1', { work: { owner: 'acme', name: 'site' } });
        expect(matchWorkByRepo([work], 'other', 'thing')).toBeNull();
    });

    it('returns null for an empty target rather than matching a half-declared Work', () => {
        const work = makeWork('w1', { work: { owner: 'acme', name: 'site' } });
        expect(matchWorkByRepo([work], '', '')).toBeNull();
    });

    it('first match wins when two Works claim the same repo', () => {
        const first = makeWork('first', { work: { owner: 'acme', name: 'site' } });
        const second = makeWork('second', { work: { owner: 'acme', name: 'site' } });
        expect(matchWorkByRepo([first, second], 'acme', 'site')?.id).toBe('first');
    });

    it('ignores a role with an owner but no repo name (and vice versa)', () => {
        const partial = makeWork('w1', {});
        expect(getWorkRepoFullName(partial, 'work')).toBeNull();
        expect(matchWorkByRepo([partial], 'acme', 'site')).toBeNull();
    });
});

describe('parseRepoFullName', () => {
    it('splits owner/repo', () => {
        expect(parseRepoFullName('acme/site')).toEqual({ owner: 'acme', repo: 'site' });
    });

    it('rejects anything that is not exactly two non-empty segments', () => {
        expect(parseRepoFullName('acme')).toBeNull();
        expect(parseRepoFullName('acme/')).toBeNull();
        expect(parseRepoFullName('/site')).toBeNull();
        expect(parseRepoFullName('a/b/c')).toBeNull();
        expect(parseRepoFullName('   ')).toBeNull();
    });
});
