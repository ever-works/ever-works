import {
    WORK_COMMIT_LOCK_TIMEOUT_MESSAGE,
    WORK_COMMIT_LOCK_WAIT_MS,
    withWorkCommitLock,
    workCommitLockDepth,
} from './work-commit-lock';

/**
 * APW-08 T2 — the keyed commit lock (plan §2.2).
 *
 * The four cases the task names, plus three that pin the properties its prose states and a
 * caller could otherwise lose: a refusal never runs the work, a refusal does not block the
 * callers queued behind it, and the map keeps exactly one entry per Work while it is held.
 *
 * Every case uses its **own** Work id and releases its gate in a `finally`, so one failing
 * assertion cannot block the next case through a slot nobody releases.
 */
describe('withWorkCommitLock — APW-08 P0', () => {
    const workId = (suffix: string) => `work-commit-lock-spec-${suffix}`;

    afterEach(() => {
        // A leaked entry would make a later case wait on a promise nobody resolves.
        expect(workCommitLockDepth()).toBe(0);
    });

    it('runs two calls on ONE Work in call order, never interleaved (T2 case 1)', async () => {
        const id = workId('order');
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        let startedFirst!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            startedFirst = resolve;
        });

        const first = withWorkCommitLock(id, async () => {
            events.push('first:start');
            startedFirst();
            await firstGate;
            events.push('first:end');
            return 'first';
        });
        const second = withWorkCommitLock(id, async () => {
            events.push('second:start');
            return 'second';
        });

        try {
            // Wait for the first call to really be inside its work, then give the second every
            // chance to (wrongly) start: it must still not have.
            await firstStarted;
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(events).toEqual(['first:start']);
        } finally {
            releaseFirst();
        }

        await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('lets two calls on DIFFERENT Works run concurrently (T2 case 2)', async () => {
        const id = workId('concurrent');
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = withWorkCommitLock(id, async () => {
            events.push('a:start');
            await firstGate;
            events.push('a:end');
        });

        try {
            // The other Work's call resolves while the first is still holding its own slot: that
            // is the whole point of keying the lock by Work rather than serializing the process.
            await expect(
                withWorkCommitLock(workId('concurrent-other'), async () => {
                    events.push('b:start');
                    return 'b';
                }),
            ).resolves.toBe('b');
            expect(events).toEqual(['a:start', 'b:start']);
        } finally {
            releaseFirst();
        }

        await first;
        expect(events).toEqual(['a:start', 'b:start', 'a:end']);
    });

    it('refuses with the FR-6 copy once the wait elapses, and writes nothing (T2 case 3)', async () => {
        const id = workId('refusal');
        let releaseFirst!: () => void;
        const first = withWorkCommitLock(
            id,
            () =>
                new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                }),
        );

        const refused = jest.fn(async () => 'never runs');

        try {
            await expect(withWorkCommitLock(id, refused, 25)).rejects.toThrow(
                'Another commit to this Work is in progress.',
            );
            expect(refused).not.toHaveBeenCalled();
            expect(WORK_COMMIT_LOCK_TIMEOUT_MESSAGE).toBe(
                'Another commit to this Work is in progress.',
            );
        } finally {
            releaseFirst();
        }

        await first;
    });

    it('releases the slot when the work throws, so the next caller proceeds (T2 case 4)', async () => {
        const id = workId('throwing');

        await expect(
            withWorkCommitLock(id, async () => {
                throw new Error('commit failed');
            }),
        ).rejects.toThrow('commit failed');

        // The failure reaches only the caller that caused it: the next one is not poisoned.
        await expect(withWorkCommitLock(id, async () => 'next', 500)).resolves.toBe('next');
    });

    it('does not let a refusal block the callers queued behind it', async () => {
        const id = workId('refusal-then-queued');
        let releaseHolder!: () => void;
        const holder = withWorkCommitLock(
            id,
            () =>
                new Promise<void>((resolve) => {
                    releaseHolder = resolve;
                }),
        );

        // The queued caller must be registered WHILE the refusal is still waiting: it captures the
        // refused call's chain as its own `previous`, which is the only way a refusal that never
        // released its slot could hold it — a caller that arrives after the throw reads a chain
        // the refusal has already dropped from the map and would pass either way.
        const refused = withWorkCommitLock(id, async () => 'refused', 25);
        const queued = withWorkCommitLock(id, async () => 'queued', 1_000);

        await expect(refused).rejects.toThrow(WORK_COMMIT_LOCK_TIMEOUT_MESSAGE);

        releaseHolder();
        await holder;

        await expect(queued).resolves.toBe('queued');
    });

    it('holds one entry per Work while the work runs and drops it afterwards', async () => {
        const id = workId('depth');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const held = withWorkCommitLock(id, async () => {
            expect(workCommitLockDepth()).toBe(1);
            await gate;
        });

        release();
        await held;
        expect(workCommitLockDepth()).toBe(0);
    });

    it('waits the plan §2.2 budget by default', () => {
        expect(WORK_COMMIT_LOCK_WAIT_MS).toBe(120_000);
    });
});
