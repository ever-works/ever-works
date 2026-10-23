'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetNodeView, FleetNodeVirtualView } from '@ever-works/contracts';
import { listFleetVirtualChildrenAction } from '@/app/actions/fleet/virtual';
import {
    isVirtualBusy,
    isVirtualChild,
    progressSteps,
    VIRTUAL_PHASE_KEYS,
    VIRTUAL_STATE_KEYS,
    virtualStateGlyph,
} from './virtual.shared';

/** While a child is being built or changed, its row re-reads every five seconds (spec FR-13). */
const BUSY_REFRESH_MS = 5_000;

/**
 * Virtual computers (FL-16, spec §5.1, §5.3, FR-31) — the line a nested
 * computer card adds under FL-01's "Container on build-01": the system, the
 * size and the state, and while it is being created the progress line through
 * the named phases (pulling image ✓ · starting ✓ · installing the node runtime …).
 * A failure shows its first line. Renders nothing for a computer that is not a
 * virtual one.
 */
export function VirtualChildRow({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.virtual');
    const [live, setLive] = useState<FleetNodeVirtualView | null>(node.virtual ?? null);
    const state = live?.state ?? null;
    const busy = isVirtualBusy(state);
    const hostNodeId = node.hostNodeId ?? null;

    useEffect(() => {
        setLive(node.virtual ?? null);
    }, [node.virtual]);

    useEffect(() => {
        if (!busy || !hostNodeId) return;
        const timer = setInterval(() => {
            void listFleetVirtualChildrenAction(hostNodeId).then((result) => {
                if (!result.ok) return;
                const fresh = result.data.children.find((child) => child.id === node.id)?.virtual ?? null;
                if (fresh) setLive(fresh);
            });
        }, BUSY_REFRESH_MS);
        return () => clearInterval(timer);
    }, [busy, hostNodeId, node.id]);

    if (!isVirtualChild(node) || !live) return null;
    const kind = node.virtualKind === 'vm' ? 'vm' : 'container';
    const size = live.diskGiB
        ? t('row.sizeWithDisk', { cpus: live.cpus, memory: live.memoryGiB, disk: live.diskGiB })
        : t('row.size', { cpus: live.cpus, memory: live.memoryGiB });
    const { steps, current } = progressSteps(kind, live.phase);
    const creating = live.state === 'creating' || live.state === 'installing' || live.state === 'enrolling';

    return (
        <div className="mt-1 ml-6 text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-virtual-row">
            <p>
                <span aria-hidden className={live.state === 'running' ? 'text-success' : undefined}>
                    {virtualStateGlyph(live.state)}
                </span>{' '}
                {t(`state.${VIRTUAL_STATE_KEYS[live.state]}` as Parameters<typeof t>[0])} · {live.systemLabel} · {size}
                {kind === 'vm' && live.activated === false ? (
                    <span title={t('activation.note')} data-testid="fleet-virtual-not-activated">
                        {' '}
                        · {t('row.notActivated')}
                    </span>
                ) : null}
            </p>
            {creating ? (
                <ol className="mt-1 flex flex-wrap gap-2" aria-label={t('progress.label')}>
                    {steps.map((step, index) => (
                        <li key={step} className={index === current ? 'font-medium text-text dark:text-text-dark' : undefined}>
                            {t(`progress.${VIRTUAL_PHASE_KEYS[step]}` as Parameters<typeof t>[0])}
                            {index < current ? ' ✓' : index === current ? ' …' : ''}
                        </li>
                    ))}
                </ol>
            ) : null}
            {live.state === 'failed' && live.error ? (
                <p className="mt-1 text-danger" role="status">
                    {t('row.failed', { reason: live.error })}
                </p>
            ) : null}
            {live.state === 'gone' ? <p className="mt-1">{t('row.gone', { host: live.hostName ?? '' })}</p> : null}
            {live.state === 'not-enrolled' ? <p className="mt-1">{t('row.notEnrolled')}</p> : null}
        </div>
    );
}
