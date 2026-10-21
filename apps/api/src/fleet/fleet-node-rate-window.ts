/**
 * A per-key sliding window: at most `limit` hits per `windowMs` (CONTRACTS
 * §10.1 rates — "health refresh per node 10 per minute", "wake per node 3 per
 * 5 minutes").
 *
 * In-process: each API replica keeps its own window, so behind N replicas a
 * determined caller could reach N × the limit. The limits here protect a
 * machine from being hammered by one page or one script, which one replica's
 * window does; a fleet-wide counter would be the relay bus's job if that
 * ever matters. Memory stays bounded: an empty key is dropped, and the map is
 * swept when it grows past {@link MAX_KEYS}.
 */

const MAX_KEYS = 10_000;

export class FleetNodeRateWindow {
    private readonly hits = new Map<string, number[]>();

    constructor(
        readonly limit: number,
        readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** Record a hit and answer true, or answer false (nothing recorded) when the key is at its limit. */
    tryHit(key: string): boolean {
        const now = this.now();
        const recent = this.recent(key, now);
        if (recent.length >= this.limit) return false;
        recent.push(now);
        this.hits.set(key, recent);
        if (this.hits.size > MAX_KEYS) this.sweep(now);
        return true;
    }

    /** Hits left in the window for `key` (nothing recorded). */
    remaining(key: string): number {
        return Math.max(0, this.limit - this.recent(key, this.now()).length);
    }

    private recent(key: string, now: number): number[] {
        const kept = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
        if (kept.length === 0) this.hits.delete(key);
        return kept;
    }

    private sweep(now: number): void {
        for (const key of [...this.hits.keys()]) this.recent(key, now);
    }
}
