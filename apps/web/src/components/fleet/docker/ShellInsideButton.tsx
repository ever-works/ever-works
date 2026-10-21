'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { execInFleetContainerAction, fleetContainerShellsAction } from '@/app/actions/fleet/machine';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Shell inside (FL-09 P3, spec S13, FR-35) — "Shell inside ▾": asks the
 * container which shells it has (`bash`, `sh`), starts an owner Session
 * whose process is that shell inside the container, and opens it in the
 * terminal pane like any other Session (FL-04). Ending the Session ends the
 * shell. Plain class: no confirmation (CONTRACTS §2.2, FR-17).
 */
export function ShellInsideButton({
    nodeId,
    container,
    disabled,
}: {
    nodeId: string;
    /** The container id or name. */
    container: string;
    disabled?: boolean;
}) {
    const t = useTranslations('fleet.docker.shell');
    const router = useRouter();
    const [shells, setShells] = useState<('bash' | 'sh')[] | null>(null);
    const [isPending, startTransition] = useTransition();

    const loadShells = () => {
        if (shells) return;
        startTransition(async () => {
            const result = await fleetContainerShellsAction(nodeId, container);
            setShells(result.ok && result.data.shells.length > 0 ? result.data.shells : ['sh']);
        });
    };

    const open = (shell: 'bash' | 'sh') => {
        startTransition(async () => {
            const result = await execInFleetContainerAction(nodeId, { container, shell });
            if (!result.ok) {
                toast.error(result.error.hint ? t('failedWith', { hint: result.error.hint }) : t('failed'));
                return;
            }
            router.push(ROUTES.DASHBOARD_FLEET_SESSION(result.data.sessionId));
        });
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled || isPending}
                    onClick={loadShells}
                    data-testid="fleet-docker-shell"
                >
                    {t('label')}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {(shells ?? ['bash', 'sh']).map((shell) => (
                    <DropdownMenuItem key={shell} disabled={isPending} onClick={() => open(shell)}>
                        {shell}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
