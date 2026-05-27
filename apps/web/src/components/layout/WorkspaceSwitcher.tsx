'use client';

import { useTranslations } from 'next-intl';
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { useActiveScope } from '@/lib/hooks/use-active-scope';
import { LogoEverWork } from '../logos';
import type { WorkConfig } from '@/lib/api';
import type { OrganizationResponse } from '@ever-works/contracts/api';

interface WorkspaceSwitcherProps {
    /** Site config passed through to the empty-state `<LogoEverWork>`. */
    config?: WorkConfig | null;
    /** Tailwind class for the empty-state logo. Lets the sidebar size it. */
    logoClassName?: string;
}

function pickInitial(org: OrganizationResponse): string {
    const source = org.displayName ?? org.slug ?? '';
    return source.charAt(0).toUpperCase() || '?';
}

function pickLabel(org: OrganizationResponse): string {
    return org.displayName ?? org.slug;
}

/**
 * Avatar circle for an Organization. Mimics shadcn `sidebar-07`
 * TeamSwitcher's visual: a colored square with the first initial.
 * `Building2` is used as a fallback when the initial would be empty.
 */
function OrgAvatar({ org, size = 'sm' }: { org: OrganizationResponse; size?: 'sm' | 'xs' }) {
    const initial = pickInitial(org);
    return (
        <div
            className={cn(
                'shrink-0 inline-flex items-center justify-center rounded-md',
                'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                'text-text dark:text-text-dark',
                'font-semibold',
                size === 'sm' ? 'w-7 h-7 text-xs' : 'w-5 h-5 text-[10px]',
            )}
            aria-hidden="true"
        >
            {initial || <Building2 className="w-3.5 h-3.5" strokeWidth={1.5} />}
        </div>
    );
}

/**
 * EW-660 (Tenants & Organizations Phase 8) — top-of-sidebar component
 * showing the active Organization (or the bare Ever Works logo when
 * the user has zero Orgs) with a popover to switch between Orgs.
 *
 * Behavior matrix:
 *
 * | Org count | Trigger UI                       | Popover                   |
 * |-----------|----------------------------------|---------------------------|
 * | 0         | `<LogoEverWork />` unmodified    | none (no chevron)         |
 * | 1+        | Chip: [avatar] [name] [chevron]  | List of orgs + create row |
 *
 * The empty-state branch renders `<LogoEverWork />` AS-IS so the
 * sidebar visuals for the no-org majority of users stay pixel-identical
 * (NN #20 — extension, not replacement).
 *
 * Clicking an Org row navigates to `/{org.slug}/dashboard`. Clicking
 * "+ Create Organization" is a stub for Phase 9 — it `console.log`s
 * and the modal lands in EW-661.
 */
export function WorkspaceSwitcher({ config, logoClassName }: WorkspaceSwitcherProps) {
    const t = useTranslations('organizations.switcher');
    const router = useRouter();
    const { organizations, isLoading } = useOrganizations();
    const { activeOrganization } = useActiveScope();

    // Empty state: no orgs yet → render the existing logo unmodified.
    // We intentionally treat `isLoading` as empty for the initial
    // render so we don't flash a "Loading…" chip in the most common
    // case (zero orgs). Once the fetch resolves and orgs > 0, the
    // chip appears.
    if (!isLoading && organizations.length === 0) {
        return <LogoEverWork config={config} className={logoClassName} />;
    }

    // Loading state, but only on the very first fetch when we don't
    // yet know whether the user has orgs. Render a minimal skeleton
    // (same width as the chip) so layout doesn't jump.
    if (isLoading && organizations.length === 0) {
        return (
            <div
                className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-md',
                    'text-text-muted dark:text-text-muted-dark',
                    'text-sm',
                )}
                aria-busy="true"
            >
                <span className="w-7 h-7 rounded-md bg-surface-tertiary/60 dark:bg-surface-tertiary-dark/60 animate-pulse" />
                <span className="truncate">{t('loading')}</span>
            </div>
        );
    }

    // Active state: 1+ orgs. Pick the trigger label — if we know the
    // active Org from the URL slug, use it; otherwise fall back to the
    // first org in the list so the chip never shows up empty.
    const triggerOrg = activeOrganization ?? organizations[0];

    const handleSelectOrg = (org: OrganizationResponse) => {
        router.push(`/${org.slug}/dashboard`);
    };

    const handleCreateOrg = () => {
        // Phase 9 — EW-661 lands the modal. For now we log so the
        // wiring point is explicit and easy to grep for during the
        // next PR.
        console.log('TODO Phase 9: open CreateOrganizationModal');
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className={cn(
                    'w-full rounded-md transition-colors cursor-pointer',
                    'focus:outline-none focus-visible:outline-none',
                    'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                    'px-2 py-1.5',
                )}
            >
                <div className="flex items-center gap-2 w-full">
                    <OrgAvatar org={triggerOrg} />
                    <span className="flex-1 min-w-0 text-left text-sm font-medium text-text dark:text-text-dark truncate">
                        {pickLabel(triggerOrg)}
                    </span>
                    <ChevronsUpDown
                        className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                        strokeWidth={1.5}
                        aria-hidden="true"
                    />
                </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="w-60">
                <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
                {organizations.map((org) => {
                    const isActive = activeOrganization?.id === org.id;
                    return (
                        <DropdownMenuItem
                            key={org.id}
                            onClick={() => handleSelectOrg(org)}
                            className="cursor-pointer"
                        >
                            <div className="flex items-center gap-2 w-full">
                                <OrgAvatar org={org} size="xs" />
                                <span className="flex-1 min-w-0 truncate text-text dark:text-text-dark">
                                    {pickLabel(org)}
                                </span>
                                {isActive && (
                                    <Check
                                        className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                        strokeWidth={1.5}
                                        aria-label="Active organization"
                                    />
                                )}
                            </div>
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleCreateOrg} className="cursor-pointer">
                    <div className="flex items-center gap-2 w-full">
                        <span className="w-5 h-5 inline-flex items-center justify-center shrink-0">
                            <Plus
                                className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                strokeWidth={1.5}
                            />
                        </span>
                        <span className="flex-1 min-w-0 truncate text-text dark:text-text-dark">
                            {t('createNew')}
                        </span>
                    </div>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
