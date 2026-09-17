'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { NotificationMatrixGroup } from '@ever-works/contracts';

/**
 * AW-13 — one of the four headings of the matrix (a real heading, so heading
 * navigation lands on it) with the line that says why its rows are set the
 * way they are.
 */
export function MatrixGroup({
    group,
    children,
}: {
    group: NotificationMatrixGroup;
    children: ReactNode;
}) {
    const t = useTranslations('notifications-v2.preferences');
    const hint =
        group === 'needsYou'
            ? t('groups.needsYouHint')
            : group === 'signals'
              ? t('groups.signalsHint')
              : group === 'routine'
                ? t('groups.routineHint')
                : null;
    return (
        <div role="rowgroup" data-matrix-group={group} className="pt-4">
            <div role="row">
                <div
                    role="gridcell"
                    className="border-b border-border pb-1 dark:border-border-dark"
                >
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-text dark:text-text-dark">
                        {t(`groups.${group}`)}
                        {hint ? (
                            <span className="ml-2 font-normal normal-case tracking-normal text-text-muted dark:text-text-muted-dark">
                                {hint}
                            </span>
                        ) : null}
                    </h2>
                </div>
            </div>
            {children}
        </div>
    );
}
