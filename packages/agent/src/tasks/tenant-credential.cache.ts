import { Injectable } from '@nestjs/common';

/**
 * EW-742 P3.1 (T21) — in-process credential snapshot cache for the
 * tenant-aware dispatcher resolver (P3) and the future per-tenant worker
 * host (P4).
 *
 * Spec: [`tasks.md` T21](../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 * — "Credential cache with 15–60s TTL ... keyed by `(tenantId, providerId,
 * credentialVersion)`, in-process LRU with explicit invalidate on version
 * bump or force-invalidate."
 *
 * ## Why this is intentionally simple
 *
 * - **No LRU promotion-on-read.** Eviction is strictly insertion-order:
 *   the oldest entry by insert time is dropped when the cache is at
 *   capacity, regardless of how often it was read. Promoting on read
 *   would defeat the graceful-drain semantics from
 *   [ADR-017 §3](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen)
 *   (Q4): an in-flight run pinned to `credentialVersion = N` must see
 *   THAT snapshot for the run's lifetime; touching a read shouldn't keep
 *   an older snapshot alive past its rotation window. The TTL is the
 *   primary recency mechanism — readers always re-check freshness via
 *   `expiresAt`, and version bumps invalidate explicitly via
 *   {@link TenantCredentialCache.invalidate}.
 *
 * - **No DI dependencies.** The cache is a dumb in-memory bag; it does
 *   not own credential resolution, persistence, or rotation. Callers
 *   (the P3 resolver, the P4 worker host) own those concerns and
 *   layer this cache on top.
 *
 * - **No hot config reload.** `maxEntries` and `ttlMs` are read once at
 *   construction. Operators flipping the knobs require a process restart;
 *   that's deliberate — these values are sized for hosting capacity, not
 *   tuned at runtime.
 *
 * ## Invalidation semantics
 *
 * - **Version bump (rotation):** the caller bumps
 *   `tenant_job_runtime_config.credentialVersion` via
 *   {@link import('./credential-version.service').CredentialVersionService.bumpVersion},
 *   then invalidates the `(tenantId, providerId)` pair here BEFORE
 *   `set()`-ing the new version's snapshot. The cache holds entries for
 *   every version it has ever seen for that pair, so wiping the pair
 *   ensures no stale snapshot lingers under the old version key.
 *
 * - **Force-invalidate:** the caller invalidates the
 *   `(tenantId, providerId)` pair AND signals worker hosts to drop
 *   in-flight runs. The worker-host kill is P4 scope — this cache's job
 *   is only to ensure the next `get()` for that pair misses, so the
 *   resolver re-reads from `CredentialVersionService.resolveSnapshot()`.
 *
 * ## Concurrency
 *
 * Node's event loop is single-threaded; `Map` mutations between awaits
 * are atomic from the JS-engine's perspective. The cache is safe to
 * share across concurrent dispatcher calls without external locking.
 */
@Injectable()
export class TenantCredentialCache {
    private readonly maxEntries: number;
    private readonly ttlMs: number;

    private readonly entries = new Map<string, CacheEntry>();
    private insertCounter = 0;

