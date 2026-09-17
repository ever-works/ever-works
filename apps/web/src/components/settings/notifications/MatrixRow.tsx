'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import type {
    NotificationMatrixColumnDto,
    NotificationMatrixEventDto,
} from '@ever-works/contracts';
import { cellFor, type MatrixCellLock, type MatrixEmailContext } from './matrix-model';
import { MatrixSwitch } from './MatrixSwitch';
import { MatrixOverflowPicker } from './MatrixOverflowPicker';
import { useColumnLabel } from './MatrixColumnHeader';

export type RowSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface RowState {
    readonly status: RowSaveStatus;
    /** A row-local message (too many targets, a removed channel). */
    readonly message?: string;
}

interface MatrixRowProps {
    event: NotificationMatrixEventDto;
    rowIndex: number;
    selected: readonly string[];
    visibleColumns: readonly NotificationMatrixColumnDto[];
    overflowColumns: readonly NotificationMatrixColumnDto[];
    email: MatrixEmailContext;
    maxTargets: number;
    state: RowState;
    focus: { row: number; col: number };
    onToggle: (event: NotificationMatrixEventDto, columnId: string, on: boolean) => void;
    onRetry: (event: NotificationMatrixEventDto) => void;
    onUnmute: (event: NotificationMatrixEventDto) => void;
    formatTime: (iso: string) => string;
}

/**
 * AW-13 — one event: its title and description, where the information is
 * visible instead when it ships off, one switch per visible column, the
 * overflow picker, and the row's own save state and badges. A failure here
 * never touches another row.
 */
export function MatrixRow({
    event,
    rowIndex,
    selected,
    visibleColumns,
    overflowColumns,
    email,
    maxTargets,
    state,
    focus,
    onToggle,
    onRetry,
    onUnmute,
    formatTime,
}: MatrixRowProps) {
    const t = useTranslations('notifications-v2.preferences');
    const columnLabel = useColumnLabel();

    const lockReason = (lock: MatrixCellLock | null): string | undefined => {
        switch (lock) {
            case 'in-app-locked':
                return t('rowState.locked');
            case 'email-profile':
                return t('rowState.emailProfile');
            case 'email-unverified':
                return t('columns.emailUnverified');
            case 'email-not-configured':
                return t('columns.emailNotConfigured');
            case 'channel-disabled':
                return t('columns.channelDisabled');
            default:
                return undefined;
        }
    };

    const cells = visibleColumns.map((column) => cellFor(event, selected, column, email));
    const locked = cells.some((c) => c.lock === 'in-app-locked');
    const emailProfile = cells.some((c) => c.lock === 'email-profile');

    return (
        <div
            role="row"
            data-event-key={event.key}
            className="flex flex-wrap items-start gap-3 border-b border-border py-3 last:border-b-0 dark:border-border-dark"
        >
            <div role="rowheader" className="min-w-[14rem] flex-1">
                <div className="text-sm font-medium text-text dark:text-text-dark">
                    {event.title}
                </div>
                <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {event.description}
                </div>
                {event.alternativeSurface ? (
                    <div className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t(`alternativeSurface.${event.alternativeSurface}`)}
                    </div>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" aria-live="off">
                    {state.status === 'saving' ? (
                        <span className="inline-flex items-center gap-1 text-text-muted dark:text-text-muted-dark">
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            {t('rowState.saving')}
                        </span>
                    ) : null}
                    {state.status === 'saved' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <Check className="h-3 w-3" aria-hidden="true" />
                            {t('rowState.saved')}
                        </span>
                    ) : null}
                    {state.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {state.message ?? t('rowState.failed')}
                            {state.message ? null : (
                                <button
                                    type="button"
                                    className="underline"
                                    onClick={() => onRetry(event)}
                                >
                                    {t('rowState.retry')}
                                </button>
                            )}
                        </span>
                    ) : null}
                    {event.muted ? (
                        <span
                            className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
                            // The time is formatted in the viewer's locale and zone, which the server cannot know.
                            suppressHydrationWarning
                        >
                            {event.mutedUntil
                                ? t('rowState.muted', { time: formatTime(event.mutedUntil) })
                                : t('mute.muted')}
                            <button
                                type="button"
                                className="underline"
                                onClick={() => onUnmute(event)}
                            >
                                {t('mute.unmute')}
                            </button>
                        </span>
                    ) : null}
                    {locked ? (
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('rowState.locked')}
                        </span>
                    ) : null}
                    {emailProfile ? (
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('rowState.emailProfile')}
                        </span>
                    ) : null}
                </div>
            </div>
            {visibleColumns.map((column, colIndex) => {
                const cell = cells[colIndex];
                return (
                    <div key={column.id} role="gridcell" className="flex w-24 justify-center pt-1">
                        <MatrixSwitch
                            label={t('switchLabel', {
                                event: event.title,
                                column: columnLabel(column),
                            })}
                            checked={cell.checked}
                            disabled={cell.disabled}
                            reason={lockReason(cell.lock)}
                            row={rowIndex}
                            col={colIndex}
                            tabIndex={focus.row === rowIndex && focus.col === colIndex ? 0 : -1}
                            onToggle={() => onToggle(event, column.id, !cell.checked)}
                        />
                    </div>
                );
            })}
            {overflowColumns.length > 0 ? (
                <div role="gridcell" className="pt-0.5">
                    <MatrixOverflowPicker
                        eventTitle={event.title}
                        columns={overflowColumns}
                        selected={selected}
                        maxTargets={maxTargets}
                        onToggle={(columnId, on) => onToggle(event, columnId, on)}
                    />
                </div>
            ) : null}
        </div>
    );
}
