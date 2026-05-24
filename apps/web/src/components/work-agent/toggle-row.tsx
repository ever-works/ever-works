/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx so the
 * Phase 4 PR L promoted-constant rows + PR EE auto-retry +
 * account-budget sub-sections can reuse it. Byte-identical
 * output to the inline definition the extraction replaced
 * (Decision A10).
 */
export function ToggleRow({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                className="rounded border-border dark:border-border-dark"
            />
            <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {label}
            </span>
        </label>
    );
}
