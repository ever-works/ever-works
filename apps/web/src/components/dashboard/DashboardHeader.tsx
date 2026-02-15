'use client';

import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationDropdown } from './NotificationDropdown';
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
            <div className="px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                    <div className="flex items-center">
                        {!isSidebarOpen && (
                            <button
                                onClick={onMenuClick}
                                className={cn(
                                    'p-2 rounded-md xl:hidden',
                                    'text-text-secondary dark:text-text-secondary-dark',
                                    'hover:text-text dark:hover:text-text-dark',
                                    'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                )}
                            >
                                <Menu className="w-6 h-6" />
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-4">
                        <NotificationDropdown />

                        <ThemeToggle
                            variant="inline"
                            className="!p-2 !rounded-md !text-text-secondary dark:!text-text-secondary-dark hover:!text-text dark:hover:!text-text-dark hover:!bg-surface dark:hover:!bg-surface-secondary-dark"
                        />

                        <button
                            onClick={onHelpClick}
                            className={cn(
                                'p-2 rounded-md',
                                'text-text-secondary dark:text-text-secondary-dark',
                                'hover:text-text dark:hover:text-text-dark',
                                'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                            )}
                        >
                            <HelpCircle className="w-6 h-6" />
                        </button>
                    </div>
                </div>
            </div>
        </header>
    );
}
