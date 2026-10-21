'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { FleetVirtualChildrenListView } from '@ever-works/contracts';
import { fleetVirtualPowerAction, listFleetVirtualChildrenAction } from '@/app/actions/fleet/virtual';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import type { ConfirmDialogModel } from '../machine/machine-actions.shared';
import { formatGiB, isVirtualBusy, VIRTUAL_STATE_KEYS, virtualStateGlyph } from './virtual.shared';

const REFRESH_MS = 30_000;
const BUSY_REFRESH_MS = 5_000;

/**
 * Virtual computers (FL-16, spec S6, §5.4, FR-32) — the rows FL-16 adds INSIDE
 * FL-09's **Runs here** Overview block (no second block): each virtual computer
 * this host runs with its state and one-click Start / Stop (stop confirms),
 * and the host's free memory net of what they reserve. Renders nothing for a
 * host with no virtual computers.
 */
export function VirtualRunsHereRows({ hostNodeId, allowed }: { hostNodeId: string; allowed: boolean }) {
    const t = useTranslations('fleet.virtual');
    const [view, setView] = useState<FleetVirtualChildrenListView | null>(null);
    const [stopping, setStopping] = useState<{ id: string; model: ConfirmDialogModel } | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await listFleetVirtualChildrenAction(hostNodeId);
        if (result.ok) setView(result.data);
    }, [hostNodeId]);

    const busy = (view?.children ?? []).some((child) => isVirtualBusy(child.virtual?.state));
    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), busy ? BUSY_REFRESH_MS : REFRESH_MS);
        return () => clearInterval(timer);
    }, [load, busy]);

    if (!view || view.children.length === 0) return null;

    const power = (childId: string, action: 'start' | 'stop', confirm: boolean) =>
        startTransition(async () => {
            const result = await fleetVirtualPowerAction(hostNodeId, childId, action, confirm ? { confirm: true } : {});
            setStopping(null);
            if (result.ok) void load();
            else toast.error(result.error.hint || t('power.failed'));
        });

    return (
        <div className="mt-2 flex flex-col gap-1 text-sm" data-testid="fleet-virtual-runs-here">
            <div className="flex flex-wrap items-center gap-3">
                {view.children.map((child) => {
                    const state = child.virtual?.state ?? 'stopped';
                    const running = state === 'running';
                    return (
                        <span key={child.id} className="inline-flex items-center gap-1" data-testid="fleet-virtual-runs-here-item">
                            <span aria-hidden className={running ? 'text-success' : 'text-text-muted dark:text-text-muted-dark'}>
                                {virtualStateGlyph(state)}
                            </span>
                            <Link href={ROUTES.DASHBOARD_FLEET_COMPUTER(child.id)} className="hover:underline">
                                {child.name}
                            </Link>
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                ({t(`state.${VIRTUAL_STATE_KEYS[state]}`)})
                            </span>
                            {allowed && (running || state === 'stopped') ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() =>
                                        running
                                            ? setStopping({
                                                  id: child.id,
                                                  model: {
                                                      class: 'confirm',
                                                      title: t('power.stopTitle', { name: child.name }),
                                                      body:
                                                          child.virtualKind === 'vm'
                                                              ? t('power.stopBodyVm')
                                                              : t('power.stopBody'),
                                                  },
                                              })
                                            : power(child.id, 'start', false)
                                    }
                                >
                                    {running ? t('power.stop') : t('power.start')}
                                </Button>
                            ) : null}
                        </span>
                    );
                })}
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-virtual-free-memory">
                {t('runsHere.freeMemory', {
                    free: formatGiB(view.freeMemoryMiB) ?? '—',
                    reserved: formatGiB(view.reservedMemoryMiB) ?? '0 GB',
                })}
            </p>
            <ConfirmActionDialog
                model={stopping?.model ?? null}
                actionLabel={t('power.stop')}
                pending={pending}
                onConfirm={() => stopping && power(stopping.id, 'stop', true)}
                onCancel={() => setStopping(null)}
            />
        </div>
    );
}
