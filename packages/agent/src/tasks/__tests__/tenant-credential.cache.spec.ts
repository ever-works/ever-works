import { TenantCredentialCache } from '../tenant-credential.cache';

/**
 * EW-742 P3.1 (T21) — TenantCredentialCache unit tests.
 *
 * Pins the 12 invariants the P3 resolver (#1380, follow-up) and the
 * P4 worker host will rely on:
 *   1. Empty-cache get → null.
 *   2. Round-trip set/get returns the value.
 *   3. Version mismatch is a miss (credential snapshot pinning per
 *      ADR-017 §3 / Q4 — an in-flight run pinned to version N must NOT
 *      pick up version M's snapshot).
 *   4–5. Cross-tenant / cross-provider isolation.
 *   6. TTL expiry — value disappears after `ttlMs` even without
 *      explicit invalidation.
 *   7. TTL refresh — a fresh `set()` on the same key resets the
 *      expiry deadline (refresh = freshest).
 *   8. Tenant-wide invalidate drops every entry across providers + versions.
 *   9. Pair-scoped invalidate drops only that `(tenantId, providerId)`
 *      pair across all versions, leaves other pairs untouched.
 *  10. `invalidateAll()` wipes everything.
 *  11. Insertion-order LRU eviction at capacity — the oldest entry by
 *      insertion order is dropped (NOT the least-recently-read; read
 *      promotion would break graceful drain).
 *  12. `size()` tracks current entry count through inserts, evictions,
 *      and invalidations.
 */
