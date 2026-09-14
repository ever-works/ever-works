/** Upper bound on cached summaries held by one process. */
export const HOME_SUMMARY_CACHE_MAX_ENTRIES = 1000;

/**
 * Home (AW-19) — a tiny per-process TTL cache for composed summaries.
 *
 * Deliberately in memory rather than the shared cache backend: it only has
 * to collapse a burst of identical reads (a server render followed by an
 * immediate refresh, several tabs) for ten seconds, per-pod drift inside
 * that window is harmless, and a shared backend would turn every Home read
 * into a write of the user's decisions and spend into a table.
 */
export class HomeSummaryCache<T> {
    private readonly entries = new Map<string, { expiresAt: number; value: T }>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries = HOME_SUMMARY_CACHE_MAX_ENTRIES,
        private readonly clock: () => number = () => Date.now(),
    ) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.clock()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        if (this.entries.size >= this.maxEntries) {
            // Maps iterate in insertion order: the first key is the oldest write.
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
        this.entries.set(key, { expiresAt: this.clock() + this.ttlMs, value });
    }

    get size(): number {
        return this.entries.size;
    }
}
