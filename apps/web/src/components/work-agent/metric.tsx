/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx for reuse
 * by the Mission detail page's per-Mission counters (Phase 6 PR
 * R) and the Dashboard Missions preview block (Phase 6 PR S).
 * Byte-identical to the inline definition.
 */
export function Metric({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-lg border border-border/60 dark:border-border-dark/60 p-2">
            <div className="text-[11px] text-text-muted dark:text-text-muted-dark">{label}</div>
            <div className="text-sm font-semibold text-text dark:text-text-dark">{value}</div>
        </div>
    );
}
