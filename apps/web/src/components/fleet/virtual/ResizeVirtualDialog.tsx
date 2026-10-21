'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FLEET_VIRTUAL_CPU_CHOICES, FLEET_VIRTUAL_MEMORY_GIB_CHOICES } from '@ever-works/contracts';
import { resizeFleetVirtualAction } from '@/app/actions/fleet/virtual';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Virtual computers, phase 3 (FL-16, spec §5.5, FR-38) — **Resize…** for a
 * STOPPED virtual computer: CPUs 2 / 4 / 8 and memory 4 / 8 / 16 GB, the
 * creation choices. The dialog is the confirmation (`confirm: true`); the new
 * size applies from its next start.
 */
export function ResizeVirtualDialog({
    open,
    hostNodeId,
    childNodeId,
    name,
    cpus,
    memoryGiB,
    onClose,
    onDone,
}: {
    open: boolean;
    hostNodeId: string;
    childNodeId: string;
    name: string;
    cpus: number;
    memoryGiB: number;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations('fleet.virtual.resize');
    const [nextCpus, setNextCpus] = useState(cpus);
    const [nextMemory, setNextMemory] = useState(memoryGiB);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (open) {
            setNextCpus(cpus);
            setNextMemory(memoryGiB);
        }
    }, [open, cpus, memoryGiB]);

    const unchanged = nextCpus === cpus && nextMemory === memoryGiB;
    const apply = () =>
        startTransition(async () => {
            const result = await resizeFleetVirtualAction(hostNodeId, childNodeId, {
                cpus: nextCpus as 2 | 4 | 8,
                memoryGiB: nextMemory as 4 | 8 | 16,
            });
            if (result.ok) {
                toast.success(t('started', { name }));
                onDone();
                onClose();
            } else {
                toast.error(result.error.hint || t('failed'));
            }
        });

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent data-testid="fleet-virtual-resize-dialog">
                <DialogHeader>
                    <DialogTitle>{t('title', { name })}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 text-sm">
                    <fieldset className="flex items-center gap-3">
                        <legend className="sr-only">{t('cpus')}</legend>
                        <span className="w-20 font-medium" aria-hidden>
                            {t('cpus')}
                        </span>
                        {FLEET_VIRTUAL_CPU_CHOICES.map((choice) => (
                            <label key={choice} className="inline-flex items-center gap-1">
                                <input type="radio" checked={nextCpus === choice} onChange={() => setNextCpus(choice)} />
                                {choice}
                            </label>
                        ))}
                    </fieldset>
                    <fieldset className="flex items-center gap-3">
                        <legend className="sr-only">{t('memory')}</legend>
                        <span className="w-20 font-medium" aria-hidden>
                            {t('memory')}
                        </span>
                        {FLEET_VIRTUAL_MEMORY_GIB_CHOICES.map((choice) => (
                            <label key={choice} className="inline-flex items-center gap-1">
                                <input type="radio" checked={nextMemory === choice} onChange={() => setNextMemory(choice)} />
                                {choice} GB
                            </label>
                        ))}
                    </fieldset>
                </div>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button type="button" variant="ghost">
                            {t('cancel')}
                        </Button>
                    </DialogClose>
                    <Button type="button" onClick={apply} disabled={pending || unchanged} data-testid="fleet-virtual-resize-apply">
                        {t('apply')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
