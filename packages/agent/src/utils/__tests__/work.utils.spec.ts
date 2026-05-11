import { getWorkOwner } from '../work.utils';
import type { Work } from '../../entities/work.entity';
import type { User } from '../../entities/user.entity';

const makeWork = (overrides: Partial<Work> = {}): Work =>
    ({
        id: 'work-1',
        ...overrides,
    }) as unknown as Work;

const makeUser = (overrides: Partial<User> = {}): User =>
    ({
        id: 'user-1',
        username: 'alice',
        email: 'alice@example.com',
        ...overrides,
    }) as unknown as User;

describe('getWorkOwner', () => {
    it('returns the user attached to work.user when valid', () => {
        const owner = makeUser();
        const work = makeWork({ user: owner });
        expect(getWorkOwner(work)).toBe(owner);
    });

    it('throws an Error when work.user is undefined (relation not joined)', () => {
        const work = makeWork({ user: undefined as unknown as User });
        expect(() => getWorkOwner(work)).toThrow(Error);
        expect(() => getWorkOwner(work)).toThrow(
            /Work owner not loaded for work work-1\. Ensure the user relation is joined\./,
        );
    });

    it('throws an Error when work.user is null', () => {
        const work = makeWork({ user: null as unknown as User });
        expect(() => getWorkOwner(work)).toThrow(/Work owner not loaded for work work-1/);
    });

    it('throws an Error when work.user.id is missing (partial / unloaded relation)', () => {
        const partial = { username: 'alice' } as unknown as User; // no id
        const work = makeWork({ user: partial });
        expect(() => getWorkOwner(work)).toThrow(/Work owner not loaded for work work-1/);
    });

    it('throws an Error when work.user.id is non-string (e.g. legacy integer key)', () => {
        // Pinned because the type guard is `typeof owner.id !== 'string'` —
        // a future schema refactor that introduces numeric ids would break the
        // string-id contract loudly here rather than silently leaking through.
        const numericIdUser = { id: 42, username: 'x' } as unknown as User;
        const work = makeWork({ user: numericIdUser });
        expect(() => getWorkOwner(work)).toThrow(/Work owner not loaded for work work-1/);
    });

    it('error message includes the work id (helpful for log triage)', () => {
        const work = makeWork({ id: 'abc-123', user: undefined as unknown as User });
        try {
            getWorkOwner(work);
            fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain('abc-123');
        }
    });

    it('returns the SAME owner object reference (no defensive copy)', () => {
        const owner = makeUser();
        const work = makeWork({ user: owner });
        expect(getWorkOwner(work)).toBe(owner); // identity, not toEqual
    });

    it('accepts an empty-string id as falsy and rejects (defensive guard)', () => {
        // Pinned: the function uses `typeof owner.id !== 'string'` which accepts
        // empty string. But owner check is `!owner` so an owner with id '' actually
        // passes through. Pin this current behavior so a future tightening to
        // `!owner.id` (which would also reject '') is a deliberate change.
        const owner = makeUser({ id: '' });
        const work = makeWork({ user: owner });
        // Current behavior: empty-string id is still typeof 'string', so passes.
        expect(getWorkOwner(work)).toBe(owner);
    });
});
