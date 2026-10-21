'use client';

import { ChevronDown, Cloud, Layers, Laptop, Plus, Server, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import '../modules';
import {
    getAddComputerItems,
    type FleetAddComputerItemRegistration,
    type FleetFeatureFlags,
} from '../registry';

/** Where "Add computer ▾" sends a kind: the Computers tab, which opens the existing Add flow. */
export function fleetAddComputerHref(kind: 'node' | 'desktop-node'): string {
    return `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=${kind}`;
}

const ICONS: Readonly<Record<NonNullable<FleetAddComputerItemRegistration['icon']>, LucideIcon>> = {
    server: Server,
    laptop: Laptop,
    virtual: Layers,
    cloud: Cloud,
};

const PRIMARY =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-8 px-3 text-xs bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark';

/**
 * Fleet hub (FL-01, spec §5.2) — "Add computer ▾": the two kinds of computer a
 * person can enrol (a command-line node, the desktop app), each opening the
 * EXISTING Add flow — the one-time token, the ready-to-run command, the QR
 * code and the hand-off file — on the Computers tab, preset to that kind;
 * then any entry another epic registered (`registerAddComputerItem`: FL-16's
 * virtual computers, FL-17's cloud computers), behind its flag.
 */
export function FleetAddComputerMenu({ flags = {} }: { flags?: FleetFeatureFlags }) {
    const t = useTranslations('fleet.hub');
    const tRoot = useTranslations();
    const extra = getAddComputerItems(flags);
    return (
        <div className="w-auto" data-testid="fleet-add-computer">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className={PRIMARY}
                        aria-label={t('addComputerMenuLabel')}
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('addComputer')}
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                        <Link
                            href={fleetAddComputerHref('node')}
                            className="flex items-center gap-2"
                            data-testid="fleet-add-computer-node"
                        >
                            <Server className="w-4 h-4" aria-hidden="true" />
                            {t('addKinds.node')}
                        </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <Link
                            href={fleetAddComputerHref('desktop-node')}
                            className="flex items-center gap-2"
                            data-testid="fleet-add-computer-desktop-node"
                        >
                            <Laptop className="w-4 h-4" aria-hidden="true" />
                            {t('addKinds.desktopNode')}
                        </Link>
                    </DropdownMenuItem>
                    {extra.map((item) => {
                        const Icon = ICONS[item.icon ?? 'server'];
                        return (
                            <DropdownMenuItem asChild key={item.id}>
                                <Link
                                    href={item.href}
                                    className="flex items-center gap-2"
                                    data-testid={`fleet-add-computer-${item.id}`}
                                >
                                    <Icon className="w-4 h-4" aria-hidden="true" />
                                    {tRoot(item.labelKey as never)}
                                </Link>
                            </DropdownMenuItem>
                        );
                    })}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
