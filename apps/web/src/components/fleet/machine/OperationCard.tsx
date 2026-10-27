'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { isFleetOperationTerminal, type FleetOperationView } from '@ever-works/contracts';
import { cancelFleetOperationAction, getFleetOperationAction } from '@/app/actions/fleet/machine';
import { Button } from '@/components/ui/button';

/** How often a running operation is re-read. */
const POLL_MS = 1_000;

/**
 * Machine actions (FL-09, spec §5.6, U8) — one long act on a machine (a pull,
 * a run, a prune; Compose up / down in P3) followed to its end: the title, the
 * percentage and the last lines while it runs, then "✓ Pulled redis:7" or
 * "✖ Pull failed — <first line>" with Retry.
 *
 * It reads FL-02's operation record (`GET /api/fleet/operations/:id`), which
 * outlives a dropped link (the card says "Reconnecting…" while a read fails
 * and resumes from the record). Stop sends `operation.cancel`.
 */
export function OperationCard({
    operationId,
    title,
    doneTitle,
    onDone,
    onRetry,
    onDismiss,
}: {
    operationId: string;
    /** "Pulling redis:7 on build-01". */
    title: string;
    /** "Pulled redis:7". */
    doneTitle: string;
    onDone?: (operation: FleetOperationView) => void;
    onRetry?: () => void;
    onDismiss?: () => void;
}) {
    const t = useTranslations('fleet.operations');
    const [operation, setOperation] = useState<FleetOperationView | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [lines, setLines] = useState<string[]>([]);
    const doneRef = useRef(onDone);
    doneRef.current = onDone;

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            const result = await getFleetOperationAction(operationId);
            if (cancelled) return;
            if (!result.ok) {
                setReconnecting(true);
                timer = setTimeout(tick, POLL_MS * 2);
                return;
            }
            setReconnecting(false);
            setOperation(result.data);
            const message = result.data.progress?.message;
            if (message)
                setLines((previous) =>
                    previous[previous.length - 1] === message
                        ? previous
                        : [...previous.slice(-7), message],
                );
            if (isFleetOperationTerminal(result.data.state)) {
                doneRef.current?.(result.data);
                return;
            }
            timer = setTimeout(tick, POLL_MS);
        };
        void tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [operationId]);

    const state = operation?.state ?? 'running';
    const percent = operation?.progress?.percent;

    return (
        <div
            className="rounded-xl border border-border dark:border-border-dark p-3 text-sm space-y-2"
            data-testid="fleet-operation-card"
            data-state={state}
            role="status"
            aria-live="polite"
        >
            <div className="flex items-center gap-2">
                {state === 'running' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : state === 'done' ? (
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                ) : (
                    <XCircle className="h-4 w-4 text-danger" aria-hidden />
                )}
                <span className="font-medium">
                    {state === 'running'
                        ? title
                        : state === 'done'
                          ? doneTitle
                          : state === 'cancelled'
                            ? t('cancelled', { title })
                            : state === 'interrupted'
                              ? t('interrupted', { title })
                              : t('failed', { title, hint: operation?.error?.hint ?? '' })}
                </span>
                {state === 'running' && typeof percent === 'number' ? (
                    <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                        {percent}%
                    </span>
                ) : null}
                {reconnecting ? (
                    <span className="text-xs text-warning">{t('reconnecting')}</span>
                ) : null}
                <span className="ml-auto flex gap-1">
                    {state === 'running' ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => void cancelFleetOperationAction(operationId)}
                        >
                            {t('stop')}
                        </Button>
                    ) : null}
                    {state !== 'running' && state !== 'done' && onRetry ? (
                        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
                            {t('retry')}
                        </Button>
                    ) : null}
                    {state !== 'running' && onDismiss ? (
                        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
                            {t('dismiss')}
                        </Button>
                    ) : null}
                </span>
            </div>
            {state === 'running' && lines.length > 0 ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-muted dark:text-text-muted-dark">
                    {lines.join('\n')}
                </pre>
            ) : null}
        </div>
    );
}
