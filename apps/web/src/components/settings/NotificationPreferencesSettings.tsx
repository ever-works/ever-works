'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import type { NotificationMatrixDto } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { loadNotificationMatrix } from '@/app/actions/notification-preferences';
import { NotificationMatrix } from './notifications/NotificationMatrix';

interface Props {
    /** Null when the matrix could not be loaded; the page then says so and changes nothing. */
    initialMatrix: NotificationMatrixDto | null;
}

/**
 * Settings -> Notifications (EW-664 / EW-679, rebuilt by AW-13).
 *
 * The page's entry component: renders the notification matrix, the state
 * for an empty registry, and a load failure that promises nothing changed.
 */
export function NotificationPreferencesSettings({ initialMatrix }: Props) {
    const t = useTranslations('notifications-v2.preferences');
    const [matrix, setMatrix] = useState<NotificationMatrixDto | null>(initialMatrix);
    const [pending, startTransition] = useTransition();

    if (!matrix) {
        return (
            <div className="space-y-4">
                <h1 className="text-2xl font-semibold">{t('title')}</h1>
                <div
                    role="alert"
                    className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                >
                    <span className="inline-flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {t('errors.load')}
                    </span>
                    <button
                        type="button"
                        disabled={pending}
                        className="font-medium underline disabled:opacity-50"
                        onClick={() =>
                            startTransition(async () => {
                                const result = await loadNotificationMatrix();
                                if (result.success && result.data) setMatrix(result.data);
                            })
                        }
                    >
                        {t('retry')}
                    </button>
                </div>
            </div>
        );
    }

    if (matrix.events.length === 0) {
        return (
            <div className="space-y-4">
                <h1 className="text-2xl font-semibold">{t('title')}</h1>
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="font-medium">{t('emptyState.title')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t('emptyState.body')}</p>
                    <Link
                        href={ROUTES.DASHBOARD_ACTIVITY}
                        className="mt-3 inline-block text-sm text-primary underline"
                    >
                        {t('emptyState.openFeed')}
                    </Link>
                </div>
            </div>
        );
    }

    return <NotificationMatrix initialMatrix={matrix} />;
}
