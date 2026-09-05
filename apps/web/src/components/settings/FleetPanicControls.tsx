'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type { FleetNodeView } from '@/lib/api/fleet';
import { cancelFleetInFlightAction, drainAllFleetNodesAction } from '@/app/actions/settings/fleet';

interface FleetPanicControlsProps {
    /** The current node list, so the drain button can say how many it will touch. */
    nodes: FleetNodeView[];
    /** Called with the node views the API returned after a drain-all. */
    onNodesDrained: (nodes: FleetNodeView[]) => void;
}

/**
 * Panic controls (EW-778) — the two owner-scoped controls for a bad night.
 *
 * They are two CARDS, two BUTTONS and two CONFIRM DIALOGS on purpose,
 * because they are two different decisions:
 *
 *   1. **Drain all nodes** — every enrolled node is disabled and its
 *      in-flight claims go back to the queue. Nothing is aborted; the
 *      work waits for a node that may take it. This is the one to reach
 *      for first.
 *   2. **Cancel in-flight work** — aborts the fleet jobs running right
 *      now and cancels the agent runs behind them. Its copy says
 *      "aborts" in so many words, it has its own confirmation, and
 *      draining never triggers it. The optional checkbox extends it to
 *      queued jobs nothing has started — the rows a drain just returned
 *      to the pool are a separate decision again.
 *
 * The platform-wide stop flag (set / clear) is an operator control and
 * deliberately NOT on this page; the banner above shows it when set.
 */
export function FleetPanicControls({ nodes, onNodesDrained }: FleetPanicControlsProps) {
    const t = useTranslations('dashboard.settings.fleet.panic');
    const [isPending, startTransition] = useTransition();
    const [drainOpen, setDrainOpen] = useState(false);
    const [cancelOpen, setCancelOpen] = useState(false);
    const [includeQueued, setIncludeQueued] = useState(false);

    const drainable = useMemo(
        () =>
            nodes.filter(
                (node) =>
                    node.persisted && node.status !== 'enrolling' && node.status !== 'disabled',
            ).length,
        [nodes],
    );

    const handleDrainAll = () => {
        startTransition(async () => {
            const result = await drainAllFleetNodesAction();
            if (result.success) {
                onNodesDrained(result.data.nodes);
                setDrainOpen(false);
                toast.success(
                    t('drainAll.done', {
                        nodes: result.data.drainedNodes,
                        jobs: result.data.releasedJobs,
                    }),
                );
                if (result.data.auditFailed) toast.error(t('auditFailed'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const closeCancel = () => {
        setCancelOpen(false);
        setIncludeQueued(false);
    };

    const handleCancelInFlight = () => {
        startTransition(async () => {
            const result = await cancelFleetInFlightAction({ includeQueued });
            if (result.success) {
                closeCancel();
                toast.success(
                    t('cancelInFlight.done', {
                        cancelled: result.data.cancelled,
                        requested: result.data.requested,
                        runs: result.data.runsCancelled,
                    }),
                );
                if (result.data.auditFailed) toast.error(t('auditFailed'));
            } else {
                toast.error(result.error);
            }
        });
    };

    return (
        <div className="space-y-3" data-testid="fleet-panic-section">
            <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark max-w-2xl">
                {t('description')}
            </p>

            <div className="grid gap-3 md:grid-cols-2">
                <div className="p-4 rounded-lg border border-border dark:border-border-dark space-y-3">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('drainAll.button')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('drainAll.hint')}
                    </p>
                    <Button
                        variant="secondary"
                        onClick={() => setDrainOpen(true)}
                        disabled={isPending || drainable === 0}
                        data-testid="fleet-drain-all"
                    >
                        {t('drainAll.button')}
                    </Button>
                    {drainable === 0 && (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="fleet-drain-all-none"
                        >
                            {t('drainAll.none')}
                        </p>
                    )}
                </div>

                <div className="p-4 rounded-lg border border-danger/30 space-y-3">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('cancelInFlight.button')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('cancelInFlight.hint')}
                    </p>
                    <Button
                        variant="danger"
                        onClick={() => setCancelOpen(true)}
                        disabled={isPending}
                        data-testid="fleet-cancel-in-flight"
                    >
                        <Ban className="w-4 h-4" />
                        {t('cancelInFlight.button')}
                    </Button>
                </div>
            </div>

            {/* Drain all — confirm. Says explicitly that nothing is aborted. */}
            <Dialog open={drainOpen} onOpenChange={(open) => !open && setDrainOpen(false)}>
                <DialogContent>
                    <DialogClose onClose={() => setDrainOpen(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('drainAll.confirmTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-drain-all-body"
                    >
                        {t('drainAll.confirmBody', { count: drainable })}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setDrainOpen(false)}>
                            {t('drainAll.cancel')}
                        </Button>
                        <Button
                            onClick={handleDrainAll}
                            loading={isPending}
                            data-testid="fleet-drain-all-confirm"
                        >
                            {t('drainAll.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Cancel in-flight — its OWN confirm, with "aborts" in the copy. */}
            <Dialog open={cancelOpen} onOpenChange={(open) => !open && closeCancel()}>
                <DialogContent>
                    <DialogClose onClose={closeCancel} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('cancelInFlight.confirmTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-cancel-in-flight-body"
                    >
                        {t('cancelInFlight.confirmBody')}
                    </p>
                    <Checkbox
                        label={t('cancelInFlight.includeQueued')}
                        checked={includeQueued}
                        onChange={(event) => setIncludeQueued(event.target.checked)}
                        data-testid="fleet-cancel-include-queued"
                    />
                    <DialogFooter>
                        <Button variant="secondary" onClick={closeCancel}>
                            {t('cancelInFlight.cancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleCancelInFlight}
                            loading={isPending}
                            data-testid="fleet-cancel-in-flight-confirm"
                        >
                            {t('cancelInFlight.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
