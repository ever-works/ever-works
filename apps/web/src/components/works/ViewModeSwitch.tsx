'use client';

import { LayoutGrid, Kanban } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

export type ViewMode = 'card' | 'kanban';

interface ViewModeSwitchProps {
    mode: ViewMode;
    onChange: (mode: ViewMode) => void;
}

export function ViewModeSwitch({ mode, onChange }: ViewModeSwitchProps) {
    const t = useTranslations('dashboard.works.viewMode');

    return (
        <div className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5">
            <button
                onClick={() => onChange('card')}
                title={t('card')}
                aria-pressed={mode === 'card'}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                    mode === 'card'
                        ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                        : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                )}
            >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="hidden @xs/main:inline">{t('card')}</span>
            </button>
            <button
                onClick={() => onChange('kanban')}
                title={t('kanban')}
                aria-pressed={mode === 'kanban'}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                    mode === 'kanban'
                        ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                        : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                )}
            >
                <Kanban className="w-3.5 h-3.5" />
                <span className="hidden @xs/main:inline">{t('kanban')}</span>
            </button>
        </div>
    );
}
