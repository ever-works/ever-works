'use client';

import { AuthUser } from '@/lib/auth';
import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ThemeToggle } from '@/components/theme-toggle';

interface DashboardHeaderProps {
    user: AuthUser;
    onMenuClick: () => void;
    isSidebarOpen?: boolean;
}

export function DashboardHeader({ onMenuClick, isSidebarOpen = true }: DashboardHeaderProps) {
    const [notificationsOpen, setNotificationsOpen] = useState(false);

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
                                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                                />
                            </svg>
                        </button>

                        <div className="relative">
                            <button
                                onClick={() => setNotificationsOpen(!notificationsOpen)}
                                className={cn(
                                    'p-2 rounded-md relative',
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
                                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                                    />
                                </svg>

                                {/* <span className="absolute top-1 right-1 w-2 h-2 bg-danger rounded-full"></span> */}
                            </button>

                            {notificationsOpen && (
                                <div
                                    className={cn(
                                        'absolute right-0 mt-2 w-80 rounded-lg shadow-lg z-50',
                                        'bg-white dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                    )}
                                >
                                    <div className="p-4 border-b border-border dark:border-border-dark">
                                        <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                                            Notifications
                                        </h3>
                                    </div>
                                    <div className="p-4">
                                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                            No new notifications
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>

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
