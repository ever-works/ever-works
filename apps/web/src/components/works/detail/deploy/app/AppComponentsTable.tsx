'use client';

import { useTranslations } from 'next-intl';
import { ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { AppComponentStatusView } from '@/lib/api/app-runtime.types';
import { useClientNow, withinHours } from './app-ops-format';

export interface AppComponentsTableProps {
    components: AppComponentStatusView[];
    /** Whether the member may read logs (FR-48: members who can deploy). */
    canReadLogs: boolean;
    onLogs?: (component: string) => void;
}

/**
 * Lane aw-ops (APW-06 T38, FR-46) — one row per component: role, ready / desired replicas,
 * restarts of the current pods, the last termination reason, and an out-of-memory kill only when
 * it happened in the last 24 hours. **Logs** opens the drawer on that component.
 */
export function AppComponentsTable({ components, canReadLogs, onLogs }: AppComponentsTableProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.components');
    const now = useClientNow();

    if (components.length === 0) {
        return <p className="text-sm text-text-secondary">{t('empty')}</p>;
    }

    return (
        <div className="overflow-x-auto" data-testid="app-components-table">
            <table className="w-full text-left text-sm">
                <caption className="sr-only">{t('caption')}</caption>
                <thead className="text-xs text-text-secondary">
                    <tr>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('name')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('ready')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('restarts')}
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                            {t('lastStop')}
                        </th>
                        {canReadLogs && (
                            <th scope="col" className="py-1 font-medium">
                                <span className="sr-only">{t('logs')}</span>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody className="divide-y divide-card-border dark:divide-white/9">
                    {components.map((component) => {
                        const short = component.ready < component.desired;
                        const down = component.role === 'web' && component.ready === 0 && component.desired > 0;
                        const oomRecent = withinHours(component.oomKilledAt, now, 24);
                        return (
                            <tr key={component.name} data-testid="app-component-row" data-name={component.name}>
                                <td className="py-1.5 pr-3">
                                    <code className="text-xs font-semibold">{component.name}</code>{' '}
                                    <span className="text-xs text-text-muted">{t(`roles.${component.role}`)}</span>
                                </td>
                                <td
                                    className={cn(
                                        'py-1.5 pr-3 tabular-nums',
                                        down
                                            ? 'font-medium text-red-600 dark:text-red-400'
                                            : short
                                              ? 'font-medium text-amber-700 dark:text-amber-400'
                                              : 'text-text',
                                    )}
                                >
                                    {t('readyOf', { ready: component.ready, desired: component.desired })}
                                </td>
                                <td className="py-1.5 pr-3 tabular-nums">{component.restarts}</td>
                                <td className="py-1.5 pr-3 text-xs text-text-secondary">
                                    {component.lastTerminationReason ?? '—'}
                                    {oomRecent && (
                                        <span
                                            className="ml-1 font-medium text-red-600 dark:text-red-400"
                                            data-testid="app-component-oom"
                                        >
                                            {t('oomRecent')}
                                        </span>
                                    )}
                                </td>
                                {canReadLogs && (
                                    <td className="py-1.5 text-right">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onLogs?.(component.name)}
                                            aria-label={t('logsAria', { name: component.name })}
                                            data-testid="app-component-logs"
                                        >
                                            <ScrollText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                                            {t('logs')}
                                        </Button>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
