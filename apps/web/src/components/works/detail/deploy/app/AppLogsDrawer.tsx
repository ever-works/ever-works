'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { appRuntimeOpsClient } from '@/lib/api/app-runtime-ops.client';
import type { AppLogTailView } from '@/lib/api/app-runtime.types';

/** What the drawer can show logs of. */
export interface AppLogsTarget {
    kind: 'component' | 'job';
    name: string;
}

export interface AppLogsDrawerProps {
    workId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    components: string[];
    jobs: string[];
    /** The target the drawer opens on (the row's Logs button). */
    initialTarget?: AppLogsTarget | null;
}

/** How often the read-back is polled, and for how long, before the drawer gives up. */
export const APP_LOGS_POLL_MS = 1_500;
export const APP_LOGS_POLL_ATTEMPTS = 40;
/** Follow re-fetches this often: 4 fetches a minute, inside the API's 10/min. */
export const APP_LOGS_FOLLOW_MS = 15_000;

const LINE_CHOICES = [100, 200, 500] as const;

/** The failure codes with their own sentence → their `logs.errors.*` leaf. */
const LOG_ERRORS: Readonly<Record<string, string>> = {
    cluster_unreachable: 'clusterUnreachable',
    worker_unavailable: 'workerUnavailable',
    redaction_unavailable: 'redactionUnavailable',
    op_unsupported_on_target: 'unsupported',
    app_target_none: 'targetNone',
    logs_cache_unavailable: 'unavailable',
    app_work_deleting: 'deleting',
    APP_WORK_DELETING: 'deleting',
    forbidden: 'forbidden',
};

type DrawerState =
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'ready'; tail: AppLogTailView }
    | { phase: 'error'; message: string };

/**
 * Lane aw-ops (APW-06 T39, FR-48) — the logs drawer: the last 100/200/500 lines of one
 * component's pods (optionally the previous container, after a crash) or of one job's pod.
 *
 * One fetch is `POST app-logs` → a request id → `GET app-logs/:id` polled until `ready` or
 * `failed`. **Refresh** fetches again; **Follow** re-fetches every 15 s while the drawer is open.
 * The tail is redacted by the API (every secret env value of 8+ characters replaced by its name)
 * and is held in memory only — nothing is written to the browser's storage, and closing the drawer
 * drops it.
 */