    /**
     * @param maxEntries maximum number of `(tenantId, providerId, version)`
     *   snapshots held in memory before the oldest-by-insertion-order
     *   entry is evicted. Default `1024` — sized for a small fleet of
     *   tenants × providers × a handful of in-flight rotation snapshots
     *   per pair.
     * @param ttlMs entry lifetime in milliseconds. Default `30_000` (30s),
     *   sitting in the middle of the spec's 15–60s band. After the TTL
     *   elapses, {@link get} returns `null` even if the entry is still
     *   in the map; the entry is removed on the next access.
     */
    constructor(maxEntries: number = 1024, ttlMs: number = 30_000) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
    }

    /**
     * Returns the cached snapshot for the exact `(tenantId, providerId,
     * credentialVersion)` tuple, or `null` if there is no entry or the
     * entry has expired.
     *
     * Expired entries are removed on access (passive eviction) — there is
     * no background sweeper.
     */
    get<T>(tenantId: string, providerId: string, credentialVersion: number): T | null {
        const key = this.keyOf(tenantId, providerId, credentialVersion);
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return null;
        }
        return entry.value as T;
    }

    /**
     * Inserts or refreshes the snapshot for `(tenantId, providerId,
     * credentialVersion)`. Refresh resets both the TTL deadline AND the
     * insertion order — i.e. an updated entry becomes the freshest by
     * insertion order, not the original insert position. This matches the
     * intuition that "the operator just rewrote this credential" should
     * keep it alive over an older, untouched entry.
     *
     * When the cache is at `maxEntries`, the lowest-`insertedOrder` entry
     * is evicted to make room. Eviction picks the oldest by insertion
     * order regardless of TTL — an expired entry that hasn't been touched
     * yet still counts toward capacity until it's passively evicted.
     */
    set<T>(tenantId: string, providerId: string, credentialVersion: number, value: T): void {
        const key = this.keyOf(tenantId, providerId, credentialVersion);
        // If we already hold this key, delete it first so the re-insert
        // updates the insertion-order counter (the Map's own insertion
        // order would otherwise pin the entry to its original slot, which
        // is wrong for the "refresh = freshest" semantic above).
        if (this.entries.has(key)) {
            this.entries.delete(key);
        } else if (this.entries.size >= this.maxEntries) {
            this.evictOldest();
        }
        this.entries.set(key, {
            value,
            expiresAt: this.now() + this.ttlMs,
            insertedOrder: ++this.insertCounter,
        });
    }

    /**
     * Drops every entry matching the tenant. When `providerId` is given,
     * only entries for that `(tenantId, providerId)` pair are removed —
     * across ALL `credentialVersion` values, because a version bump
     * shouldn't leave stale snapshots under prior versions either. When
     * `providerId` is omitted, every entry for the tenant is removed
     * regardless of provider.
     *
     * Call this on:
     *   - credential rotation (after `CredentialVersionService.bumpVersion`)
     *   - force-invalidate (operator-initiated)
     *   - provider switch (tenant flips from `byo` to `inherit` or vice versa)
     */
    invalidate(tenantId: string, providerId?: string): void {
        const tenantPrefix = `${tenantId}:`;
        const pairPrefix = providerId !== undefined ? `${tenantId}:${providerId}:` : null;
        for (const key of this.entries.keys()) {
            if (!key.startsWith(tenantPrefix)) {
                continue;
            }
            if (pairPrefix === null || key.startsWith(pairPrefix)) {
                this.entries.delete(key);
            }
        }
    }

    /**
     * Wipes every entry across every tenant. Test/admin escape hatch —
     * production callers should prefer the scoped {@link invalidate}.
     */
    invalidateAll(): void {
        this.entries.clear();
    }

    /**
     * Current entry count. Used by tests and reserved for future
     * observability (gauge metric).
     */
    size(): number {
        return this.entries.size;
    }

    private keyOf(tenantId: string, providerId: string, credentialVersion: number): string {
        return `${tenantId}:${providerId}:${credentialVersion}`;
    }

    /**
     * `Date.now()` wrapper so tests can override (`jest.useFakeTimers()`
     * advances `Date.now` automatically; subclasses can patch this method
     * if a future test harness needs a different clock source).
     */
    private now(): number {
        return Date.now();
    }

    private evictOldest(): void {
        let oldestKey: string | null = null;
        let oldestOrder = Number.POSITIVE_INFINITY;
        for (const [key, entry] of this.entries) {
            if (entry.insertedOrder < oldestOrder) {
                oldestOrder = entry.insertedOrder;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) {
            this.entries.delete(oldestKey);
        }
    }
}

interface CacheEntry {
    value: unknown;
    expiresAt: number;
    insertedOrder: number;
}

// TODO(EW-742 P3): wire this cache into `TenantAwareRuntimeResolver`
// (the P3 resolver introduced alongside #1380) and into the per-tenant
// worker host (P4 — T25–T32). The cache class is shipped here as a
// standalone unit so both consumers can layer it in without coupling
// either PR to the other:
//   - P3 (#1380, may not yet be on develop) — resolver calls
//     `cache.get(tenantId, providerId, version)` on the hot path and
//     falls back to `CredentialVersionService.resolveSnapshot()` on a
//     miss, then `cache.set(...)`s the result.
//   - P4 — worker host calls `cache.invalidate(tenantId, providerId)`
//     when the operator force-invalidates a credential, alongside the
//     in-flight-run kill that lives in the worker host itself.
