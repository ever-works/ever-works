import { NumberField } from './number-field';

/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx. Wraps
 * NumberField with cents↔dollars conversion (display is whole
 * dollars; storage is cents). PR EE's account-budget section
 * reuses this for the monthly cap input. Byte-identical to the
 * inline definition.
 */
export function MoneyField({
    label,
    cents,
    onChange,
}: {
    label: string;
    cents: number;
    onChange: (value: number) => void;
}) {
    return (
        <NumberField
            label={label}
            value={Math.round(cents / 100)}
            min={0}
            max={10_000}
            onChange={(value) => onChange(Math.max(0, Math.round(value * 100)))}
        />
    );
}
