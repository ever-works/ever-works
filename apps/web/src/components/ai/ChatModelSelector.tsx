'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    cachedModels,
    formatContextLength,
    loadPluginModels,
    type AiModel,
} from '@/lib/ai/model-catalog';
import type { ProviderModelSummary } from '@/lib/api/types-only';

/**
 * Model picker for the chat composer.
 *
 * Sits where the message is written, because choosing a model is a per-message
 * gesture ("this one needs the big model") — unlike the PROVIDER, which is the
 * thread's identity and lives in the header. Together they read as one
 * sentence: this conversation runs on <provider>, this turn on <model>.
 *
 * Two tiers of options, in the order a user actually reaches for them:
 *
 *  1. The provider's CONFIGURED models — the `defaultModel` / `simpleModel` /
 *     `mediumModel` / `complexModel` settings an admin already curated for the
 *     tenant, delivered on `ProviderOption.models` with no extra request. This
 *     is the short, meaningful list, and for most users the only one they need.
 *  2. The provider's FULL catalogue, fetched lazily on first open. Hundreds of
 *     ids for a gateway like OpenRouter, so it is searchable and deliberately
 *     below the curated set rather than replacing it.
 *
 * Selecting nothing ("provider default") is a first-class choice, not an empty
 * state: it clears the pin so the server resolves whatever the provider is
 * configured to use, which is what should happen when an admin later re-points
 * the tenant at a different model.
 */

interface ChatModelSelectorProps {
    /** Provider plugin the models belong to. Empty renders nothing. */
    providerId: string;
    /** Configured tier models for `providerId`, already resolved for this scope. */
    configuredModels?: ProviderModelSummary[];
    /** Currently pinned model id, or `null` for "provider default". */
    value: string | null;
    disabled?: boolean;
    onChange: (modelId: string | null) => void;
}

