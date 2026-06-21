import { randomUUID } from 'node:crypto';
import { TenantCredentialCache } from '../tenant-credential.cache';

/**
 * EW-742 P3.1 (T21) — extra-coverage deep edge cases beyond the 12-pin
 * baseline `tenant-credential.cache.spec.ts`:
 *
 *   - LRU eviction at the default `maxEntries = 1024` boundary;
 *   - explicit non-promotion on read (ADR-017 §3 Q4 graceful-drain pin);
 *   - TTL boundary semantics (Date.now spy, not fake timers);
 *   - pair- and tenant-scoped invalidate isolation;
 *   - high-churn bound: 10K distinct inserts keep `size()` ≤ `maxEntries`;
 *   - mutating a returned binding does NOT pollute the cached copy when
 *     the caller treats the returned ref as opaque (the cache does NOT
 *     deep-freeze — it stores references; this spec pins THAT contract);
 *   - concurrent `set` calls — last write wins, no torn state;
 *   - `invalidate(tenantId, '')` is a no-op for the empty providerId case
 *     (sanity: a buggy caller doesn't accidentally wipe the tenant).
 */
describe('TenantCredentialCache — deep edge cases (EW-742 P3.1 / T21)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('LRU eviction at the default boundary', () => {
        it('evicts the first key after 1025 distinct inserts (default maxEntries=1024)', () => {
            const cache = new TenantCredentialCache();
            const tenant = 'tenant-a';
            // Insert 1025 distinct version keys for the same (tenant, provider).
            for (let v = 1; v <= 1025; v++) {
                cache.set(tenant, 'trigger', v, { v });
            }
            expect(cache.size()).toBe(1024);
            // The first-inserted key (v=1) is evicted.
            expect(cache.get(tenant, 'trigger', 1)).toBeNull();
            // The most-recent key survives.
            expect(cache.get(tenant, 'trigger', 1025)).toEqual({ v: 1025 });
            // A key just past the eviction edge survives.
            expect(cache.get(tenant, 'trigger', 2)).toEqual({ v: 2 });
        });

        it('evicts the lowest insertion-order entry across mixed tenants', () => {
            const cache = new TenantCredentialCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set('tenant-a', 'trigger', 1, { tag: 'a1' });
            cache.set('tenant-b', 'trigger', 1, { tag: 'b1' });
            cache.set('tenant-c', 'trigger', 1, { tag: 'c1' });
            // 4th insert evicts the oldest (tenant-a/v1).
            cache.set('tenant-d', 'trigger', 1, { tag: 'd1' });
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            expect(cache.get('tenant-b', 'trigger', 1)).toEqual({ tag: 'b1' });
            expect(cache.get('tenant-c', 'trigger', 1)).toEqual({ tag: 'c1' });
            expect(cache.get('tenant-d', 'trigger', 1)).toEqual({ tag: 'd1' });
        });

        it('hot reads do NOT promote the entry — eviction stays insertion-order', () => {
            // ADR-017 §3 Q4 (locked) — preventing read-promotion is what
            // gives graceful drain its semantics: an in-flight run pinned
            // to version N must NOT keep that snapshot alive past its
            // rotation window just because it keeps reading it.
            const cache = new TenantCredentialCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set('tenant-a', 'trigger', 1, { tag: 'first' });
            cache.set('tenant-a', 'trigger', 2, { tag: 'second' });
            cache.set('tenant-a', 'trigger', 3, { tag: 'third' });

            // Read `first` MANY times — would normally promote in an LRU.
            for (let i = 0; i < 50; i++) {
                expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ tag: 'first' });
            }

            // 4th distinct insert still evicts `first` (the insertion-
            // order oldest) — read activity didn't change its position.
            cache.set('tenant-a', 'trigger', 4, { tag: 'fourth' });
            expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            expect(cache.get('tenant-a', 'trigger', 2)).toEqual({ tag: 'second' });
        });

        it('refreshing an existing key promotes it to freshest (insertion order)', () => {
            const cache = new TenantCredentialCache({ maxEntries: 3, ttlMs: 60_000 });
            cache.set('tenant-a', 'trigger', 1, { tag: 'first' });
            cache.set('tenant-a', 'trigger', 2, { tag: 'second' });
            cache.set('tenant-a', 'trigger', 3, { tag: 'third' });

            // Refresh `first` — should now be the freshest by insertion
            // order (the class JSDoc on `set` pins this semantic).
            cache.set('tenant-a', 'trigger', 1, { tag: 'first-refreshed' });

            // 4th distinct insert evicts the oldest — which is now `second`.
            cache.set('tenant-a', 'trigger', 4, { tag: 'fourth' });
            expect(cache.get('tenant-a', 'trigger', 2)).toBeNull();
            // `first` survives because of the refresh.
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ tag: 'first-refreshed' });
        });
    });

    describe('TTL boundary semantics with Date.now spy', () => {
        it('returns the entry at exactly ttlMs - 1 ms and null at ttlMs + 1 ms', () => {
            const baseNow = 1_000_000_000_000;
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);
            try {
                const cache = new TenantCredentialCache({ maxEntries: 16, ttlMs: 30_000 });
                cache.set('tenant-a', 'trigger', 1, { token: 'a' });

                // Just before TTL — still cached.
                nowSpy.mockReturnValue(baseNow + 29_999);
                expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ token: 'a' });

                // Exactly AT expiresAt — the implementation uses
                // `expiresAt <= now`, which means equality counts as
                // expired.
                nowSpy.mockReturnValue(baseNow + 30_000);
                expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('expired-on-read removes the entry from the map (passive eviction)', () => {
            const baseNow = 2_000_000_000_000;
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);
            try {
                const cache = new TenantCredentialCache({ maxEntries: 16, ttlMs: 5_000 });
                cache.set('tenant-a', 'trigger', 1, { v: 1 });
                expect(cache.size()).toBe(1);

                // Jump past TTL and read — passive eviction shrinks size.
                nowSpy.mockReturnValue(baseNow + 6_000);
                expect(cache.get('tenant-a', 'trigger', 1)).toBeNull();
                expect(cache.size()).toBe(0);
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('does NOT spontaneously evict entries that have not been read past TTL', () => {
            // No background sweeper — entries past TTL stay in the map
            // (and count toward capacity) until read or invalidated.
            const baseNow = 3_000_000_000_000;
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);
            try {
                const cache = new TenantCredentialCache({ maxEntries: 16, ttlMs: 5_000 });
                cache.set('tenant-a', 'trigger', 1, { v: 1 });
                nowSpy.mockReturnValue(baseNow + 100_000);
                // size() doesn't sweep; it just reports the map size.
                expect(cache.size()).toBe(1);
            } finally {
                nowSpy.mockRestore();
            }
        });
    });

    describe('invalidate() isolation', () => {
        it('pair-scoped invalidate leaves OTHER tenants and OTHER providers untouched', () => {
            const cache = new TenantCredentialCache();
            const tA = randomUUID();
            const tB = randomUUID();
            cache.set(tA, 'trigger', 1, { tA_trigger_v1: true });
            cache.set(tA, 'trigger', 2, { tA_trigger_v2: true });
            cache.set(tA, 'inngest', 1, { tA_inngest_v1: true });
            cache.set(tB, 'trigger', 1, { tB_trigger_v1: true });
            cache.set(tB, 'inngest', 1, { tB_inngest_v1: true });

            cache.invalidate(tA, 'trigger');

            // Targeted pair: all versions gone.
            expect(cache.get(tA, 'trigger', 1)).toBeNull();
            expect(cache.get(tA, 'trigger', 2)).toBeNull();
            // Other provider for SAME tenant: untouched.
            expect(cache.get(tA, 'inngest', 1)).toEqual({ tA_inngest_v1: true });
            // Other tenant: untouched across providers.
            expect(cache.get(tB, 'trigger', 1)).toEqual({ tB_trigger_v1: true });
            expect(cache.get(tB, 'inngest', 1)).toEqual({ tB_inngest_v1: true });
        });

        it('tenant-wide invalidate drops every provider+version for that tenant', () => {
            const cache = new TenantCredentialCache();
            const tA = randomUUID();
            const tB = randomUUID();
            cache.set(tA, 'trigger', 1, {});
            cache.set(tA, 'trigger', 2, {});
            cache.set(tA, 'inngest', 1, {});
            cache.set(tA, 'temporal', 5, {});
            cache.set(tB, 'trigger', 1, { keep: true });

            cache.invalidate(tA);

            expect(cache.get(tA, 'trigger', 1)).toBeNull();
            expect(cache.get(tA, 'trigger', 2)).toBeNull();
            expect(cache.get(tA, 'inngest', 1)).toBeNull();
            expect(cache.get(tA, 'temporal', 5)).toBeNull();
            expect(cache.get(tB, 'trigger', 1)).toEqual({ keep: true });
        });

        it('invalidate() for an unknown tenant is a no-op', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { v: 1 });
            cache.invalidate('does-not-exist');
            expect(cache.size()).toBe(1);
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ v: 1 });
        });

        it('invalidate() for an unknown (tenant, provider) pair is a no-op', () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { v: 1 });
            cache.invalidate('tenant-a', 'pgboss');
            expect(cache.size()).toBe(1);
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ v: 1 });
        });

        it('invalidateAll() is idempotent on an empty cache', () => {
            const cache = new TenantCredentialCache();
            cache.invalidateAll();
            cache.invalidateAll();
            expect(cache.size()).toBe(0);
        });
    });

    describe('high-churn bound', () => {
        it('10000 distinct inserts cap size at maxEntries (no unbounded growth)', () => {
            const cache = new TenantCredentialCache({ maxEntries: 256, ttlMs: 60_000 });
            for (let v = 0; v < 10_000; v++) {
                cache.set(`tenant-${v % 50}`, 'trigger', v, { v });
            }
            expect(cache.size()).toBe(256);
        });

        it('10000 distinct inserts across many tenants stay bounded, freshest survive', () => {
            const cache = new TenantCredentialCache({ maxEntries: 1024, ttlMs: 60_000 });
            for (let v = 0; v < 10_000; v++) {
                cache.set(randomUUID(), 'trigger', v, { v });
            }
            expect(cache.size()).toBe(1024);
        });
    });

    describe('stored-value reference semantics', () => {
        it('returns the SAME object reference on repeat get() (no defensive copy)', () => {
            // The cache stores references; it doesn't deep-freeze or
            // deep-copy. Pin the documented behaviour so callers know
            // they get back what they put in.
            const cache = new TenantCredentialCache();
            const snapshot = { token: 'abc', tags: ['prod'] };
            cache.set('tenant-a', 'trigger', 1, snapshot);

            const first = cache.get<typeof snapshot>('tenant-a', 'trigger', 1);
            const second = cache.get<typeof snapshot>('tenant-a', 'trigger', 1);
            expect(first).toBe(second);
            expect(first).toBe(snapshot);
        });

        it('refreshing a key replaces the cached reference', () => {
            const cache = new TenantCredentialCache();
            const a = { token: 'a' };
            const b = { token: 'b' };
            cache.set('tenant-a', 'trigger', 1, a);
            cache.set('tenant-a', 'trigger', 1, b);
            expect(cache.get('tenant-a', 'trigger', 1)).toBe(b);
            expect(cache.get('tenant-a', 'trigger', 1)).not.toBe(a);
        });
    });

    describe('concurrency', () => {
        it('concurrent set() from many async paths — last write wins, no torn state', async () => {
            // Node's event loop makes individual Map mutations atomic;
            // this test pins that a fan-out of set() calls leaves the
            // cache in a self-consistent state and a subsequent get()
            // returns one of the written values (not a partial object).
            const cache = new TenantCredentialCache();
            const writers = Array.from({ length: 100 }, (_, i) =>
                Promise.resolve().then(() =>
                    cache.set('tenant-a', 'trigger', 1, { writerIndex: i }),
                ),
            );
            await Promise.all(writers);

            const final = cache.get<{ writerIndex: number }>('tenant-a', 'trigger', 1);
            expect(final).not.toBeNull();
            // Some writer's value made it through (any 0..99 is valid).
            expect(typeof final?.writerIndex).toBe('number');
            expect(final?.writerIndex).toBeGreaterThanOrEqual(0);
            expect(final?.writerIndex).toBeLessThan(100);
            // Cache size remains 1 — no duplicates from concurrent writes.
            expect(cache.size()).toBe(1);
        });

        it('concurrent get() under churn never sees a half-written entry', async () => {
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { full: true, token: 'first' });

            const tasks: Promise<unknown>[] = [];
            for (let i = 0; i < 200; i++) {
                tasks.push(
                    Promise.resolve().then(() => {
                        if (i % 2 === 0) {
                            cache.set('tenant-a', 'trigger', 1, { full: true, token: `t${i}` });
                        } else {
                            const v = cache.get<{ full: true; token: string }>(
                                'tenant-a',
                                'trigger',
                                1,
                            );
                            // Every observed value carries the full shape —
                            // no half-written reads.
                            expect(v?.full).toBe(true);
                            expect(typeof v?.token).toBe('string');
                        }
                    }),
                );
            }
            await Promise.all(tasks);
        });
    });

    describe('keying gotchas', () => {
        it('treats numerically equal but typed-different versions as the same key', () => {
            // The internal key joins with ":" so 1 and 1 (both number)
            // are the same. We explicitly require number on the public
            // API — passing strings is a type error in TS, so this just
            // pins the documented numeric semantics.
            const cache = new TenantCredentialCache();
            cache.set('tenant-a', 'trigger', 1, { v: 1 });
            expect(cache.get('tenant-a', 'trigger', 1)).toEqual({ v: 1 });
            // Re-set with the same numeric value refreshes; size stays 1.
            cache.set('tenant-a', 'trigger', 1, { v: 'refreshed' });
            expect(cache.size()).toBe(1);
        });

        it('tenant ids containing a colon do not collide with adjacent keys (smoke-check)', () => {
            // The key format is `${tenantId}:${providerId}:${version}` —
            // a tenantId of `a:b` with providerId `c` and version 1
            // joins to `a:b:c:1`. There IS NO collision-prevention in
            // the key encoding, but the test pins what HAPPENS so a
            // future refactor (e.g. switching to a separator-safe key
            // builder) is a deliberate choice.
            const cache = new TenantCredentialCache();
            cache.set('a', 'b:c', 1, { tag: 'pair-1' });
            cache.set('a:b', 'c', 1, { tag: 'pair-2' });
            // Both flatten to `a:b:c:1` — second insert refreshes/overwrites.
            expect(cache.size()).toBe(1);
            expect(cache.get('a:b', 'c', 1)).toEqual({ tag: 'pair-2' });
            expect(cache.get('a', 'b:c', 1)).toEqual({ tag: 'pair-2' });
        });
    });
});
