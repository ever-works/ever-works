'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import {
    NOTIFICATION_MATRIX_GROUPS,
    type NotificationMatrixDto,
    type NotificationMatrixEventDto,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    loadNotificationMatrix,
    resetNotificationMatrix,
    setNotificationEventTargets,
    unmuteNotificationCategory,
} from '@/app/actions/notification-preferences';
import {
    cellFor,
    nextPosition,
    rowsChangedByReset,
    splitColumns,
    withRowToggled,
    withTarget,
    type GridPosition,
} from './matrix-model';
import { MatrixColumnHeader } from './MatrixColumnHeader';
import { MatrixGroup } from './MatrixGroup';
import { MatrixRow, type RowState } from './MatrixRow';
import { QuietHoursRow } from './QuietHoursRow';
import { ResetDefaultsDialog } from './ResetDefaultsDialog';

/** Clicks on one row inside this window collapse into one write carrying the final positions. */
export const MATRIX_SAVE_DEBOUNCE_MS = 400;
/** A write that has not resolved by now is treated as failed and the row reverts. */
export const MATRIX_SAVE_TIMEOUT_MS = 8_000;
/** How long a row says "Saved". */
export const MATRIX_SAVED_VISIBLE_MS = 2_000;
/** Away for at least this long, the page refetches when it regains focus. */
export const MATRIX_REFETCH_AFTER_HIDDEN_MS = 30_000;

const IDLE: RowState = { status: 'idle' };

