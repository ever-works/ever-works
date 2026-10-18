'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Database, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    APP_DEPENDENCY_REASON_MESSAGE_LEAVES,
    APP_DEPENDENCY_STATUS_MESSAGE_LEAVES,
    isAppDependencyReason,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    deleteAppDependencyDataAction,
    getAppDependenciesAction,
    retryAppDependencyAction,
} from '@/app/actions/dashboard/app-dependencies';
import {
    APP_DEPENDENCIES_ROUTE_UNAVAILABLE,
    APP_DEPENDENCY_BUSY_STATUSES,
    canDeleteAppDependencyDataOf,
    canRetryAppDependency,
    isTransientAppDependencyFailure,
    type AppDependenciesListResponse,
    type AppDependencyEntry,
} from '@/lib/api/app-dependencies.types';
import { isAppEnvDependencyKindLeaf } from '@/lib/api/app-env.types';
import { cn } from '@/lib/utils/cn';

type CardState =
    | { kind: 'loading' }
    | { kind: 'ready'; data: AppDependenciesListResponse }
    | { kind: 'unavailable' }
    | { kind: 'error' };

/** Plan §6:858 — poll every 10 s while something is happening, for at most 30 minutes. */
const POLL_MS = 10_000;
const POLL_MAX_MS = 30 * 60_000;

export interface AppDependenciesCardProps {
    work: { id: string; slug: string };
    /** First paint from the server, or `null` when it could not be read there. */
    initial?: AppDependenciesListResponse | null;
}

/**
 * Lane aw-deps-api (APW-07 T25) — the **Dependencies** card on an App Work's Deploy tab.
 *
 * One row per dependency the App spec declares (Postgres, Redis, object storage, SMTP mail): its
 * status, why it failed, how many attempts were spent, and — for members with edit access —
 * **Retry** (`POST …/:kind/provision`) and **Delete data** (`DELETE …/:kind`, behind a dialog that
 * needs the App Work's slug typed, exactly like Remove with data). Never a configuration or output
 * value: the API sends names and counts only (FR-5).
 *
 * A failure that heals on its own (`clusterUnreachable`, `deadlineExceeded`) says that pressing
 * Deploy retries it — the Deploy route does (`retryTransientFailures`).
 */
