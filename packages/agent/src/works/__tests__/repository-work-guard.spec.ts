import { BadRequestException } from '@nestjs/common';
import {
    REPOSITORY_WORK_REFUSAL,
    assertNotRepositoryWork,
    assertRepositoryRole,
    hasRepositoryRole,
    isRepositoryWork,
} from '../repository-work-guard';

/**
 * The guard is the single place every pipeline asks "may I touch this
 * Work's repositories?". Pin the kind test, the role table it derives from
 * `WORK_KIND_CAPABILITIES`, and the shape of the refusal so entry-point
 * specs can match on it.
 */
describe('repository-work-guard', () => {
    describe('isRepositoryWork / assertNotRepositoryWork', () => {
        it('recognises the repo kind through the same normalisation as the contracts', () => {
            expect(isRepositoryWork({ kind: 'repo' })).toBe(true);
            expect(isRepositoryWork({ kind: ' REPO ' })).toBe(true);
            expect(isRepositoryWork({ kind: 'awesome-repo' })).toBe(false);
            expect(isRepositoryWork({ kind: 'directory' })).toBe(false);
            expect(isRepositoryWork({ kind: undefined })).toBe(false);
            expect(isRepositoryWork({})).toBe(false);
        });

        it('refuses a Repository Work with a 400 that names the Work and the action', () => {
            expect(() =>
                assertNotRepositoryWork({ kind: 'repo', name: 'Platform' }, 'item submission'),
            ).toThrow(BadRequestException);

            let caught: unknown;
            try {
                assertNotRepositoryWork({ kind: 'repo', name: 'Platform' }, 'item submission');
            } catch (error) {
                caught = error;
            }
            const message = (caught as BadRequestException).message;
            expect(message).toContain('Work "Platform"');
            expect(message).toContain(REPOSITORY_WORK_REFUSAL);
            expect(message).toContain('item submission');
        });

        it('falls back to the slug, then to a generic label, when the Work has no name', () => {
            expect(() => assertNotRepositoryWork({ kind: 'repo', slug: 'platform' }, 'x')).toThrow(
                /Work "platform"/,
            );
            expect(() => assertNotRepositoryWork({ kind: 'repo' }, 'x')).toThrow(/^This Work/);
        });

        it.each([
            'default',
            'directory',
            'website',
            'landing-page',
            'blog',
            'awesome-repo',
            'company',
        ])('lets every other kind (%s) through untouched', (kind) => {
            expect(() => assertNotRepositoryWork({ kind }, 'anything')).not.toThrow();
        });
    });

    describe('hasRepositoryRole / assertRepositoryRole', () => {
        it('derives the role table from WORK_KIND_CAPABILITIES.repos', () => {
            // A Repository Work provisions ONLY the data role — the wrapped repo.
            expect(hasRepositoryRole({ kind: 'repo' }, 'data')).toBe(true);
            expect(hasRepositoryRole({ kind: 'repo' }, 'work')).toBe(false);
            expect(hasRepositoryRole({ kind: 'repo' }, 'website')).toBe(false);
            // Company / campaign shells have no website repo either.
            expect(hasRepositoryRole({ kind: 'company' }, 'website')).toBe(false);
            expect(hasRepositoryRole({ kind: 'company' }, 'work')).toBe(true);
            // Directory-shaped kinds (and the `default` installed base) keep all three.
            for (const kind of ['default', 'directory', 'awesome-repo', 'blog', 'website']) {
                expect(hasRepositoryRole({ kind }, 'data')).toBe(true);
                expect(hasRepositoryRole({ kind }, 'work')).toBe(true);
                expect(hasRepositoryRole({ kind }, 'website')).toBe(true);
            }
        });

        it('refuses a role the kind never provisions, naming the kind', () => {
            expect(() =>
                assertRepositoryRole({ kind: 'repo', name: 'Platform' }, 'website'),
            ).toThrow(BadRequestException);
            expect(() => assertRepositoryRole({ kind: 'repo', name: 'Platform' }, 'work')).toThrow(
                new RegExp(`${REPOSITORY_WORK_REFUSAL}.*work repository`),
            );
            expect(() =>
                assertRepositoryRole({ kind: 'company', name: 'Acme' }, 'website'),
            ).toThrow(/"company" Work and provisions no website repository/);
        });

        it('lets a provisioned role through', () => {
            expect(() => assertRepositoryRole({ kind: 'repo' }, 'data')).not.toThrow();
            expect(() => assertRepositoryRole({ kind: 'directory' }, 'website')).not.toThrow();
            expect(() => assertRepositoryRole({}, 'website')).not.toThrow();
        });
    });
});
