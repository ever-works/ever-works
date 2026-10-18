'use client';

import { useMemo, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { sortNeedsALook, type FleetNodeView, type NeedsALookItem } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import type { FleetNeedsALookResult } from '@/lib/api/fleet';
import { fetchFleetNeedsALookAction, type FleetActionResult } from '@/app/actions/settings/fleet';
import { absoluteTime, relativeTime } from '../fleet-hub.shared';
import { captureFleetEvent } from '../fleet-telemetry';
import { getNeedsALookCommand } from './needs-a-look-commands';

const SEVERITY_DOT: Readonly<Record<NeedsALookItem['severity'], string>> = {
    critical: 'bg-danger',
    warn: 'bg-warning',
    info: 'bg-info',
};

const ACTION =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-7 px-2.5 text-xs border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark disabled:opacity-50';

interface NeedsALookListProps {
    /** The first read, made on the server; null when it failed. */
    initial: FleetNeedsALookResult | null;
    initialError: string | null;
    /** The computers the viewer may see — the rows name them from these. */
    nodes: Pick<FleetNodeView, 'id' | 'name'>[];
    /** `testid` suffix and heading level differ between the hub and a computer page. */
    scope?: 'hub' | 'computer';
    /** How Try again re-reads: the fleet-wide list by default, one computer's on its page. */
    reload?: () => Promise<FleetActionResult<FleetNeedsALookResult>>;
}

/**
 * Fleet hub (FL-01, FR-5, FR-6, spec §5.2 / §5.5) — "Needs a look": what the
 * registered producers say needs a person, critical first, then warn, then
 * info, the longest-standing first. Each row names the computer, the problem
 * in plain words and at most one action (a route, or a named command an epic
 * registered).
 *
 * Degrades on its own, never the page (U11): a failed read says "Could not
 * load what needs a look" with Try again while the cards below keep
 * rendering; a partial answer (a producer was skipped) says so instead of
 * claiming nothing needs a look. A labelled region that announces its count
 * (spec §5.13).
 */
export function NeedsALookList({
    initial,
    initialError,
    nodes,
    scope = 'hub',
    reload: reloadAction = fetchFleetNeedsALookAction,
}: NeedsALookListProps) {
    const t = useTranslations('fleet.overview.needsALook');
    const locale = useLocale();
    const [result, setResult] = useState<FleetNeedsALookResult | null>(initial);
    const [error, setError] = useState<string | null>(initial ? null : initialError);
    const [running, setRunning] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();
    // Times are the browser's: the absolute tooltip only once mounted (the
    // server's time zone is not the reader's), the relative text re-rendered
    // after hydration (its server copy is allowed to differ by a minute).
    const mounted = useMounted();
    const now = new Date();

    const names = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
    const items = useMemo(() => sortNeedsALook(result?.items ?? []), [result]);

    // Never let a failure leave the list: a rejected read or command is said
    // here, beside the rows, instead of reaching the page's error boundary.
    const reload = () => {
        startTransition(async () => {
            try {
                const next = await reloadAction();
                if (next.success) {
                    setResult(next.data);
                    setError(null);
                } else {
                    setError(next.error || t('failed'));
                }
            } catch {
                setError(t('failed'));
            }
        });
    };

    const runCommand = (item: NeedsALookItem) => {
        const handler = getNeedsALookCommand(item.action?.command);
        if (!handler) return;
        setRunning(item.id);
        captureFleetEvent({
            name: 'fleet_needs_a_look_acted',
            properties: { kind: item.kind, action: 'command' },
        });
        startTransition(async () => {
            let failure: string | null = null;
            try {
                const outcome = await handler(item);
                if (!outcome.ok) failure = outcome.error || t('commandFailed');
            } catch {
                failure = t('commandFailed');
            } finally {
                setRunning(null);
            }
            if (failure !== null) {
                setError(failure);
                return;
            }
            reload();
        });
    };

    const headingId = `fleet-needs-a-look-${scope}`;
    const failed = error !== null && result === null;

    return (
        <section
            role="region"
            aria-labelledby={headingId}
            aria-busy={isPending}
            data-testid={`fleet-needs-a-look-${scope}`}
            className="space-y-2"
        >
            <div className="flex items-center justify-between gap-2">
                <h2
                    id={headingId}
                    className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('heading')}
                    {!failed && items.length > 0 && <span className="ml-1">({items.length})</span>}
                    {/* Never "nothing" for a read that failed or was cut short. */}
                    {!failed && (
                        <span className="sr-only">{`. ${t(
                            result?.partial ? 'regionLabelPartial' : 'regionLabel',
                            { count: items.length },
                        )}`}</span>
                    )}
                </h2>
            </div>

            {failed ? (
                <div
                    role="alert"
                    className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
                    data-testid="fleet-needs-a-look-failed"
                >
                    <span className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                        <AlertTriangle
                            className="w-4 h-4 text-warning shrink-0"
                            aria-hidden="true"
                        />
                        {t('failed')}
                    </span>
                    <button
                        type="button"
                        className={ACTION}
                        onClick={reload}
                        disabled={isPending}
                        data-testid="fleet-needs-a-look-retry"
                    >
                        <RefreshCw
                            className={cn('w-3.5 h-3.5', isPending && 'animate-spin')}
                            aria-hidden="true"
                        />
                        {t('tryAgain')}
                    </button>
                </div>
            ) : (
                error !== null && (
                    <p
                        role="alert"
                        className="flex items-center gap-2 text-sm text-text dark:text-text-dark"
                        data-testid="fleet-needs-a-look-error"
                    >
                        <AlertTriangle
                            className="w-4 h-4 text-warning shrink-0"
                            aria-hidden="true"
                        />
                        {error}
                    </p>
                )
            )}

            {failed ? null : items.length === 0 ? (
                <p
                    className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-needs-a-look-empty"
                >
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
                    {result?.partial ? t('partial') : t('empty')}
                </p>
            ) : (
                <ul className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark">
                    {items.map((item) => {
                        const command = item.action?.command
                            ? getNeedsALookCommand(item.action.command)
                            : null;
                        return (
                            <li
                                key={`${item.nodeId}:${item.id}`}
                                className="flex items-start gap-3 px-3 py-2.5"
                                data-testid={`fleet-needs-a-look-item-${item.kind}`}
                                data-severity={item.severity}
                            >
                                <span
                                    className={cn(
                                        'mt-1.5 w-2 h-2 rounded-full shrink-0',
                                        SEVERITY_DOT[item.severity],
                                    )}
                                    aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-text dark:text-text-dark">
                                        <span className="sr-only">{`${t(`severities.${item.severity}`)}: `}</span>
                                        <span className="font-medium">
                                            {names.get(item.nodeId) ?? t('unknownComputer')}
                                        </span>
                                        <span className="mx-1.5 text-text-muted dark:text-text-muted-dark">
                                            ·
                                        </span>
                                        {item.title}
                                    </p>
                                    {(item.detail || item.since) && (
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {item.detail}
                                            {item.detail && ' · '}
                                            <span
                                                title={
                                                    mounted
                                                        ? (absoluteTime(item.since, locale) ??
                                                          undefined)
                                                        : undefined
                                                }
                                                suppressHydrationWarning
                                            >
                                                {t('since', {
                                                    time:
                                                        relativeTime(item.since, now, locale) ?? '',
                                                })}
                                            </span>
                                        </p>
                                    )}
                                </div>
                                {item.action?.route ? (
                                    <Link
                                        href={item.action.route}
                                        className={ACTION}
                                        onClick={() =>
                                            captureFleetEvent({
                                                name: 'fleet_needs_a_look_acted',
                                                properties: { kind: item.kind, action: 'route' },
                                            })
                                        }
                                        data-testid="fleet-needs-a-look-action"
                                    >
                                        {item.action.label}
                                    </Link>
                                ) : command ? (
                                    <button
                                        type="button"
                                        className={ACTION}
                                        onClick={() => runCommand(item)}
                                        disabled={isPending || running === item.id}
                                        data-testid="fleet-needs-a-look-action"
                                    >
                                        {item.action?.label}
                                    </button>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
            {!failed && items.length > 0 && result?.partial && (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-needs-a-look-partial"
                >
                    {t('partial')}
                </p>
            )}
        </section>
    );
}