export function AppDependenciesCard({ work, initial = null }: AppDependenciesCardProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies');
    const [state, setState] = useState<CardState>(
        initial ? { kind: 'ready', data: initial } : { kind: 'loading' },
    );
    const [deleting, setDeleting] = useState<AppDependencyEntry | null>(null);
    const [busyKind, setBusyKind] = useState<string | null>(null);
    const inFlight = useRef(false);

    const load = useCallback(async () => {
        try {
            const result = await getAppDependenciesAction(work.id);
            if (result.success && result.data) setState({ kind: 'ready', data: result.data });
            else if (result.code === APP_DEPENDENCIES_ROUTE_UNAVAILABLE)
                setState({ kind: 'unavailable' });
            else setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
        } catch {
            setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
        }
    }, [work.id]);

    useEffect(() => {
        if (!initial) void load();
    }, [initial, load]);

    const busy =
        state.kind === 'ready' &&
        state.data.dependencies.some((entry) =>
            APP_DEPENDENCY_BUSY_STATUSES.includes(entry.status),
        );

    useEffect(() => {
        if (!busy) return;
        const started = Date.now();
        const timer = setInterval(() => {
            if (Date.now() - started > POLL_MAX_MS) {
                clearInterval(timer);
                return;
            }
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void load();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [busy, load]);

    const kindLabel = useKindLabel();

    const retry = async (entry: AppDependencyEntry) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusyKind(entry.kind);
        const label = kindLabel(entry.kind);
        try {
            const result = await retryAppDependencyAction(work.id, entry.kind);
            if (result.success && result.data) {
                toast.success(
                    result.data.dispatched
                        ? t('retried', { kind: label })
                        : t('retryQueued', { kind: label }),
                );
            } else if (result.code === 'leaseHeld') {
                toast.error(t('leaseHeld', { kind: label }));
            } else {
                toast.error(t('retryFailed', { kind: label }));
            }
        } catch {
            toast.error(t('retryFailed', { kind: label }));
        } finally {
            inFlight.current = false;
            setBusyKind(null);
            void load();
        }
    };

    if (state.kind !== 'ready') {
        return (
            <section
                className="rounded-lg border border-card-border p-4 text-sm text-text-secondary"
                data-testid="app-dependencies-card"
            >
                {state.kind === 'loading'
                    ? t('loading')
                    : state.kind === 'unavailable'
                      ? t('unavailable')
                      : t('error')}
            </section>
        );
    }

    const { dependencies, canEdit } = state.data;
    const failing = dependencies.filter((entry) => entry.status === 'failed');

    return (
        <section
            className={cn(
                'rounded-lg border p-4 space-y-3',
                failing.length > 0
                    ? 'border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-900/10'
                    : 'border-card-border dark:border-border-secondary-dark',
            )}
            aria-labelledby="app-dependencies-card-title"
            data-testid="app-dependencies-card"
            data-failed={failing.length}
        >
            <div className="flex items-start gap-2">
                <Database className="mt-0.5 h-4 w-4 text-text-secondary" aria-hidden="true" />
                <div className="space-y-1">
                    <h3
                        id="app-dependencies-card-title"
                        className="text-sm font-semibold text-text dark:text-text-dark"
                    >
                        {t('title')}
                    </h3>
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('description')}
                    </p>
                </div>
            </div>

            {dependencies.length === 0 ? (
                <p className="text-sm text-text-secondary" data-testid="app-dependencies-empty">
                    {t('empty')}
                </p>
            ) : (
                <ul
                    className="divide-y divide-card-border dark:divide-white/9"
                    data-testid="app-dependencies-list"
                >
                    {dependencies.map((entry) => (
                        <DependencyRow
                            key={entry.kind}
                            entry={entry}
                            kindLabel={kindLabel(entry.kind)}
                            canEdit={canEdit}
                            pending={busyKind === entry.kind}
                            disabled={busyKind !== null}
                            onRetry={() => void retry(entry)}
                            onDeleteData={() => setDeleting(entry)}
                        />
                    ))}
                </ul>
            )}

            {deleting && (
                <AppDependencyDeleteDataDialog
                    workId={work.id}
                    slug={work.slug}
                    entry={deleting}
                    kindLabel={kindLabel(deleting.kind)}
                    onOpenChange={(open) => {
                        if (!open) setDeleting(null);
                    }}
                    onDeleted={() => {
                        setDeleting(null);
                        void load();
                    }}
                />
            )}
        </section>
    );
}

/** `postgres` → "Postgres", reusing the Environment card's translated kind names. */
function useKindLabel(): (kind: string) => string {
    const tKinds = useTranslations('dashboard.workDetail.appDeploy.environment.kinds');
    return (kind: string) => (isAppEnvDependencyKindLeaf(kind) ? tKinds(kind) : kind);
}

function DependencyRow({
    entry,
    kindLabel,
    canEdit,
    pending,
    disabled,
    onRetry,
    onDeleteData,
}: {
    entry: AppDependencyEntry;
    kindLabel: string;
    canEdit: boolean;
    pending: boolean;
    disabled: boolean;
    onRetry: () => void;
    onDeleteData: () => void;
}) {
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies');
    const tDeps = useTranslations('dashboard.workDetail.appDependencies');
    const statusLeaf = APP_DEPENDENCY_STATUS_MESSAGE_LEAVES[entry.status];
    const reason = useReasonText(entry);
    const failed = entry.status === 'failed';

    return (
        <li
            className="flex flex-wrap items-start justify-between gap-2 py-2"
            data-testid="app-dependency-row"
            data-kind={entry.kind}
            data-status={entry.status}
        >
            <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-text dark:text-text-dark">
                        {kindLabel}
                    </span>
                    <span
                        className={cn(
                            'rounded px-1.5 text-[10px]',
                            failed
                                ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                                : entry.status === 'ready'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                                  : 'bg-surface-tertiary text-text-secondary dark:bg-surface-tertiary-dark',
                        )}
                        data-testid="app-dependency-status"
                    >
                        {statusLeaf ? tDeps(`status.${statusLeaf}`) : entry.status}
                    </span>
                    {!entry.inSpec && (
                        <span className="rounded border border-card-border px-1.5 text-[10px] text-text-muted dark:border-white/9">
                            {tDeps('status.notInSpec')}
                        </span>
                    )}
                </div>
                <p className="text-xs text-text-secondary" data-testid="app-dependency-meta">
                    {t('provider', { label: entry.label || entry.provider.providerId })}
                    {entry.sizeGiB ? ` · ${t('size', { size: entry.sizeGiB })}` : ''}
                    {entry.attempts > 0 ? ` · ${t('attempts', { count: entry.attempts })}` : ''}
                </p>
                {reason && (
                    <p
                        className={cn(
                            'text-xs',
                            failed
                                ? 'font-medium text-red-700 dark:text-red-400'
                                : 'text-text-secondary',
                        )}
                        data-testid="app-dependency-reason"
                    >
                        {reason}
                    </p>
                )}
                {isTransientAppDependencyFailure(entry) && (
                    <p
                        className="text-xs text-text-secondary"
                        data-testid="app-dependency-deploy-hint"
                    >
                        {t('deployRetries')}
                    </p>
                )}
            </div>
            {canEdit && (canRetryAppDependency(entry) || canDeleteAppDependencyDataOf(entry)) && (
                <div className="flex flex-wrap gap-2">
                    {canRetryAppDependency(entry) && (
                        <Button
                            type="button"
                            size="sm"
                            variant={failed ? 'primary' : 'secondary'}
                            className="gap-1"
                            onClick={onRetry}
                            loading={pending}
                            disabled={disabled}
                            data-testid="app-dependency-retry"
                            aria-label={t('retryAria', { kind: kindLabel })}
                        >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('retry')}
                        </Button>
                    )}
                    {canDeleteAppDependencyDataOf(entry) && (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-danger"
                            onClick={onDeleteData}
                            disabled={disabled}
                            data-testid="app-dependency-delete-open"
                            aria-label={t('deleteDataAria', { kind: kindLabel })}
                        >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('deleteData')}
                        </Button>
                    )}
                </div>
            )}
        </li>
    );
}

