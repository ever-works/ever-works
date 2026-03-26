'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils/cn';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown } from 'lucide-react';
import type { ProviderOption } from '@/lib/api/types-only';

interface ChatProviderSelectorProps {
    providers: ProviderOption[];
    selectedProvider: string;
    isStreaming: boolean;
    onSelect: (id: string) => void;
}

export function ChatProviderSelector({
    providers,
    selectedProvider,
    isStreaming,
    onSelect,
}: ChatProviderSelectorProps) {
    const t = useTranslations('dashboard.aiChat');
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const active = providers.find((p) => p.id === selectedProvider) ?? providers[0];

    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    if (providers.length === 0) return null;

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => !isStreaming && setOpen((p) => !p)}
                className={cn(
                    'inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-lg text-[11px] font-medium',
                    'border border-border dark:border-white/8',
                    'text-text-secondary dark:text-text-secondary-dark',
                    'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                    'hover:text-text dark:hover:text-white',
                    'hover:border-border-secondary dark:hover:border-white/12',
                    'transition-all duration-100 cursor-pointer',
                    open &&
                        'border-primary/30 dark:border-white/15 bg-surface-secondary dark:bg-white/[0.04]',
                    isStreaming && 'opacity-50 pointer-events-none',
                )}
            >
                {active?.icon && (
                    <PluginIcon icon={active.icon} name={active.name} size={14} plain />
                )}
                <span className="whitespace-nowrap">{active?.name ?? t('selectProvider')}</span>
                <ChevronDown
                    className={cn(
                        'w-3 h-3 opacity-40 transition-transform duration-100',
                        open && 'rotate-180',
                    )}
                />
            </button>

            {open && (
                <div
                    className={cn(
                        'absolute right-0 mt-1.5 z-50',
                        'w-56 rounded-xl overflow-hidden',
                        'bg-white dark:bg-surface-dark',
                        'border border-border dark:border-white/10',
                        'shadow-lg dark:shadow-black/40',
                        'animate-in fade-in-0 zoom-in-95 duration-100',
                    )}
                >
                    <div className="p-1.5">
                        <p className="px-2 pt-1 pb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                            {t('title')}
                        </p>
                        {providers.map((provider) => {
                            const isActive = selectedProvider === provider.id;
                            const isDisabled = !provider.configured;

                            return (
                                <button
                                    key={provider.id}
                                    type="button"
                                    onClick={() => {
                                        if (!isDisabled) {
                                            onSelect(provider.id);
                                            setOpen(false);
                                        }
                                    }}
                                    disabled={isDisabled}
                                    className={cn(
                                        'flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-xs',
                                        'transition-colors duration-75 cursor-pointer',
                                        isActive
                                            ? 'bg-primary/8 dark:bg-primary/12 text-text dark:text-white'
                                            : 'text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-white/[0.05] hover:text-text dark:hover:text-white',
                                        isDisabled &&
                                            'opacity-35 cursor-not-allowed hover:bg-transparent dark:hover:bg-transparent',
                                    )}
                                >
                                    <div className="flex items-center justify-center w-5 h-5 shrink-0">
                                        {provider.icon ? (
                                            <PluginIcon
                                                icon={provider.icon}
                                                name={provider.name}
                                                size={18}
                                                plain
                                            />
                                        ) : (
                                            <div className="w-4 h-4 rounded bg-surface-tertiary dark:bg-surface-tertiary-dark" />
                                        )}
                                    </div>
                                    <span className="flex-1 text-left font-medium whitespace-nowrap">
                                        {provider.name}
                                    </span>
                                    {isDisabled && (
                                        <span className="text-[9px] text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                            {t('notConfigured')}
                                        </span>
                                    )}
                                    {isActive && !isDisabled && (
                                        <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
