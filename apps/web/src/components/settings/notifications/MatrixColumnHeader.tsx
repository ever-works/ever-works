'use client';

import { useTranslations } from 'next-intl';
import type { NotificationMatrixColumnDto } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/** The label a column is announced and shown by. Chat channels use their own name. */
export function useColumnLabel(): (column: NotificationMatrixColumnDto) => string {
    const t = useTranslations('notifications-v2.preferences');
    return (column) =>
        column.kind === 'in-app'
            ? t('columns.inApp')
            : column.kind === 'email'
              ? t('columns.email')
              : column.label;
}

/**
 * AW-13 — one column heading: its name, the delivering plugin for a chat
 * channel (resolved on the server, never from a local list), and why a
 * column is read-only when it is.
 */
export function MatrixColumnHeader({ column }: { column: NotificationMatrixColumnDto }) {
    const t = useTranslations('notifications-v2.preferences');
    const label = useColumnLabel()(column);

    return (
        <div role="columnheader" className="flex w-24 flex-col items-center text-center">
            <span className="text-xs font-medium text-text dark:text-text-dark">{label}</span>
            {column.providerLabel ? (
                <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {column.providerLabel}
                </span>
            ) : null}
            {column.disabledReason === 'email-unverified' ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                    {t('columns.emailUnverified')}{' '}
                    <Link href={ROUTES.DASHBOARD_SETTINGS} className="underline">
                        {t('columns.verifyEmail')}
                    </Link>
                </span>
            ) : null}
            {column.disabledReason === 'email-not-configured' ? (
                <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('columns.emailNotConfigured')}
                </span>
            ) : null}
            {column.disabledReason === 'channel-disabled' ? (
                <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('columns.channelDisabled')}
                </span>
            ) : null}
        </div>
    );
}
