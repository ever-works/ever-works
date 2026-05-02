'use client';

import { useTranslations } from 'next-intl';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationDropdown } from './NotificationDropdown';
import { WorkSwitcher } from './WorkSwitcher';
import { Tooltip } from '@/components/ui/tooltip';
import { Menu, HelpCircle, Sparkles, X } from 'lucide-react';

interface DashboardHeaderOnboardingBadge {
    currentStep: number;
    totalSteps: number;
    onOpen: () => void;
    onDismiss: () => void;
}

interface DashboardHeaderProps {
    user: AuthUser;
    onMenuClick: () => void;
    isSidebarOpen?: boolean;
    onHelpClick?: () => void;
    onboardingBadge?: DashboardHeaderOnboardingBadge;
}

export function DashboardHeader({
    onMenuClick,
    isSidebarOpen = true,
    onHelpClick,
    onboardingBadge,
}: DashboardHeaderProps) {
    const t = useTranslations('dashboard.header');
    const tTheme = useTranslations('common.theme');

    return (
        <header
            className={cn(
                'border-b',
                'bg-white dark:bg-surface-dark',
                'border-border dark:border-border-dark',
            )}
        >
            <div className="px-4 @sm/main:px-6 @3xl/main:px-8">
                <div className="flex items-center justify-between h-16">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                        {!isSidebarOpen && (
                            <Tooltip content={t('tooltips.openSidebar')} position="bottom">
                                <button
                                    onClick={onMenuClick}
                                    className={cn(
                                        'p-2 rounded-md xl:hidden',
                                        'text-text-secondary dark:text-text-secondary-dark',
                                        'hover:text-text dark:hover:text-text-dark',
                                        'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                    )}
                                >
                                    <Menu className="w-5 h-5" />
                                </button>
                            </Tooltip>
                        )}

                        <WorkSwitcher />

                        {onboardingBadge && (
                            <div className="flex max-w-[170px] items-center overflow-hidden rounded-full border border-border bg-surface-secondary/70 text-xs text-text-secondary shadow-sm dark:border-border-dark dark:bg-surface-secondary-dark/60 dark:text-text-secondary-dark sm:max-w-none">
                                <button
                                    type="button"
                                    onClick={onboardingBadge.onOpen}
                                    className="inline-flex min-w-0 items-center gap-2 px-3 py-1.5 font-medium transition-colors hover:bg-surface dark:hover:bg-surface-dark"
                                >
                                    <Sparkles className="h-3.5 w-3.5" />
                                    <span className="truncate whitespace-nowrap">
                                        {t('onboarding.badge', {
                                            currentStep: onboardingBadge.currentStep,
                                            totalSteps: onboardingBadge.totalSteps,
                                        })}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={onboardingBadge.onDismiss}
                                    className="border-l border-border px-2 py-1.5 text-text-muted transition-colors hover:bg-surface hover:text-text dark:border-border-dark dark:text-text-muted-dark dark:hover:bg-surface-dark dark:hover:text-text-dark"
                                    aria-label={t('onboarding.dismiss')}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                        <div className="mt-2">
                            <NotificationDropdown />
                        </div>

                        <Tooltip content={tTheme('toggle')} position="bottom">
                            <div>
                                <ThemeToggle
                                    variant="inline"
                                    className="rounded-md text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-secondary-dark"
                                />
                            </div>
                        </Tooltip>

                        <Tooltip content={t('tooltips.help')} position="bottom">
                            <button
                                onClick={onHelpClick}
                                className={cn(
                                    'rounded-md cursor-pointer',
                                    'text-text-secondary dark:text-text-secondary-dark',
                                    'hover:text-text dark:hover:text-text-dark',
                                    'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                )}
                            >
                                <HelpCircle className="w-3.5 h-3.5" />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </header>
    );
}
