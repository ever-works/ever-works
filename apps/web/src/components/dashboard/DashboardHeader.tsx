'use client';

import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationDropdown } from './NotificationDropdown';

interface DashboardHeaderProps {
    user: AuthUser;
    onMenuClick: () => void;
    isSidebarOpen?: boolean;
}

export function DashboardHeader({ onMenuClick, isSidebarOpen = true }: DashboardHeaderProps) {
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
                                <svg
                                    className="w-6 h-6"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M4 6h16M4 12h16M4 18h16"
                                    />
                                </svg>
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
                            className={cn(
                                'p-2 rounded-md',
                                'text-text-secondary dark:text-text-secondary-dark',
                                'hover:text-text dark:hover:text-text-dark',
                                'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                            )}
                        >
                            <svg
                                className="w-6 h-6"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </header>
    );
}
