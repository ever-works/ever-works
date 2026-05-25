/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx. Used by
 * the guardrails grid and (Phase 4 PR L) the four promoted
 * constant rows (autoGenerateCadence, autoGenerateBatchSize,
 * autoBuildThrottlePerDay, missionDefaultOutstandingCap). Output
 * byte-identical to the inline definition for integer use; the
 * optional `step` prop (Phase 4 PR EE) lights up decimal entry
 * for `exponentialBackoffFactor` without changing any existing
 * caller's render (default omits the attribute entirely so the
 * browser keeps its prior integer-step behavior).
 */
export function NumberField({
    label,
    value,
    min,
    max,
    step,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="space-y-1.5">
            <span className="text-xs text-text-muted dark:text-text-muted-dark">{label}</span>
            <input
                type="number"
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(event) => onChange(Number(event.target.value))}
                className="w-full h-9 rounded-lg border border-border dark:border-border-dark bg-background dark:bg-background-dark px-3 text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-primary/25"
            />
        </label>
    );
}
