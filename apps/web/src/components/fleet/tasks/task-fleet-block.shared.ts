/**
 * Tasks on computers (FL-15 P1) — how long ago, as the Computer block reads
 * it ("2 h", "4 min", "3 d"); null for a time it cannot read. Pure, so the
 * block's states are testable without a clock.
 */
export function taskComputerAgo(at: string, now: number): string | null {
    const then = Date.parse(at);
    if (!Number.isFinite(then)) return null;
    const minutes = Math.max(0, Math.round((now - then) / 60_000));
    if (minutes < 1) return '< 1 min';
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}
