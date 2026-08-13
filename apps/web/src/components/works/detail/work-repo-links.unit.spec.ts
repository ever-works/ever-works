import { describe, it, expect } from 'vitest';
import { repoLink } from './WorkDetailContext';
import type { GitProviderConnectionInfo, Work } from '@/lib/api/types-only';

/**
 * EW-037 — the Work detail page must not link repositories that do not exist.
 *
 * Observed on production 2026-08-13. The detail page for `EW027 Verify
 * Directory` rendered three "open repository" links; only one worked:
 *
 *   ever-works-cloud/anon-1d565e12-ew027-verify-directory   EXISTS (private)
 *   ever-works-cloud/ew027-verify-directory-data            404
 *   ever-works-cloud/ew027-verify-directory-website         404
 *
 * Managed "Ever Works Git" storage provisions ONE repo under a
 * collision-resistant name (`anon-<hash>-<slug>`), so the conventional
 * `${slug}-data` / `${slug}-website` names are not merely unknown — they are
 * known to be wrong. The old code derived them anyway via per-field `||`
 * fallbacks, producing URLs that look plausible and 404.
 *
 * The rule under test is structural: when `relatedRepositories` is present the
 * platform recorded exactly what it provisioned, so a MISSING role means "no
 * such repository". When the object is absent entirely (self-hosted / legacy
 * Works), the `${slug}-data` convention really is how the user's repos are
 * named, and those links must keep working — that is what stops this fix from
 * being a regression for the majority case.
 */

const connection = {
    homepage: 'https://github.com',
    username: 'someuser',
} as GitProviderConnectionInfo;

/** A managed Work, shaped as `WorkLifecycleService.createWork` persists one. */
function managedWork(overrides: Partial<Work> = {}): Work {
    return {
        id: 'w-1',
        slug: 'ew027-verify-directory',
        name: 'EW027 Verify Directory',
        owner: 'ever-works-cloud',
        organization: true,
        gitProvider: 'github',
        sourceRepository: {
            url: 'https://github.com/ever-works-cloud/anon-1d565e12-ew027-verify-directory',
            owner: 'ever-works-cloud',
            repo: 'anon-1d565e12-ew027-verify-directory',
            type: 'data_repo',
            relatedRepositories: {
                work: {
                    owner: 'ever-works-cloud',
                    repo: 'anon-1d565e12-ew027-verify-directory',
                },
                data: {
                    owner: 'ever-works-cloud',
                    repo: 'anon-1d565e12-ew027-verify-directory',
                },
            },
        },
        ...overrides,
    } as unknown as Work;
}

describe('repoLink — never link a repository that was not provisioned', () => {
    it('control: the derived name differs from the provisioned one, so these tests can fail', () => {
        const work = managedWork();
        // If this ever stops holding, every assertion below goes vacuous — the
        // derived URL would accidentally be correct. Fail loudly instead.
        expect(`${work.slug}-data`).not.toBe(
            work.sourceRepository?.relatedRepositories?.data?.repo,
        );
    });

    it('uses the RECORDED repo name for a managed Work, not the derived one', () => {
        const links = repoLink(managedWork(), connection);

        expect(links?.dataRepo).toBe(
            'https://github.com/ever-works-cloud/anon-1d565e12-ew027-verify-directory',
        );
        // The exact string production served, which 404s.
        expect(links?.dataRepo).not.toContain('ew027-verify-directory-data');
    });

    it('omits the data link for a Work created BEFORE the EW-028 fix', () => {
        // This is the exact production shape I observed: managed storage that
        // recorded only the `work` role, because `createWork` did not yet
        // register `data`. Every such Work already exists in the database and
        // will never gain the role retroactively, so the UI must cope with it —
        // the API-side fix only helps Works created from now on.
        //
        // Pre-fix this rendered
        //   https://github.com/ever-works-cloud/ew027-verify-directory-data
        // which 404s.
        const work = managedWork({
            sourceRepository: {
                url: 'https://github.com/ever-works-cloud/anon-1d565e12-ew027-verify-directory',
                owner: 'ever-works-cloud',
                repo: 'anon-1d565e12-ew027-verify-directory',
                type: 'data_repo',
                relatedRepositories: {
                    work: {
                        owner: 'ever-works-cloud',
                        repo: 'anon-1d565e12-ew027-verify-directory',
                    },
                },
            },
        } as Partial<Work>);

        const links = repoLink(work, connection);

        expect(links?.dataRepo).toBeUndefined();
        // The `work` role IS recorded, so that link must still resolve —
        // suppressing everything would be its own bug.
        expect(links?.main).toBe(
            'https://github.com/ever-works-cloud/anon-1d565e12-ew027-verify-directory',
        );
    });

    it('omits the website link entirely when that role was never recorded', () => {
        // Managed storage creates ONE repo. A website repo is a separate
        // artefact gated by `shouldGenerateProviderRepository`; until it is
        // actually created there is no honest URL to show. Pointing this at the
        // work repo would trade a dead link for a WRONG one.
        const links = repoLink(managedWork(), connection);

        expect(links?.websiteRepo).toBeUndefined();
    });

    it('still derives conventional names when no roles were recorded at all', () => {
        // Self-hosted / legacy Works: the convention is real, the links work,
        // and suppressing them here would be the regression.
        const work = managedWork({ sourceRepository: undefined } as Partial<Work>);
        const links = repoLink(work, connection);

        expect(links?.dataRepo).toBe(
            'https://github.com/ever-works-cloud/ew027-verify-directory-data',
        );
        expect(links?.websiteRepo).toBe(
            'https://github.com/ever-works-cloud/ew027-verify-directory-website',
        );
    });

    it('encodes a path-traversal attempt in the slug exactly once', () => {
        // The original encoded `work.slug`, then encoded `"${encSlug}-data"`
        // again — double-escaping any slug that needed encoding at all.
        const work = managedWork({
            slug: '../../evil',
            sourceRepository: undefined,
        } as Partial<Work>);
        const links = repoLink(work, connection);

        expect(links?.dataRepo).toBe('https://github.com/ever-works-cloud/..%2F..%2Fevil-data');
        // Single encoding: a literal '%25' would mean the '%' was escaped twice.
        expect(links?.dataRepo).not.toContain('%25');
        // And the traversal must not survive as real path separators.
        expect(links?.dataRepo).not.toContain('../');
    });
});
