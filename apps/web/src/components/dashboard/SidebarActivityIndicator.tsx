'use client';

import { cn } from '@/lib/utils/cn';
import { useBackgroundActivity } from '@/lib/hooks/use-background-activity';

/**
 * Subtle pulsing dot shown next to the Directories nav item
 * when a directory is generating and the user hasn't visited /directories yet.
 */
export function SidebarActivityIndicator({ className }: { className?: string }) {
    const { showDirectoryIndicator } = useBackgroundActivity();

    if (!showDirectoryIndicator) return null;

    return (
        <span
            className={cn(
                'sidebar-activity-dot inline-block w-1.5 h-1.5 rounded-full',
                'bg-amber-600 dark:bg-amber-500',
                className,
            )}
            aria-label="Directory generating"
        />
    );
}
