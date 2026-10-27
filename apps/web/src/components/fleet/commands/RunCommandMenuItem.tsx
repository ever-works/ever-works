'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TerminalSquare } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ROUTES } from '@/lib/constants';
import type { FleetComputerActionProps } from '../registry';

/**
 * Commands on computers (FL-12 P2, spec §5.3, T-22) — "Run a command…" in the
 * computer page's ⋯ menu. It opens the hub's Commands tab with this computer
 * the only one preselected (`/fleet/commands?node=<id>`); there is no Commands
 * tab on the computer page (CONTRACTS §11.1 fixes that list). Disabled with
 * the reason when the computer's `commands` audience leaves the viewer out.
 */
export default function RunCommandMenuItem({ node, allowed = true }: FleetComputerActionProps) {
    const t = useTranslations('fleet.commands.menu');
    const href = `${ROUTES.DASHBOARD_FLEET_COMMANDS}?node=${encodeURIComponent(node.id)}`;
    if (!allowed) {
        return (
            <DropdownMenuItem disabled>
                <span
                    className="flex flex-col items-start text-left"
                    data-testid="fleet-computer-menu-run-command"
                >
                    <span className="flex items-center gap-2">
                        <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                        {t('runCommand')}
                    </span>
                    <span className="pl-6 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('notAllowed', { name: node.name })}
                    </span>
                </span>
            </DropdownMenuItem>
        );
    }
    return (
        <DropdownMenuItem asChild>
            <Link
                href={href}
                className="flex items-center gap-2"
                data-testid="fleet-computer-menu-run-command"
            >
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                {t('runCommand')}
            </Link>
        </DropdownMenuItem>
    );
}