/** The reason line, through the shared `appDependencies.reasons.*` copy, with its parameters. */
function useReasonText(entry: AppDependencyEntry): string | null {
    const tDeps = useTranslations('dashboard.workDetail.appDependencies');
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies');
    const reason = entry.statusReason;
    if (!reason) {
        return entry.status === 'failed' ? t('noReason') : null;
    }
    if (!isAppDependencyReason(reason)) return null;
    const detail = (entry.statusDetail ?? {}) as Record<string, unknown>;
    const names = detail.names ?? detail.extensions;
    return tDeps(`reasons.${APP_DEPENDENCY_REASON_MESSAGE_LEAVES[reason]}`, {
        bucket: String(detail.bucket ?? ''),
        minutes: Number(detail.minutes ?? 10),
        names: Array.isArray(names) ? names.join(', ') : String(names ?? ''),
        storageClass: String(detail.storageClass ?? ''),
    });
}

interface AppDependencyDeleteDataDialogProps {
    workId: string;
    slug: string;
    entry: AppDependencyEntry;
    kindLabel: string;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}

/**
 * **Delete data** — lists what will be destroyed and stays disabled until the App Work's slug is
 * typed (the API checks it again: `422 confirmationMismatch`).
 */
function AppDependencyDeleteDataDialog({
    workId,
    slug,
    entry,
    kindLabel,
    onOpenChange,
    onDeleted,
}: AppDependencyDeleteDataDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies.deleteDialog');
    const tDeps = useTranslations('dashboard.workDetail.appDependencies');
    const slugId = useId();
    const [typed, setTyped] = useState('');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const matches = typed.trim() === slug && slug.length > 0;

    const resources = [
        ...entry.names,
        ...(entry.keptResources?.databases ?? []),
        ...(entry.keptResources?.buckets ?? []),
    ];

    const submit = async () => {
        if (!matches || pending) return;
        setPending(true);
        setMessage(null);
        try {
            const result = await deleteAppDependencyDataAction(workId, entry.kind, typed.trim());
            if (result.success) {
                toast.success(t('requested', { kind: kindLabel }));
                onDeleted();
                return;
            }
            const code = result.code ?? '';
            setMessage(
                isAppDependencyReason(code)
                    ? tDeps(`reasons.${APP_DEPENDENCY_REASON_MESSAGE_LEAVES[code]}`, {
                          bucket: '',
                          minutes: 10,
                          names: '',
                          storageClass: '',
                      })
                    : t('failed', { reason: result.error ?? code }),
            );
        } catch {
            setMessage(t('failed', { reason: '' }));
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-dependency-delete-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title', { kind: kindLabel })}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('description')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-1 text-sm">
                        <p className="font-medium">{t('resources')}</p>
                        {resources.length === 0 ? (
                            <p
                                className="text-text-secondary"
                                data-testid="app-dependency-delete-none"
                            >
                                {t('noResources')}
                            </p>
                        ) : (
                            <ul
                                className="list-inside list-disc"
                                data-testid="app-dependency-delete-resources"
                            >
                                {resources.map((name) => (
                                    <li key={name} className="font-mono text-xs">
                                        {name}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="space-y-1">
                        <label htmlFor={slugId} className="text-sm font-medium">
                            {t('confirmLabel', { slug })}
                        </label>
                        <Input
                            id={slugId}
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            data-testid="app-dependency-delete-slug"
                        />
                    </div>

                    {message && (
                        <p
                            role="alert"
                            className="text-sm text-danger"
                            data-testid="app-dependency-delete-message"
                        >
                            {message}
                        </p>
                    )}

                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => void submit()}
                            loading={pending}
                            disabled={!matches || pending}
                            data-testid="app-dependency-delete-confirm"
                        >
                            {t('confirm')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
