'use client';

import { useState } from 'react';
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
import { FaviconEverWorkImage, LogoEverWorkImage } from '../logos';
import { CreateOrganizationModal } from '../organizations/CreateOrganizationModal';
import type { WorkConfig } from '@/lib/api';
import type { OrganizationResponse } from '@ever-works/contracts/api';

interface WorkspaceSwitcherProps {
    /** Site config passed through to the inline logo / favicon. */
    config?: WorkConfig | null;
    /** Tailwind class for the inline wordmark image. */
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
 * showing the spinning favicon + the active Organization (or the
 * Ever Works wordmark when the user has zero Orgs) with a popover to
 * switch between Orgs or create a new one.
 *
 * The whole row is a single dropdown trigger:
 *
 *   [spinning favicon] [label] [chevron]
 *
 * The trigger renders in every state (including zero-org), so the user
 * can always reach "+ Create Organization" — pre-fix, the zero-org
 * branch fell back to a bare logo with no popover and clicking it did
 * nothing useful.
 *
 * Trigger label by state:
 *
 * | Org count | Label                | Popover                         |
 * |-----------|----------------------|---------------------------------|
 * | 0         | Wordmark image       | "+ Create Organization" only    |
 * | 1+        | Active org name      | Org list + "+ Create"           |
 */
export function WorkspaceSwitcher({ config, logoClassName }: WorkspaceSwitcherProps) {
    const t = useTranslations('organizations.switcher');
    const router = useRouter();
    const { organizations, isLoading } = useOrganizations();
    const { activeOrganization } = useActiveScope();
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const hasOrgs = organizations.length > 0;
    // Pick the trigger label org — use the active one (from URL slug) if
    // resolved, otherwise fall back to the first org so the chip never
    // shows up empty when orgs exist.
    const triggerOrg: OrganizationResponse | null = hasOrgs
        ? (activeOrganization ?? organizations[0])
        : null;

    const handleSelectOrg = (org: OrganizationResponse) => {
        router.push(`/${org.slug}/dashboard`);
    };

    const handleCreateOrg = () => {
        setIsCreateOpen(true);
    };

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    className={cn(
                        'w-full rounded-md transition-colors cursor-pointer',
                        'focus:outline-none focus-visible:outline-none',
                        'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                        'px-1.5 py-1',
                    )}
                    aria-label={t('heading')}
                >
                    <div className="flex items-center gap-1.5 w-full min-w-0">
                        <FaviconEverWorkImage
                            config={config}
                            className="w-9 h-9 max-h-none shrink-0"
                        />
                        {triggerOrg ? (
                            <span className="flex-1 min-w-0 text-left text-sm font-medium text-text dark:text-text-dark truncate">
                                {pickLabel(triggerOrg)}
                            </span>
                        ) : (
                            <LogoEverWorkImage
                                config={config}
                                className={cn('flex-1 min-w-0', logoClassName)}
                            />
                        )}
                        <ChevronsUpDown
                            className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                            strokeWidth={1.5}
                            aria-hidden="true"
                        />
                    </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="w-60">
                    <DropdownMenuLabel>
                        {hasOrgs ? t('heading') : t('bareTenant')}
                    </DropdownMenuLabel>
                    {hasOrgs &&
                        organizations.map((org) => {
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
                    {hasOrgs && <DropdownMenuSeparator />}
                    {isLoading && !hasOrgs && (
                        <DropdownMenuItem disabled className="text-text-muted">
                            {t('loading')}
                        </DropdownMenuItem>
                    )}
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
            <CreateOrganizationModal open={isCreateOpen} onOpenChange={setIsCreateOpen} />
        </>
    );
}
