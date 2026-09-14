'use client';

import { Command } from 'cmdk';
import { cn } from '@/lib/utils/cn';
import type { PaletteRow as PaletteRowModel } from './registry/sections';

interface PaletteRowProps {
    row: PaletteRowModel;
    onActivate: (row: PaletteRowModel) => void;
}

/**
 * One palette row: icon · title · optional secondary line · optional status
 * badge. Status is always a text badge, never colour alone. Rows are at least
 * 44 px tall on small screens so they stay comfortable touch targets.
 */
export function PaletteRow({ row, onActivate }: PaletteRowProps) {
    const Icon = row.icon;
    return (
        <Command.Item
            value={row.key}
            onSelect={() => onActivate(row)}
            data-testid="command-palette-row"
            data-row-key={row.key}
            data-action={row.action.type}
            className={cn(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm md:min-h-9',
                'text-text dark:text-text-dark',
                'outline-offset-[-2px] aria-selected:bg-primary/10 aria-selected:outline aria-selected:outline-2 aria-selected:outline-primary',
                'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
            )}
        >
            <Icon
                className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
                <span className="block truncate">{row.title}</span>
                {row.subtitle ? (
                    <span className="block truncate text-xs text-text-muted dark:text-text-muted-dark">
                        {row.subtitle}
                    </span>
                ) : null}
            </span>
            {row.badge ? (
                <span
                    data-testid="command-palette-row-badge"
                    className={cn(
                        'shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none',
                        'border-border dark:border-border-dark',
                        'text-text-secondary dark:text-text-secondary-dark',
                    )}
                >
                    {row.badge}
                </span>
            ) : null}
        </Command.Item>
    );
}
