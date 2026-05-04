'use client';

import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

interface SlugConflictWarningProps {
    conflictingRepos: string[];
    suggestedSlug: string;
    onAcceptSuggestion: (suggestedName: string) => void;
}

export function SlugConflictWarning({
    conflictingRepos,
    suggestedSlug,
    onAcceptSuggestion,
}: SlugConflictWarningProps) {
    const t = useTranslations('dashboard.workCreation.import.slugConflict');

    const suggestedName = suggestedSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    return (
        <div
            className={cn(
                'p-4 rounded-lg',
                'bg-amber-50 dark:bg-amber-950/20',
                'border border-amber-200 dark:border-amber-800',
            )}
        >
            <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                    <h4 className="font-medium text-amber-800 dark:text-amber-200">{t('title')}</h4>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        {t('description')}
                    </p>
                    <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        {conflictingRepos.map((repo) => (
                            <span
                                key={repo}
                                className="inline-block mr-2 mb-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30"
                            >
                                {repo}
                            </span>
                        ))}
                    </div>
                    <div className="mt-3">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onAcceptSuggestion(suggestedName)}
                        >
                            {t('useSuggestion', { slug: suggestedSlug })}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
