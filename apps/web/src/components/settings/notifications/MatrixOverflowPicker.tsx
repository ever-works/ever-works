'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { NotificationMatrixColumnDto } from '@ever-works/contracts';

interface MatrixOverflowPickerProps {
    eventTitle: string;
    columns: readonly NotificationMatrixColumnDto[];
    selected: readonly string[];
    maxTargets: number;
    onToggle: (columnId: string, on: boolean) => void;
}

/**
 * AW-13 — the "+N more" control: the chat channels that do not fit as
 * columns, as a per-row list, with the row's target count against the limit.
 * Esc closes it and puts focus back on the control that opened it.
 */
export function MatrixOverflowPicker({
    eventTitle,
    columns,
    selected,
    maxTargets,
    onToggle,
}: MatrixOverflowPickerProps) {
    const t = useTranslations('notifications-v2.preferences');
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (
                panelRef.current &&
                !panelRef.current.contains(event.target as Node) &&
                !triggerRef.current?.contains(event.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const close = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    return (
        <div className="relative w-24 text-center">
            <button
                ref={triggerRef}
                type="button"
                aria-expanded={open}
                aria-label={t('overflow.title', { event: eventTitle })}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-gray-100 dark:text-text-secondary-dark dark:hover:bg-white/10"
            >
                {t('columns.overflow', { count: columns.length })}
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
            {open ? (
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={t('overflow.title', { event: eventTitle })}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            close();
                        }
                    }}
                    className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-border bg-white p-3 text-left shadow-lg dark:border-border-dark dark:bg-surface-dark"
                >
                    <ul className="space-y-1">
                        {columns.map((column) => (
                            <li key={column.id}>
                                <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                                    <input
                                        type="checkbox"
                                        checked={selected.includes(column.id)}
                                        disabled={column.disabled}
                                        onChange={(event) =>
                                            onToggle(column.id, event.target.checked)
                                        }
                                    />
                                    <span>{column.label}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="mt-2 flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark">
                        <span>
                            {t('overflow.used', { used: selected.length, max: maxTargets })}
                        </span>
                        <button type="button" onClick={close} className="font-medium text-primary">
                            {t('overflow.done')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
