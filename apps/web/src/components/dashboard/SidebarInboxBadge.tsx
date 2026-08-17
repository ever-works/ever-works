'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { INBOX_POLL_INTERVAL_MS } from '@/lib/api/inbox.shared';
import { getInboxUnreadCountAction } from '@/app/actions/dashboard/inbox';

/**
 * Unread-count badge on the sidebar's Inbox item.
 *
 * Polls at the notification bell's cadence (30s) instead of holding a
 * socket: the count is cheap, the surface is not real-time-critical, and
 * one interval per session is far less machinery than a subscription
 * that has to survive tab sleep. `null` from the action (signed out, API
 * unhappy) renders nothing rather than a "0" that would read as "your
 * inbox is empty" when it might not be.
 */
export function SidebarInboxBadge({ className }: { className?: string }) {
    const t = useTranslations('dashboard.sidebar');
    const [count, setCount] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            const next = await getInboxUnreadCountAction();
            if (!cancelled) setCount(next);
        };
        void load();
        const timer = setInterval(() => void load(), INBOX_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    if (count === null || count <= 0) return null;

    return (
        <span
            className={cn(
                'inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full',
                'bg-blue-600 dark:bg-blue-500 text-white text-[10px] font-medium leading-none',
                className,
            )}
            aria-label={t('inboxUnread', { count })}
            data-testid="sidebar-inbox-badge"
        >
            {count > 99 ? '99+' : count}
        </span>
    );
}
