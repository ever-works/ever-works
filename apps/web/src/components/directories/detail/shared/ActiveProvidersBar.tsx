'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

export type ResolvedProvider = {
    category: string;
    id: string;
    name: string;
    source: 'override' | 'default';
};

export function ActiveProvidersBar({ providers }: { providers: ResolvedProvider[] }) {
    const t = useTranslations('dashboard.workDetail.schedule.card');

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-4 py-3">
            <p className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark mb-2">
                {t('providers.title')}
            </p>
            <div className="flex flex-wrap gap-2">
                {providers.map((p) => (
                    <span
                        key={`${p.category}-${p.id}`}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
                            p.source === 'override'
                                ? 'border-primary/40 bg-primary/5 text-primary'
                                : 'border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark',
                        )}
                    >
                        <span className="font-medium">{p.category}</span>
                        <span className="opacity-60">{p.name}</span>
                    </span>
                ))}
            </div>
        </div>
    );
}
