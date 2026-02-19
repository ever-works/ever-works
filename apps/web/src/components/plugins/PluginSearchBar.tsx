'use client';

import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface PluginSearchBarProps {
    value: string;
    onChange: (value: string) => void;
}

export function PluginSearchBar({ value, onChange }: PluginSearchBarProps) {
    const t = useTranslations('dashboard.plugins.filters');

    return (
        <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark pointer-events-none" />
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('search')}
                className={cn(
                    'w-full pl-10 pr-10 py-2.5 rounded-lg text-sm',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                    'text-text dark:text-text-dark placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                    'outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-shadow',
                )}
            />
            {value && (
                <button
                    onClick={() => onChange('')}
                    aria-label={t('clearSearch')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}
