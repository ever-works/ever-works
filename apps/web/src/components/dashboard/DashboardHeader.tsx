'use client';

import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationDropdown } from './NotificationDropdown';
import { DirectorySwitcher } from './DirectorySwitcher';
import { Tooltip } from '@/components/ui/tooltip';
import { Menu, HelpCircle } from 'lucide-react';

interface DashboardHeaderProps {
    user: AuthUser;
    onMenuClick: () => void;
    isSidebarOpen?: boolean;
    onHelpClick?: () => void;
}

export function DashboardHeader({
    onMenuClick,
    isSidebarOpen = true,
    onHelpClick,
}: DashboardHeaderProps) {
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
                            <Tooltip content="Open sidebar" position="bottom">
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

                        <DirectorySwitcher />
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                        <Tooltip content="Notifications" position="bottom">
                            <div>
                                <NotificationDropdown />
                            </div>
                        </Tooltip>

                        <Tooltip content="Toggle theme" position="bottom">
                            <div>
                                <ThemeToggle
                                    variant="inline"
                                    className="rounded-md text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-secondary-dark"
                                />
                            </div>
                        </Tooltip>

                        <Tooltip content="Help & docs" position="bottom">
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