export function ChatModelSelector({
    providerId,
    configuredModels,
    value,
    disabled,
    onChange,
}: ChatModelSelectorProps) {
    const t = useTranslations('dashboard.aiChat.model');
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [catalog, setCatalog] = useState<AiModel[]>([]);
    const [loadedFor, setLoadedFor] = useState('');
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    const cached = cachedModels(providerId);

    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                setSearch('');
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
                setSearch('');
            }
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    // Fetched on OPEN, not on mount. The composer renders on every dashboard
    // page; eagerly pulling a gateway's full catalogue there would spend a
    // request per page load for a control most turns never touch.
    useEffect(() => {
        if (!open || !providerId || cached) return;

        let cancelled = false;
        void loadPluginModels(providerId, t('loadError')).then((result) => {
            if (cancelled) return;
            setCatalog(result.models);
            setError(result.error);
            setLoadedFor(providerId);
        });
        return () => {
            cancelled = true;
        };
    }, [open, providerId, cached, t]);

    // Memoised because the `?? []` branch would otherwise mint a new array
    // reference every render, invalidating every useMemo below it.
    const allModels = useMemo(
        () => cached ?? (loadedFor === providerId ? catalog : []),
        [cached, loadedFor, providerId, catalog],
    );
    const loading = open && Boolean(providerId) && !cached && loadedFor !== providerId;

    // De-duplicated against the curated list: a tier model is almost always
    // also in the catalogue, and showing it twice makes the curated section
    // look like noise rather than a shortcut.
    const curatedIds = useMemo(
        () => new Set((configuredModels ?? []).map((m) => m.value)),
        [configuredModels],
    );

    const filteredCatalog = useMemo(() => {
        const rest = allModels.filter((m) => !curatedIds.has(m.id));
        if (!search) return rest;
        const needle = search.toLowerCase();
        return rest.filter(
            (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
        );
    }, [allModels, curatedIds, search]);

    const filteredCurated = useMemo(() => {
        const list = configuredModels ?? [];
        if (!search) return list;
        const needle = search.toLowerCase();
        return list.filter(
            (m) => m.value.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
        );
    }, [configuredModels, search]);

    const select = useCallback(
        (modelId: string | null) => {
            onChange(modelId);
            setOpen(false);
            setSearch('');
        },
        [onChange],
    );

    // A model id can be pinned before its catalogue entry is known (restored
    // from a saved conversation, or chosen under a provider whose catalogue
    // has not been fetched this session). Fall back to the raw id rather than
    // showing "provider default" and lying about what will run.
    const activeLabel = useMemo(() => {
        if (!value) return t('auto');
        const known = allModels.find((m) => m.id === value);
        return known?.name || value;
    }, [value, allModels, t]);

    // Nothing to pick a model FROM until a provider is resolved.
    if (!providerId) return null;

    return (
        <div ref={ref} className="relative min-w-0">
            <button
                type="button"
                onClick={() => !disabled && setOpen((p) => !p)}
                disabled={disabled}
                aria-label={t('label')}
                title={`${t('label')}: ${activeLabel}`}
                data-testid="chat-model-selector"
                className={cn(
                    'flex h-7 min-w-0 max-w-40 shrink items-center gap-1 rounded-lg px-1.5',
                    'text-[10px] font-medium',
                    'text-text-muted dark:text-white/40',
                    'hover:bg-card-hover hover:text-text dark:hover:bg-white/10 dark:hover:text-white',
                    'transition-colors cursor-pointer',
                    open && 'bg-card-hover text-text dark:bg-white/10 dark:text-white',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                )}
            >
                <span className="truncate">{activeLabel}</span>
                <ChevronDown
                    className={cn(
                        'h-3 w-3 shrink-0 opacity-50 transition-transform duration-100',
                        open && 'rotate-180',
                    )}
                    aria-hidden="true"
                />
            </button>

            {open && (
                // Opens UPWARD: the composer is pinned to the bottom of the
                // panel, so a downward menu would render off-screen.
                <div
                    className={cn(
                        'absolute bottom-full left-0 z-50 mb-1.5',
                        'w-72 max-w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl',
                        'bg-white dark:bg-surface-dark',
                        'border border-border dark:border-white/10',
                        'shadow-lg dark:shadow-black/40',
                        'animate-in fade-in-0 zoom-in-95 duration-100',
                    )}
                >
                    <div className="border-b border-border p-1.5 dark:border-white/10">
                        <div className="relative">
                            <Search
                                className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
                                aria-hidden="true"
                            />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t('searchPlaceholder')}
                                aria-label={t('searchPlaceholder')}
                                className={cn(
                                    'w-full rounded-md py-1.5 pl-7 pr-2 text-xs',
                                    'bg-surface-secondary dark:bg-white/[0.04]',
                                    'text-text dark:text-white',
                                    'border border-border dark:border-white/10',
                                    'focus:outline-none focus:ring-1 focus:ring-primary/50',
                                )}
                                autoFocus
                            />
                        </div>
                    </div>

                    <div className="max-h-72 overflow-y-auto p-1.5">
                        {/* "Provider default" is hidden while searching — it is
                            not a model name, so it can never be what a search
                            for one is looking for. */}
                        {!search && (
                            <ModelRow
                                label={t('auto')}
                                hint={t('autoHint')}
                                active={!value}
                                onSelect={() => select(null)}
                            />
                        )}

                        {filteredCurated.length > 0 && (
                            <>
                                <SectionLabel>{t('configured')}</SectionLabel>
                                {filteredCurated.map((model) => (
                                    <ModelRow
                                        key={`${model.key}:${model.value}`}
                                        label={model.value}
                                        hint={model.label}
                                        active={value === model.value}
                                        onSelect={() => select(model.value)}
                                    />
                                ))}
                            </>
                        )}

                        {loading && (
                            <div className="flex items-center gap-2 px-2 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                {t('loading')}
                            </div>
                        )}

                        {!loading && error && (
                            <div className="px-2 py-2 text-xs text-danger">{error}</div>
                        )}

                        {!loading && !error && filteredCatalog.length > 0 && (
                            <>
                                <SectionLabel>{t('all')}</SectionLabel>
                                {filteredCatalog.map((model) => (
                                    <ModelRow
                                        key={model.id}
                                        label={model.name || model.id}
                                        hint={
                                            model.capabilities?.maxContextLength
                                                ? t('context', {
                                                      value: formatContextLength(
                                                          model.capabilities.maxContextLength,
                                                      ),
                                                  })
                                                : undefined
                                        }
                                        active={value === model.id}
                                        onSelect={() => select(model.id)}
                                    />
                                ))}
                            </>
                        )}

                        {!loading &&
                            !error &&
                            filteredCatalog.length === 0 &&
                            filteredCurated.length === 0 && (
                                <div className="px-2 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('noModels')}
                                </div>
                            )}
                    </div>
                </div>
            )}
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
            {children}
        </p>
    );
}

function ModelRow({
    label,
    hint,
    active,
    onSelect,
}: {
    label: string;
    hint?: string;
    active: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs',
                'transition-colors duration-75 cursor-pointer',
                active
                    ? 'bg-primary/8 text-text dark:bg-primary/12 dark:text-white'
                    : 'text-text-secondary hover:bg-surface-secondary hover:text-text dark:text-text-secondary-dark dark:hover:bg-white/[0.05] dark:hover:text-white',
            )}
        >
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{label}</span>
                {hint && (
                    <span className="block truncate text-[10px] text-text-muted dark:text-text-muted-dark">
                        {hint}
                    </span>
                )}
            </span>
            {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
        </button>
    );
}
