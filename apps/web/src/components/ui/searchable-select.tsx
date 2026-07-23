'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface SearchableSelectOption {
    /** The value stored when this option is picked. */
    value: string;
    /** Primary line. */
    label: string;
    /** Optional secondary line — an id, a description, a hint. */
    description?: string;
}

interface SearchableSelectProps {
    label?: string;
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<SearchableSelectOption>;
    /** Shown on the trigger when `value` is empty. */
    placeholder?: string;
    /** Helper text under the control. */
    hint?: string;
    disabled?: boolean;
    /**
     * Allow typing a value that is not in `options`.
     *
     * Needed wherever the option list is a convenience rather than the
     * authority — e.g. a provider id the server knows about but this build
     * does not, or a cron expression outside the preset list. Without it a
     * picker becomes strictly less capable than the free-text input it
     * replaces, which is a regression rather than an improvement.
     */
    allowCustom?: boolean;
    customLabel?: string;
    customPlaceholder?: string;
    /** Label for the option that clears the value (e.g. "Account default"). */
    emptyOptionLabel?: string;
    /** Stable prefix for e2e selectors. */
    testId?: string;
}

/**
 * Searchable single-select combobox.
 *
 * Exists because several settings that are effectively enumerations — AI
 * provider, model, run cadence — shipped as free-text `<input>`s, which
 * means the user has to already know the exact id to type. The list is
 * filterable because these enumerations can be long (a gateway exposes
 * hundreds of models).
 *
 * Modeled on the interaction of `PluginModelSelect`, which solves the same
 * problem for models specifically and remains the right component when the
 * options must be fetched per-provider.
 */
export function SearchableSelect({
    label,
    value,
    onChange,
    options,
    placeholder,
    hint,
    disabled = false,
    allowCustom = false,
    customLabel,
    customPlaceholder,
    emptyOptionLabel,
    testId,
}: SearchableSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [custom, setCustom] = useState('');
    const [showCustom, setShowCustom] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => {
        setIsOpen(false);
        setSearch('');
        setShowCustom(false);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                close();
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [isOpen, close]);

    const filtered = useMemo(() => {
        if (!search) return options;
        const needle = search.toLowerCase();
        return options.filter(
            (option) =>
                option.label.toLowerCase().includes(needle) ||
                option.value.toLowerCase().includes(needle) ||
                (option.description?.toLowerCase().includes(needle) ?? false),
        );
    }, [options, search]);

    const selected = options.find((option) => option.value === value);
    // A value with no matching option is still shown verbatim — it is either
    // a custom entry or an id from a newer server, and blanking it would
    // misrepresent what is actually saved.
    const display = selected?.label || value || placeholder || '';

    const commitCustom = () => {
        const trimmed = custom.trim();
        if (!trimmed) return;
        onChange(trimmed);
        setCustom('');
        close();
    };

    return (
        <div>
            {label && (
                <label className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                    {label}
                </label>
            )}
            <div ref={containerRef} className="relative">
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setIsOpen((open) => !open)}
                    aria-haspopup="listbox"
                    aria-expanded={isOpen}
                    data-testid={testId ? `${testId}-trigger` : undefined}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark/30',
                        'text-text dark:text-text-dark text-left text-sm',
                        'focus:outline-none focus:ring-2 focus:ring-primary/50',
                        'flex items-center justify-between gap-2',
                        disabled && 'opacity-50 cursor-not-allowed',
                    )}
                >
                    <span
                        className={cn(
                            'truncate',
                            !value && 'text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {display}
                    </span>
                    <ChevronDown className="w-4 h-4 shrink-0 text-text-muted" />
                </button>

                {isOpen && !disabled && (
                    <div
                        role="listbox"
                        data-testid={testId ? `${testId}-panel` : undefined}
                        className="absolute z-50 mt-1 w-full rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark shadow-lg max-h-80 overflow-hidden"
                    >
                        {options.length > 6 && (
                            <div className="p-2 border-b border-border dark:border-border-dark">
                                <div className="relative">
                                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                                    <input
                                        autoFocus
                                        type="text"
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        className="w-full pl-7 pr-2 py-1.5 text-sm rounded-md bg-surface-secondary dark:bg-surface-secondary-dark/30 border border-border dark:border-border-dark focus:outline-none focus:ring-1 focus:ring-primary/50"
                                    />
                                </div>
                            </div>
                        )}

                        <div className="max-h-56 overflow-y-auto py-1">
                            {emptyOptionLabel && !search && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        onChange('');
                                        close();
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark/40 flex items-center justify-between gap-2"
                                >
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {emptyOptionLabel}
                                    </span>
                                    {!value && <Check className="w-3.5 h-3.5 text-primary" />}
                                </button>
                            )}

                            {filtered.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    role="option"
                                    aria-selected={option.value === value}
                                    onClick={() => {
                                        onChange(option.value);
                                        close();
                                    }}
                                    className="w-full px-3 py-2 text-left hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark/40 flex items-start justify-between gap-2"
                                >
                                    <span className="min-w-0">
                                        <span className="block text-sm text-text dark:text-text-dark truncate">
                                            {option.label}
                                        </span>
                                        {option.description && (
                                            <span className="block text-xs text-text-muted dark:text-text-muted-dark truncate">
                                                {option.description}
                                            </span>
                                        )}
                                    </span>
                                    {option.value === value && (
                                        <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
                                    )}
                                </button>
                            ))}

                            {filtered.length === 0 && !allowCustom && (
                                <p className="px-3 py-3 text-xs text-text-muted dark:text-text-muted-dark">
                                    {search ? `No match for "${search}"` : 'Nothing to choose from'}
                                </p>
                            )}
                        </div>

                        {allowCustom && (
                            <div className="border-t border-border dark:border-border-dark p-2">
                                {showCustom ? (
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            autoFocus
                                            type="text"
                                            value={custom}
                                            placeholder={customPlaceholder}
                                            onChange={(event) => setCustom(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    commitCustom();
                                                }
                                            }}
                                            className="flex-1 min-w-0 px-2 py-1.5 text-sm rounded-md bg-surface-secondary dark:bg-surface-secondary-dark/30 border border-border dark:border-border-dark focus:outline-none focus:ring-1 focus:ring-primary/50"
                                        />
                                        <button
                                            type="button"
                                            onClick={commitCustom}
                                            className="shrink-0 px-2 py-1.5 text-xs rounded-md bg-primary text-white"
                                        >
                                            Set
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setShowCustom(true)}
                                        className="w-full px-2 py-1.5 text-xs text-left text-primary hover:underline"
                                    >
                                        {customLabel ?? 'Enter a custom value…'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
            {hint && (
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">{hint}</p>
            )}
        </div>
    );
}
