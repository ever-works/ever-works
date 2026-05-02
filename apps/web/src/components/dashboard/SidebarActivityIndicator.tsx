'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useBackgroundActivity } from '@/lib/hooks/use-background-activity';

/**
 * Subtle pulsing dot shown next to the Works nav item
 * when a work is generating and the user hasn't visited /works yet.
 */
export function SidebarActivityIndicator({ className }: { className?: string }) {
    const t = useTranslations('dashboard.sidebar');
    const { showWorkIndicator } = useBackgroundActivity();

    if (!showWorkIndicator) return null;

    return (
        <span
            className={cn(
                'sidebar-activity-dot inline-block w-1.5 h-1.5 rounded-full',
                'bg-amber-600 dark:bg-amber-500',
                className,
            )}
            aria-label={t('activityIndicator')}
        />
    );
}
