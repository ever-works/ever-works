/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx. Used by
 * the guardrails grid and (Phase 4 PR L) the four promoted
 * constant rows (autoGenerateCadence, autoGenerateBatchSize,
 * autoBuildThrottlePerDay, missionDefaultOutstandingCap). Byte-
 * identical output to the inline definition.
 */
export function NumberField({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
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
                onChange={(event) => onChange(Number(event.target.value))}
                className="w-full h-9 rounded-lg border border-border dark:border-border-dark bg-background dark:bg-background-dark px-3 text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-primary/25"
            />
        </label>
    );
}
