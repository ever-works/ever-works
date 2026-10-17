'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { AppBuildSummary } from '@ever-works/contracts';
import { startAppBuildAction } from '@/app/actions/dashboard/app-builds';
import { appBuildRefusalMessage } from '@/lib/works/app-builds.shared';

/**
 * APW-05 T26/T28 — **Start build**, single-flight.
 *
 * A second click while the first request is in flight is dropped before it
 * reaches the server action (a ref, not state, so two clicks in the same tick
 * cannot both pass the guard). The API dedupes too — a second request inside
 * 10 s answers the same Build with `deduped: true` — but the web should not
 * lean on that to keep the button honest.
 */
export function useStartAppBuild({
    workId,
    canEdit,
    onStarted,
}: {
    workId: string;
    canEdit: boolean;
    onStarted?: (build: AppBuildSummary | null) => void | Promise<void>;
}) {
    const t = useTranslations('dashboard.workDetail.builds');
    const inFlight = useRef(false);
    const mounted = useRef(true);
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const start = useCallback(
        (commitSha?: string) => {
            if (!canEdit || inFlight.current) return;
            inFlight.current = true;
            setStarting(true);
            void (async () => {
                try {
                    const result = await startAppBuildAction(
                        workId,
                        commitSha ? { commitSha } : {},
                    );
                    if (result.success) {
                        toast.success(
                            t(result.data?.deduped ? 'toasts.deduped' : 'toasts.started'),
                        );
                        await onStarted?.(result.data?.build ?? null);
                        return;
                    }
                    const refusal = appBuildRefusalMessage(result);
                    toast.error(t(refusal.key, refusal.values));
                } catch {
                    toast.error(t('errors.startFailed'));
                } finally {
                    inFlight.current = false;
                    if (mounted.current) setStarting(false);
                }
            })();
        },
        [canEdit, onStarted, t, workId],
    );

    return { start, starting };
}
