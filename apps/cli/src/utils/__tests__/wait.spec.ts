import { describe, it, expect, vi } from 'vitest';
import { wait } from '../wait';

describe('wait', () => {
    it('resolves after the specified number of milliseconds', async () => {
        vi.useFakeTimers();
        try {
            const promise = wait(500);
            let resolved = false;
            promise.then(() => {
                resolved = true;
            });

            // before time advance: still pending
            await Promise.resolve();
            expect(resolved).toBe(false);

            await vi.advanceTimersByTimeAsync(500);
            expect(resolved).toBe(true);
            await expect(promise).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves immediately for ms=0', async () => {
        vi.useFakeTimers();
        try {
            const promise = wait(0);
            await vi.advanceTimersByTimeAsync(0);
            await expect(promise).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns a Promise (not a sync value)', () => {
        // we don't await — just assert the shape
        const result = wait(0);
        expect(result).toBeInstanceOf(Promise);
    });
});
