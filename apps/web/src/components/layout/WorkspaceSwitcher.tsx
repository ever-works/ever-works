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
    /**
     * Collapsed sidebar variant — renders only the icon trigger (no
     * label, no chevron). The popover behaviour is identical.
     */
    isCollapsed?: boolean;
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
function OrgAvatar({ org, size = 'sm' }: { org: OrganizationResponse; size?: 'sm' | 'xs' | 'md' }) {
    const initial = pickInitial(org);
    const sizeClass =
        size === 'md'
            ? 'w-6 h-6 text-[11px]'
            : size === 'sm'
              ? 'w-7 h-7 text-xs'
              : 'w-5 h-5 text-[10px]';
    return (
        <div
            className={cn(
                'shrink-0 inline-flex items-center justify-center rounded-md',
                'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                'text-text dark:text-text-dark',
                'font-semibold',
                sizeClass,
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
 *   [favicon OR org avatar] [label] [chevron]
 *
 * The trigger renders in every state (including zero-org), so the user
 * can always reach "+ Create Organization" — pre-fix, the zero-org
 * branch fell back to a bare logo with no popover and clicking it did
 * nothing useful.
 *
 * When `isCollapsed`, the trigger renders just the leading icon — the
 * label + chevron are hidden and the dropdown still opens on click.
 * That replaces the pre-fix collapsed-sidebar `<FaviconEverWork>`,
 * which wrapped the favicon in a `<Link>` pointing at the configured
 * site URL (localhost:3000 in dev) and silently swallowed clicks
 * instead of opening the org switcher.
 */
export function WorkspaceSwitcher({
    config,
    logoClassName,
    isCollapsed = false,
}: WorkspaceSwitcherProps) {
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

    // Leading icon: the active org's avatar when one exists, otherwise
    // the spinning Ever Works favicon. Same 24px footprint in both
    // states so the row height doesn't shift when the user picks an org.
    const leadingIcon = triggerOrg ? (
        <OrgAvatar org={triggerOrg} size="md" />
    ) : (
        <FaviconEverWorkImage config={config} className="w-6 h-6 max-h-none shrink-0" />
    );

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    className={cn(
                        'rounded-md transition-colors cursor-pointer',
                        'focus:outline-none focus-visible:outline-none',
                        'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                        isCollapsed ? 'inline-flex p-1' : 'w-full px-1.5 py-1',
                    )}
                    aria-label={t('heading')}
                >
                    <div
                        className={cn(
                            'flex items-center min-w-0',
                            isCollapsed ? 'justify-center' : 'gap-1.5 w-full',
                        )}
                    >
                        {leadingIcon}
                        {!isCollapsed &&
                            (triggerOrg ? (
                                <span className="flex-1 min-w-0 text-left text-sm font-medium text-text dark:text-text-dark truncate">
                                    {pickLabel(triggerOrg)}
                                </span>
                            ) : (
                                <LogoEverWorkImage
                                    config={config}
                                    className={cn('flex-1 min-w-0', logoClassName)}
                                />
                            ))}
                        {!isCollapsed && (
                            <ChevronsUpDown
                                className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                strokeWidth={1.5}
                                aria-hidden="true"
                            />
                        )}
                    </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="w-60">
                    <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
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