describe('TenantCredentialCache (EW-742 P3.1 / T21)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    describe('get() / set() basics', () => {
        it('returns null on an empty cache', () => {
            const cache = new TenantCredentialCache();
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
        });

        it('round-trips a value through set() → get() with the same key', () => {
            const cache = new TenantCredentialCache();
            const snapshot = { secretRef: 'kv://tenant-a/trigger/v1', token: 'abc' };
            cache.set('tenant-a', 'trigger', 1, snapshot);
            expect(cache.get('tenant-a', 'trigger', 1)).toBe(snapshot);
        });

        it('treats a different credentialVersion as a miss (snapshot pinning)', () => {
            // Per ADR-017 §3 / Q4: an in-flight run pinned to v1 MUST NOT
            // pick up v2's snapshot. Version is part of the cache key.
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { v: 1 });
            expect(cache.get('tenant-a', 'trigger', 2)).toBeNull();
            // The original v1 entry is still there — version-mismatch
            // reads don't disturb other versions in the cache.
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ v: 1 });
        });

        it('treats a different tenantId as a miss (cross-tenant isolation)', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { token: 'a' });
            expect(cache.get('tenant-b', 'trigger', 1)).toBeNull();
        });

        it('treats a different providerId as a miss', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { token: 'a' });
            expect(cache.get('tenant-a', 'inngest', 1)).toBeNull();
        });
    });

    describe('TTL expiry', () => {
        it('returns null after ttlMs elapses without invalidation', () => {
            jest.useFakeTimers();
            const cache = new TenantCredentialCache({ maxEntries: 1024, ttlMs: 30_000 });
            cache.set('tenant-a', 'trigger', 1, { token: 'a' });
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ token: 'a' });

            // Just before the deadline — still alive.
            jest.advanceTimersByTime(29_999);
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ token: 'a' });

            // Step past the deadline (boundary is `expiresAt <= now`).
            jest.advanceTimersByTime(2);
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
        });

        it('a fresh set() refreshes the TTL deadline', () => {
            jest.useFakeTimers();
            const cache = new TenantCredentialCache({ maxEntries: 1024, ttlMs: 30_000 });
            cache.set('tenant-a', 'trigger', 1, { token: 'first' });

            // 20s in — still alive, refresh with a new value.
            jest.advanceTimersByTime(20_000);
            cache.set('tenant-a', 'trigger', 1, { token: 'second' });

            // 20s more (40s total since first insert, 20s since refresh).
            // Without the refresh the entry would already be expired;
            // with the refresh it's only 20s old → still alive, and the
            // value should be the refreshed one.
            jest.advanceTimersByTime(20_000);
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ token: 'second' });
        });
    });

    describe('invalidate()', () => {
        it('tenant-wide invalidate drops every entry for that tenant across providers + versions', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { token: 'a-trigger-v1' });
            cache.set('tenant-a', 'trigger', 2, { token: 'a-trigger-v2' });
            cache.set('tenant-a', 'inngest', 1, { token: 'a-inngest-v1' });
            cache.set('tenant-b', 'trigger', 1, { token: 'b-trigger-v1' });

            cache.invalidate('tenant-a');

            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            expect(cache.get('tenant-a', 'trigger', 2)).toBeNull();
            expect(cache.get('tenant-a', 'inngest', 1)).toBeNull();
            // Other tenant untouched.
            expect(cache.get('tenant-b', 'trigger', 1)).toEqual({ token: 'b-trigger-v1' });
        });

        it('pair-scoped invalidate drops only that (tenant, provider) across all versions', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { token: 'a-trigger-v1' });
            cache.set('tenant-a', 'trigger', 2, { token: 'a-trigger-v2' });
            cache.set('tenant-a', 'inngest', 1, { token: 'a-inngest-v1' });
            cache.set('tenant-b', 'trigger', 1, { token: 'b-trigger-v1' });

            cache.invalidate('tenant-a', 'trigger');

            // Both versions for the targeted pair are gone.
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            expect(cache.get('tenant-a', 'trigger', 2)).toBeNull();
            // Other provider for same tenant survives.
            expect(cache.get('tenant-a', 'inngest', 1)).toEqual({ token: 'a-inngest-v1' });
            // Other tenant untouched.
            expect(cache.get('tenant-b', 'trigger', 1)).toEqual({ token: 'b-trigger-v1' });
        });

        it('invalidateAll() wipes the cache', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { token: 'a' });
            cache.set('tenant-b', 'inngest', 5, { token: 'b' });
            expect(cache.size()).toBe(2);

            cache.invalidateAll();

            expect(cache.size()).toBe(0);
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            expect(cache.get('tenant-b', 'inngest', 5)).toBeNull();
        });
    });

    describe('LRU eviction at capacity', () => {
        it('evicts the oldest-by-insertion-order entry when at maxEntries', () => {
            const cache = new TenantCredentialCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set('tenant-a', 'trigger', 1, { tag: 'first' });
            cache.set('tenant-a', 'trigger', 2, { tag: 'second' });
            cache.set('tenant-a', 'trigger', 3, { tag: 'third' });
            expect(cache.size()).toBe(3);

            // Reading `first` does NOT promote it — eviction is strictly
            // insertion-order to preserve the graceful-drain semantic.
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ tag: 'first' });

            cache.set('tenant-a', 'trigger', 4, { tag: 'fourth' });

            expect(cache.size()).toBe(3);
            // `first` was inserted earliest → evicted.
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            // Others survive.
            expect(cache.get('tenant-a', 'trigger', 2)).toEqual({ tag: 'second' });
            expect(cache.get('tenant-a', 'trigger', 3)).toEqual({ tag: 'third' });
            expect(cache.get('tenant-a', 'trigger', 4)).toEqual({ tag: 'fourth' });
        });
    });

    describe('size()', () => {
        it('reflects entry count through inserts, evictions, and invalidations', () => {
            const cache = new TenantCredentialCache({ maxEntries: 3, ttlMs: 60_000 });
            expect(cache.size()).toBe(0);

            cache.set('tenant-a', 'trigger', 1, { v: 1 });
            cache.set('tenant-a', 'trigger', 2, { v: 2 });
            expect(cache.size()).toBe(2);

            // Refresh of an existing key — count unchanged.
            cache.set('tenant-a', 'trigger', 1, { v: 1, refreshed: true });
            expect(cache.size()).toBe(2);

            // Fill to capacity then push past — eviction keeps size at 3.
            cache.set('tenant-a', 'trigger', 3, { v: 3 });
            cache.set('tenant-a', 'trigger', 4, { v: 4 });
            expect(cache.size()).toBe(3);

            // Pair-scoped invalidate drops all 3 (same pair, different versions).
            cache.invalidate('tenant-a', 'trigger');
            expect(cache.size()).toBe(0);
        });
    });
});
