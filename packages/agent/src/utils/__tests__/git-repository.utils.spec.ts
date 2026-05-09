import type { GitRepository } from '@ever-works/plugin';
import { assertCreatedRepositoryTarget } from '../git-repository.utils';

const makeRepo = (overrides: Partial<GitRepository> = {}): GitRepository =>
    ({
        owner: 'alice',
        name: 'my-app',
        fullName: 'alice/my-app',
        ...overrides,
    }) as GitRepository;

describe('assertCreatedRepositoryTarget', () => {
    it('returns the repo verbatim when owner and name both match', () => {
        const repo = makeRepo();
        expect(assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo')).toBe(repo);
    });

    it('throws an Error when owner mismatches expected', () => {
        const repo = makeRepo({ owner: 'bob', fullName: 'bob/my-app' });
        expect(() =>
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo'),
        ).toThrow(Error);
    });

    it('throws an Error when name mismatches expected', () => {
        const repo = makeRepo({ name: 'other-app', fullName: 'alice/other-app' });
        expect(() =>
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo'),
        ).toThrow(Error);
    });

    it('throws an Error when both owner and name mismatch', () => {
        const repo = makeRepo({ owner: 'bob', name: 'other', fullName: 'bob/other' });
        expect(() => assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Data repo')).toThrow(
            Error,
        );
    });

    it('error message contains the contextLabel verbatim', () => {
        const repo = makeRepo({ owner: 'bob', fullName: 'bob/my-app' });
        try {
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo');
            fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain('Website repo');
        }
    });

    it('error message includes the actual fullName from the createdRepository', () => {
        const repo = makeRepo({ owner: 'bob', fullName: 'bob/my-app' });
        try {
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo');
            fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain('bob/my-app');
        }
    });

    it('error message includes the expected "owner/name" form (not just owner or name)', () => {
        const repo = makeRepo({ owner: 'bob', fullName: 'bob/my-app' });
        try {
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo');
            fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain('alice/my-app');
        }
    });

    it('error message includes the user-facing diagnosis copy', () => {
        // Pinned literally because the final sentence is shown to operators when
        // a deploy lands in the wrong account; rewording it should be deliberate.
        const repo = makeRepo({ owner: 'bob', fullName: 'bob/my-app' });
        try {
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo');
            fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain(
                'This usually means the connected Git account does not match the work owner.',
            );
        }
    });

    it('does NOT trim or normalize owner/name (case-sensitive equality)', () => {
        // Pinned: GitHub treats 'Alice' and 'alice' as the same owner via case-
        // insensitive lookup, but the assertion here is strict equality. If a
        // future refactor decides to normalise case, it should be deliberate.
        const repo = makeRepo({ owner: 'Alice', fullName: 'Alice/my-app' });
        expect(() =>
            assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'Website repo'),
        ).toThrow(Error);
    });

    it('happy path returns the SAME object reference (no defensive copy)', () => {
        const repo = makeRepo();
        const result = assertCreatedRepositoryTarget(repo, 'alice', 'my-app', 'ctx');
        expect(result).toBe(repo); // toBe (identity), not toEqual
    });
});
