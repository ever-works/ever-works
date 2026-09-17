'use client';

import { cn } from '@/lib/utils/cn';

interface MatrixSwitchProps {
    /** "{event} → {column}" — the switch's accessible name. */
    label: string;
    checked: boolean;
    /** Read-only (locked or unavailable). Still focusable, so the grid's keyboard walk never skips a cell. */
    disabled: boolean;
    /** Why the switch cannot move; shown on hover. */
    reason?: string;
    row: number;
    col: number;
    tabIndex: 0 | -1;
    onToggle: () => void;
}

/**
 * AW-13 — one delivery switch in the notification matrix.
 *
 * Exposed as a checkbox (`aria-checked`) so the pressed state is announced,
 * and uses `aria-disabled` rather than `disabled` so a read-only cell keeps
 * its place in the roving focus order. Keyboard handling lives on the grid.
 */
export function MatrixSwitch({
    label,
    checked,
    disabled,
    reason,
    row,
    col,
    tabIndex,
    onToggle,
}: MatrixSwitchProps) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={label}
            aria-disabled={disabled || undefined}
            title={reason}
            tabIndex={tabIndex}
            data-matrix-row={row}
            data-matrix-col={col}
            onClick={() => {
                if (!disabled) onToggle();
            }}
            className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:focus-visible:ring-ring-dark focus-visible:ring-offset-2',
                checked ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600',
                disabled && 'cursor-not-allowed opacity-50',
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                    checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
                )}
            />
        </button>
    );
}
