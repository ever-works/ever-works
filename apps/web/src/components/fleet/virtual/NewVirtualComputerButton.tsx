'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers } from 'lucide-react';
import { FLEET_DOCKER_CAPABILITY } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import type { FleetComputerActionProps } from '../registry';
import { NewVirtualComputerDialog } from './NewVirtualComputerDialog';
import { mayBeHost } from './virtual.shared';

/**
 * Virtual computers (FL-16, spec FR-1, S8) — "New virtual computer…" in a
 * host's page header, opening the dialog with this computer preselected.
 * Shown only on a computer that could host one at all (never a virtual one,
 * never the desktop app) and that advertises Docker; disabled with the reason
 * when the viewer is outside its `machines` audience ("Only the owner of
 * build-01 can create computers on it"). The dialog itself greys the host when
 * it cannot serve the chosen system right now (offline, management off, …).
 */
export default function NewVirtualComputerButton({ node, allowed = true }: FleetComputerActionProps) {
    const t = useTranslations('fleet.virtual');
    const router = useRouter();
    const [open, setOpen] = useState(false);
    if (!mayBeHost(node) || !(node.capabilities ?? []).includes(FLEET_DOCKER_CAPABILITY)) return null;
    return (
        <>
            <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(true)}
                disabled={!allowed}
                title={allowed ? undefined : t('reasons.permissionDenied', { name: node.name })}
                data-testid="fleet-virtual-new-on-host"
            >
                <Layers className="h-4 w-4" aria-hidden="true" />
                {t('menu.newOnHost')}
            </Button>
            <NewVirtualComputerDialog
                open={open}
                hostNodeId={node.id}
                onClose={() => setOpen(false)}
                onCreated={() => router.refresh()}
            />
        </>
    );
}