export function AppLogsDrawer({ workId, open, onOpenChange, components, jobs, initialTarget }: AppLogsDrawerProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.logs');
    const targetId = useId();
    const linesId = useId();
    const previousId = useId();
    const followId = useId();

    const fallback: AppLogsTarget | null = initialTarget
        ? initialTarget
        : components[0]
          ? { kind: 'component', name: components[0] }
          : jobs[0]
            ? { kind: 'job', name: jobs[0] }
            : null;
    const [target, setTarget] = useState<AppLogsTarget | null>(fallback);
    const [lines, setLines] = useState<number>(200);
    const [previous, setPrevious] = useState(false);
    const [follow, setFollow] = useState(false);
    const [state, setState] = useState<DrawerState>({ phase: 'idle' });

    /** Bumped on every fetch and on close, so a slow answer never lands on a newer one. */
    const generation = useRef(0);
    const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const message = useCallback(
        (code: string | undefined, status: number) => {
            if (status === 404) return t('errors.expired');
            if (status === 429) return t('errors.tooMany');
            const leaf = code ? LOG_ERRORS[code] : undefined;
            return leaf ? t(`errors.${leaf}`) : t('errors.failed', { code: code ?? String(status) });
        },
        [t],
    );

    const fetchLogs = useCallback(async () => {
        if (!target) return;
        const mine = ++generation.current;
        setState({ phase: 'loading' });

        const requested = await appRuntimeOpsClient.requestLogs(workId, {
            ...(target.kind === 'component' ? { component: target.name } : { job: target.name }),
            lines,
            ...(target.kind === 'component' && previous ? { previous: true } : {}),
        });
        if (mine !== generation.current) return;
        if (!requested.ok || !requested.data?.requestId) {
            setState({ phase: 'error', message: message(requested.code, requested.status) });
            return;
        }

        const requestId = requested.data.requestId;
        for (let attempt = 0; attempt < APP_LOGS_POLL_ATTEMPTS; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, APP_LOGS_POLL_MS));
            if (mine !== generation.current) return;
            const read = await appRuntimeOpsClient.readLogs(workId, requestId);
            if (mine !== generation.current) return;
            if (!read.ok) {
                setState({ phase: 'error', message: message(read.code, read.status) });
                return;
            }
            if (read.data?.status === 'ready' && read.data.tail) {
                setState({ phase: 'ready', tail: read.data.tail });
                return;
            }
            if (read.data?.status === 'failed') {
                setState({ phase: 'error', message: message(read.data.code, 200) });
                return;
            }
        }
        setState({ phase: 'error', message: t('errors.timedOut') });
    }, [workId, target, lines, previous, message, t]);

    // Fetch when the drawer opens (and when the target changes while it is open).
    useEffect(() => {
        if (!open) {
            generation.current++;
            return;
        }
        void fetchLogs();
        // `fetchLogs` changes with target/lines/previous — each change is a new fetch.
    }, [open, fetchLogs]);

    // Follow: one re-fetch every 15 s after the last one settled.
    useEffect(() => {
        if (followTimer.current) clearTimeout(followTimer.current);
        if (!open || !follow || state.phase === 'loading') return;
        followTimer.current = setTimeout(() => void fetchLogs(), APP_LOGS_FOLLOW_MS);
        return () => {
            if (followTimer.current) clearTimeout(followTimer.current);
        };
    }, [open, follow, state.phase, fetchLogs]);

    // Nothing outlives the component.
    useEffect(
        () => () => {
            generation.current++;
            if (followTimer.current) clearTimeout(followTimer.current);
        },
        [],
    );

    const options: AppLogsTarget[] = [
        ...components.map((name) => ({ kind: 'component' as const, name })),
        ...jobs.map((name) => ({ kind: 'job' as const, name })),
    ];
    const valueOf = (option: AppLogsTarget) => `${option.kind}:${option.name}`;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-4xl">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-logs-drawer">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {options.length === 0 ? (
                    <p className="text-sm text-text-secondary">{t('noTargets')}</p>
                ) : (
                    <div className="flex flex-wrap items-end gap-3 text-sm">
                        <label htmlFor={targetId} className="space-y-1">
                            <span className="block text-xs text-text-secondary">{t('target')}</span>
                            <select
                                id={targetId}
                                className="rounded-md border border-card-border bg-transparent px-2 py-1 dark:border-white/9"
                                value={target ? valueOf(target) : ''}
                                onChange={(event) => {
                                    const next = options.find((option) => valueOf(option) === event.target.value);
                                    if (next) setTarget(next);
                                }}
                                data-testid="app-logs-target"
                            >
                                {components.length > 0 && (
                                    <optgroup label={t('components')}>
                                        {components.map((name) => (
                                            <option key={`c-${name}`} value={`component:${name}`}>
                                                {name}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {jobs.length > 0 && (
                                    <optgroup label={t('jobs')}>
                                        {jobs.map((name) => (
                                            <option key={`j-${name}`} value={`job:${name}`}>
                                                {name}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                        </label>
                        <label htmlFor={linesId} className="space-y-1">
                            <span className="block text-xs text-text-secondary">{t('lines')}</span>
                            <select
                                id={linesId}
                                className="rounded-md border border-card-border bg-transparent px-2 py-1 dark:border-white/9"
                                value={lines}
                                onChange={(event) => setLines(Number(event.target.value))}
                                data-testid="app-logs-lines"
                            >
                                {LINE_CHOICES.map((choice) => (
                                    <option key={choice} value={choice}>
                                        {choice}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {target?.kind === 'component' && (
                            <label htmlFor={previousId} className="flex items-center gap-1.5">
                                <input
                                    id={previousId}
                                    type="checkbox"
                                    checked={previous}
                                    onChange={(event) => setPrevious(event.target.checked)}
                                    data-testid="app-logs-previous"
                                />
                                {t('previous')}
                            </label>
                        )}
                        <label htmlFor={followId} className="flex items-center gap-1.5">
                            <input
                                id={followId}
                                type="checkbox"
                                checked={follow}
                                onChange={(event) => setFollow(event.target.checked)}
                                data-testid="app-logs-follow"
                            />
                            {t('follow')}
                        </label>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => void fetchLogs()}
                            loading={state.phase === 'loading'}
                            disabled={state.phase === 'loading' || !target}
                            data-testid="app-logs-refresh"
                        >
                            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            {t('refresh')}
                        </Button>
                    </div>
                )}

                <div className="max-h-[60vh] overflow-auto rounded-md bg-surface-tertiary p-2 dark:bg-surface-tertiary-dark" aria-live="polite">
                    {state.phase === 'loading' && <p className="text-sm text-text-secondary">{t('loading')}</p>}
                    {state.phase === 'error' && (
                        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="app-logs-error">
                            {state.message}
                        </p>
                    )}
                    {state.phase === 'ready' && <TailView tail={state.tail} />}
                </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TailView({ tail }: { tail: AppLogTailView }) {
    const t = useTranslations('dashboard.workDetail.appDeploy.logs');
    if (tail.containers.length === 0) return <p className="text-sm text-text-secondary">{t('empty')}</p>;
    return (
        <div className="space-y-3" data-testid="app-logs-tail">
            {tail.containers.map((container) => (
                <section key={`${container.pod}/${container.container}`} aria-label={`${container.pod} / ${container.container}`}>
                    <p className="mb-1 text-xs font-medium text-text-secondary">
                        {container.pod} / {container.container}
                        {container.truncated ? ` · ${t('truncated')}` : ''}
                    </p>
                    {container.lines.length === 0 ? (
                        <p className="text-xs text-text-muted">{t('noOutput')}</p>
                    ) : (
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-text dark:text-text-dark">
                            {container.lines.join('\n')}
                        </pre>
                    )}
                </section>
            ))}
            {tail.redactedNames.length > 0 && (
                <p className="text-xs text-text-secondary" data-testid="app-logs-redacted">
                    {t('redacted', { names: tail.redactedNames.join(', ') })}
                </p>
            )}
        </div>
    );
}
