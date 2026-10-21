'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { SlidersHorizontal } from 'lucide-react';
import type { FleetNodeLimitCeiling } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import type {
    CreateFleetEnrollmentTokenResponse,
    FleetNodeDetailView,
    FleetNodeView,
} from '@/lib/api/fleet';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    clearFleetNodeModelThrottleAction,
    drainFleetNodeAction,
    getFleetNodeDetailAction,
    rotateFleetNodeCredentialAction,
    setFleetNodeLimitCeilingAction,
    updateFleetNodeAction,
} from '@/app/actions/settings/fleet';
import { FleetNodeDrawer } from '../computers/FleetNodeDrawer';
import { FleetEnrollHandoff } from '../computers/FleetEnrollHandoff';
import { isEmptyLimitCeiling, keepIfStillOpen } from '../computers/fleet-node-limits.shared';

/**
 * Fleet hub (FL-01, T-24, spec §5.10) — on a computer's Settings tab, the
 * machine's own settings: capability tags, resource limits, the daily cost
 * ceiling, the lifecycle section and the credential — the SAME node panel the
 * Computers tab opens from Details (`FleetNodeDrawer`, mounted unchanged), so
 * there is one implementation of each and nothing to drift. Owner only: these
 * are the owner's settings, never part of what a computer shares.
 *
 * Every write goes through the server actions the Computers tab uses and
 * refreshes the page; a rotated credential's one-time token is shown at once,
 * exactly as on the Computers tab, because it is returned only once.
 */
export function ComputerMachineSettings({
    node,
    apiBaseUrl,
    desktopDownloadUrl,
    nodeDownloadUrl,
}: {
    node: FleetNodeView;
    apiBaseUrl: string;
    desktopDownloadUrl: string;
    nodeDownloadUrl: string;
}) {
    const t = useTranslations('fleet.computer.settings.machine');
    const tFleet = useTranslations('dashboard.settings.fleet');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [drawerNode, setDrawerNode] = useState<FleetNodeView | null>(null);
    const [detail, setDetail] = useState<FleetNodeDetailView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issued, setIssued] = useState<CreateFleetEnrollmentTokenResponse | null>(null);

    const settle = (next: FleetNodeView) => {
        setDrawerNode((prev) => keepIfStillOpen(prev, next));
        setDetail((prev) => (prev && prev.node.id === next.id ? { ...prev, node: next } : prev));
        router.refresh();
    };

    const open = () => {
        setDrawerNode(node);
        setDetail(null);
        setError(null);
        setLoading(true);
        startTransition(async () => {
            const result = await getFleetNodeDetailAction(node.id);
            setLoading(false);
            if (result.success) {
                setDetail(result.data);
                setDrawerNode((prev) => keepIfStillOpen(prev, result.data.node));
            } else {
                setError(result.error);
            }
        });
    };

    const close = () => {
        setDrawerNode(null);
        setDetail(null);
        setError(null);
    };

    const onSaveCapabilities = (capabilities: string[], pinned: boolean) => {
        startTransition(async () => {
            const result = await updateFleetNodeAction(node.id, {
                capabilities,
                capabilitiesPinned: pinned,
            });
            if (!result.success) return void toast.error(result.error);
            settle(result.data);
            toast.success(tFleet('capabilities.saved'));
        });
    };

    const onSaveCostCeiling = (dailyCostCeilingCents: number | null) => {
        startTransition(async () => {
            const result = await updateFleetNodeAction(node.id, { dailyCostCeilingCents });
            if (!result.success) return void toast.error(result.error);
            settle(result.data);
            toast.success(
                dailyCostCeilingCents === null
                    ? tFleet('costCeiling.nodeCleared')
                    : tFleet('costCeiling.nodeSaved'),
            );
        });
    };

    const onSaveLimitCeiling = (ceiling: FleetNodeLimitCeiling) => {
        startTransition(async () => {
            const result = await setFleetNodeLimitCeilingAction(node.id, ceiling);
            if (!result.success) return void toast.error(result.error);
            settle(result.data);
            toast.success(
                isEmptyLimitCeiling(ceiling) ? tFleet('limits.cleared') : tFleet('limits.saved'),
            );
        });
    };

    const onClearModelThrottle = (provider: string | null) => {
        startTransition(async () => {
            const result = await clearFleetNodeModelThrottleAction(node.id, provider);
            if (!result.success) return void toast.error(result.error);
            settle(result.data);
            toast.success(tFleet('modelThrottles.cleared'));
        });
    };

    const onDrain = (drain: boolean) => {
        startTransition(async () => {
            const result = await drainFleetNodeAction(node.id, drain);
            if (!result.success) return void toast.error(result.error);
            settle(result.data.node);
            toast.success(
                drain
                    ? tFleet('controls.drained', { count: result.data.releasedJobs })
                    : tFleet('controls.undrained'),
            );
        });
    };

    const onRotate = () => {
        startTransition(async () => {
            const result = await rotateFleetNodeCredentialAction(node.id);
            if (!result.success) return void toast.error(result.error);
            // The replacement token is returned exactly once: close the panel
            // and put it in front of the person straight away.
            close();
            setIssued(result.data);
            toast.success(tFleet('controls.rotated'));
            router.refresh();
        });
    };

    return (
        <section
            aria-labelledby="fleet-computer-machine-heading"
            className="rounded-xl border border-border dark:border-border-dark p-5 space-y-3"
            data-testid="fleet-computer-machine-settings"
        >
            <h2
                id="fleet-computer-machine-heading"
                className="text-sm font-semibold text-text dark:text-text-dark"
            >
                {t('title')}
            </h2>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('body')}</p>
            <Button
                variant="secondary"
                onClick={open}
                disabled={isPending && drawerNode === null}
                data-testid="fleet-computer-machine-open"
            >
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
                {t('open')}
            </Button>

            <FleetNodeDrawer
                node={drawerNode}
                detail={detail}
                loading={loading}
                error={error}
                isPending={isPending}
                onClose={close}
                onSaveCapabilities={onSaveCapabilities}
                onSaveCostCeiling={onSaveCostCeiling}
                onSaveLimitCeiling={onSaveLimitCeiling}
                onClearModelThrottle={onClearModelThrottle}
                onRotate={onRotate}
                onDrain={onDrain}
            />

            <Dialog open={issued !== null} onOpenChange={(next) => !next && setIssued(null)}>
                <DialogContent className="max-w-2xl">
                    <DialogClose onClose={() => setIssued(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {tFleet('controls.rotatedTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    {issued && (
                        <FleetEnrollHandoff
                            issued={issued}
                            apiBaseUrl={apiBaseUrl}
                            desktopDownloadUrl={desktopDownloadUrl}
                            nodeDownloadUrl={nodeDownloadUrl}
                        />
                    )}
                    <DialogFooter>
                        <Button
                            onClick={() => setIssued(null)}
                            data-testid="fleet-computer-rotated-done"
                        >
                            {tFleet('add.done')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