function selectionsOf(matrix: NotificationMatrixDto): Record<string, string[]> {
    return Object.fromEntries(matrix.events.map((e) => [e.key, [...e.selectedTargets]]));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

const UNKNOWN_CHANNEL = /unknown or unauthorized notification channel/i;

/**
 * AW-13 — Settings -> Notifications: one row per event, one switch per
 * delivery target, saved as you go.
 *
 * Each switch applies immediately. Writes for one row are coalesced over
 * {@link MATRIX_SAVE_DEBOUNCE_MS}, a write that fails or outlives
 * {@link MATRIX_SAVE_TIMEOUT_MS} reverts only its own row to the last value
 * the server confirmed, and nothing here ever blocks another row. The grid is
 * a single tab stop with arrow-key movement; Shift+Space flips a whole row.
 */
export function NotificationMatrix({ initialMatrix }: { initialMatrix: NotificationMatrixDto }) {
    const t = useTranslations('notifications-v2.preferences');

    const [matrix, setMatrix] = useState<NotificationMatrixDto>(initialMatrix);
    const [selections, setSelections] = useState<Record<string, string[]>>(() =>
        selectionsOf(initialMatrix),
    );
    // Every write to `selections` goes through setSelection / applyServerMatrix,
    // which update this ref first, so handlers always read the latest value.
    const selectionsRef = useRef(selections);
    const confirmedRef = useRef<Record<string, string[]>>(selectionsOf(initialMatrix));
    const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const inflightRef = useRef(new Map<string, number>());
    const tokenRef = useRef(0);

    const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
    const [focus, setFocus] = useState<GridPosition>({ row: 0, col: 0 });
    const [announcement, setAnnouncement] = useState('');
    const [banner, setBanner] = useState<string | null>(null);
    const [resetOpen, setResetOpen] = useState(false);
    const [resetPending, startReset] = useTransition();
    const gridRef = useRef<HTMLDivElement>(null);

    const email = matrix.email;
    const { visible, overflow } = useMemo(
        () => splitColumns(matrix.columns, matrix.limits.maxColumns),
        [matrix.columns, matrix.limits.maxColumns],
    );
    const orderedEvents = useMemo(
        () =>
            NOTIFICATION_MATRIX_GROUPS.flatMap((group) =>
                matrix.events.filter((event) => event.group === group),
            ),
        [matrix.events],
    );

    const rowIndexByKey = useMemo(
        () => new Map(orderedEvents.map((event, index) => [event.key, index])),
        [orderedEvents],
    );

    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            for (const timer of timers.values()) clearTimeout(timer);
        };
    }, []);

    const setRowState = useCallback((key: string, state: RowState) => {
        setRowStates((prev) => ({ ...prev, [key]: state }));
    }, []);

    const setSelection = useCallback((key: string, value: string[]) => {
        selectionsRef.current = { ...selectionsRef.current, [key]: value };
        setSelections(selectionsRef.current);
    }, []);

    const applyServerMatrix = useCallback((next: NotificationMatrixDto) => {
        for (const timer of timersRef.current.values()) clearTimeout(timer);
        timersRef.current.clear();
        const fresh = selectionsOf(next);
        const merged: Record<string, string[]> = { ...fresh };
        for (const key of inflightRef.current.keys()) {
            if (selectionsRef.current[key]) merged[key] = selectionsRef.current[key];
        }
        confirmedRef.current = fresh;
        selectionsRef.current = merged;
        setSelections(merged);
        setMatrix(next);
    }, []);

    const refetch = useCallback(async () => {
        const result = await loadNotificationMatrix();
        if (result.success && result.data) {
            applyServerMatrix(result.data);
        }
        return result.success;
    }, [applyServerMatrix]);

    const commit = useCallback(
        async (event: NotificationMatrixEventDto) => {
            timersRef.current.delete(event.key);
            const value = selectionsRef.current[event.key] ?? [];
            const token = ++tokenRef.current;
            inflightRef.current.set(event.key, token);

            let error: string | undefined;
            let saved: string[] | undefined;
            try {
                const result = await withTimeout(
                    setNotificationEventTargets(event.key, value),
                    MATRIX_SAVE_TIMEOUT_MS,
                );
                if (result.success) saved = result.data?.targetIds ?? value;
                else error = result.error ?? 'failed';
            } catch (err) {
                error = err instanceof Error ? err.message : 'failed';
            }

            if (inflightRef.current.get(event.key) !== token) return; // superseded by a newer write
            inflightRef.current.delete(event.key);

            if (saved) {
                confirmedRef.current = { ...confirmedRef.current, [event.key]: saved };
                if (!timersRef.current.has(event.key)) {
                    setRowState(event.key, { status: 'saved' });
                    setAnnouncement(t('announce.saved'));
                    setMatrix((prev) => ({
                        ...prev,
                        events: prev.events.map((e) =>
                            e.key === event.key
                                ? { ...e, explicit: true, selectedTargets: saved! }
                                : e,
                        ),
                    }));
                    setTimeout(() => {
                        setRowStates((prev) =>
                            prev[event.key]?.status === 'saved'
                                ? { ...prev, [event.key]: IDLE }
                                : prev,
                        );
                    }, MATRIX_SAVED_VISIBLE_MS);
                }
                return;
            }

            const pendingTimer = timersRef.current.get(event.key);
            if (pendingTimer) clearTimeout(pendingTimer);
            timersRef.current.delete(event.key);
            setSelection(event.key, confirmedRef.current[event.key] ?? event.selectedTargets);
            setRowState(event.key, { status: 'failed' });
            setAnnouncement(t('announce.failed', { event: event.title }));
            if (error && UNKNOWN_CHANNEL.test(error)) {
                setBanner(t('errors.channelRemoved'));
                void refetch();
            }
        },
        [refetch, setRowState, setSelection, t],
    );

    const applyRow = useCallback(
        (event: NotificationMatrixEventDto, next: string[]) => {
            if (next.length > matrix.limits.maxTargets) {
                setRowState(event.key, {
                    status: 'failed',
                    message: t('errors.tooManyTargets', { max: matrix.limits.maxTargets }),
                });
                return;
            }
            setSelection(event.key, next);
            setRowState(event.key, { status: 'saving' });
            const existing = timersRef.current.get(event.key);
            if (existing) clearTimeout(existing);
            timersRef.current.set(
                event.key,
                setTimeout(() => void commit(event), MATRIX_SAVE_DEBOUNCE_MS),
            );
        },
        [commit, matrix.limits.maxTargets, setRowState, setSelection, t],
    );

    const toggle = useCallback(
        (event: NotificationMatrixEventDto, columnId: string, on: boolean) => {
            const current = selectionsRef.current[event.key] ?? event.selectedTargets;
            applyRow(event, withTarget(current, columnId, on));
        },
        [applyRow],
    );

    const retry = useCallback(
        (event: NotificationMatrixEventDto) => {
            applyRow(event, selectionsRef.current[event.key] ?? event.selectedTargets);
        },
        [applyRow],
    );

    const unmute = useCallback(
        async (event: NotificationMatrixEventDto) => {
            if (!event.muteCategory) return;
            const result = await unmuteNotificationCategory(event.muteCategory);
            if (!result.success) {
                setRowState(event.key, { status: 'failed' });
                return;
            }
            setMatrix((prev) => ({
                ...prev,
                mutes: prev.mutes.filter((m) => m.category !== event.muteCategory),
                events: prev.events.map((e) =>
                    e.muteCategory === event.muteCategory
                        ? { ...e, muted: false, mutedUntil: null }
                        : e,
                ),
            }));
        },
        [setRowState],
    );

    // Refetch and reconcile after the page was away long enough to be stale.
    useEffect(() => {
        let hiddenAt: number | null = null;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                hiddenAt = Date.now();
                return;
            }
            if (hiddenAt !== null && Date.now() - hiddenAt >= MATRIX_REFETCH_AFTER_HIDDEN_MS) {
                void refetch();
            }
            hiddenAt = null;
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [refetch]);

    const focusCell = (position: GridPosition) => {
        const el = gridRef.current?.querySelector<HTMLElement>(
            `[data-matrix-row="${position.row}"][data-matrix-col="${position.col}"]`,
        );
        el?.focus();
    };

    const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        const row = Number(target.dataset.matrixRow);
        const col = Number(target.dataset.matrixCol);
        if (target.dataset.matrixRow === undefined || Number.isNaN(row) || Number.isNaN(col))
            return;
        const event = orderedEvents[row];
        const column = visible[col];
        if (!event || !column) return;

        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const current = selectionsRef.current[event.key] ?? event.selectedTargets;
            const cell = cellFor(event, current, column, email);
            if (e.key === ' ' && e.shiftKey) {
                applyRow(event, withRowToggled(event, current, visible, email, cell.checked));
                return;
            }
            if (!cell.disabled) toggle(event, column.id, !cell.checked);
            return;
        }

        const next = nextPosition(
            { row, col },
            e.key,
            e.ctrlKey || e.metaKey,
            orderedEvents.length,
            visible.length,
        );
        if (next) {
            e.preventDefault();
            setFocus(next);
            focusCell(next);
        }
    };

    const onGridFocus = (e: React.FocusEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.dataset.matrixRow === undefined) return;
        const row = Number(target.dataset.matrixRow);
        const col = Number(target.dataset.matrixCol);
        if (!Number.isNaN(row) && !Number.isNaN(col) && (row !== focus.row || col !== focus.col)) {
            setFocus({ row, col });
        }
    };

    const formatTime = (iso: string) => {
        try {
            return new Intl.DateTimeFormat(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(iso));
        } catch {
            return iso;
        }
    };

    const changing = rowsChangedByReset(matrix.events, selections);

    const confirmReset = () => {
        startReset(async () => {
            const result = await resetNotificationMatrix();
            setResetOpen(false);
            if (!result.success) {
                setBanner(t('errors.load'));
                return;
            }
            setRowStates({});
            await refetch();
        });
    };

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold">{t('title')}</h1>
                    <p className="text-sm text-muted-foreground">{t('intro')}</p>
                </div>
                <button
                    type="button"
                    onClick={() => setResetOpen(true)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-border-dark dark:hover:bg-white/5"
                >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('reset.button')}
                </button>
            </header>

            <QuietHoursRow
                quietHours={matrix.quietHours}
                onChange={(quietHours) => setMatrix((prev) => ({ ...prev, quietHours }))}
            />

            {banner ? (
                <div
                    role="alert"
                    className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                >
                    <span>{banner}</span>
                    <button type="button" className="underline" onClick={() => setBanner(null)}>
                        {t('reset.cancel')}
                    </button>
                </div>
            ) : null}

            <div
                ref={gridRef}
                role="grid"
                aria-label={t('title')}
                aria-colcount={visible.length + 1}
                onKeyDown={onGridKeyDown}
                onFocus={onGridFocus}
                className="overflow-x-auto"
            >
                <div role="rowgroup">
                    <div role="row" className="flex flex-wrap items-end gap-3 pb-2">
                        <div
                            role="columnheader"
                            className="min-w-[14rem] flex-1 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('columns.event')}
                        </div>
                        {visible.map((column) => (
                            <MatrixColumnHeader key={column.id} column={column} />
                        ))}
                        {overflow.length > 0 ? <div role="columnheader" className="w-24" /> : null}
                    </div>
                </div>
                {NOTIFICATION_MATRIX_GROUPS.map((group) => {
                    const events = orderedEvents.filter((e) => e.group === group);
                    if (events.length === 0) return null;
                    return (
                        <MatrixGroup key={group} group={group}>
                            {events.map((event) => {
                                const rowIndex = rowIndexByKey.get(event.key) ?? 0;
                                return (
                                    <MatrixRow
                                        key={event.key}
                                        event={event}
                                        rowIndex={rowIndex}
                                        selected={selections[event.key] ?? event.selectedTargets}
                                        visibleColumns={visible}
                                        overflowColumns={overflow}
                                        email={email}
                                        maxTargets={matrix.limits.maxTargets}
                                        state={rowStates[event.key] ?? IDLE}
                                        focus={focus}
                                        onToggle={toggle}
                                        onRetry={retry}
                                        onUnmute={(e) => void unmute(e)}
                                        formatTime={formatTime}
                                    />
                                );
                            })}
                            {group === 'digest' ? (
                                <div className="pb-2 text-xs">
                                    <Link
                                        href={ROUTES.DASHBOARD_SETTINGS_DIGEST}
                                        className="text-primary underline"
                                    >
                                        {t('links.changeCadence')}
                                    </Link>
                                </div>
                            ) : null}
                        </MatrixGroup>
                    );
                })}
            </div>

            <footer className="text-sm">
                <Link href={ROUTES.DASHBOARD_SETTINGS_CHANNELS} className="text-primary underline">
                    {t('links.connectChannel')}
                </Link>
            </footer>

            <div aria-live="polite" role="status" className="sr-only">
                {announcement}
            </div>

            <ResetDefaultsDialog
                open={resetOpen}
                changing={changing}
                total={matrix.events.length}
                pending={resetPending}
                onCancel={() => setResetOpen(false)}
                onConfirm={confirmReset}
            />
        </div>
    );
}
