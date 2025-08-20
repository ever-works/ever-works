'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { ChatInterface } from '@/components/ai/ChatInterface';
import { APP_NAME, ROUTES } from '@/lib/constants';
import { usePathname } from '@/i18n/navigation';

interface DashboardSidebarProps {
    user: AuthUser;
    isOpen: boolean;
    onToggle: () => void;
}

export function DashboardSidebar({ user, isOpen, onToggle }: DashboardSidebarProps) {
    const pathname = usePathname();
    const [activeMode, setActiveMode] = useState<'menu' | 'chat'>('menu');
    const [isPending, startTransition] = useTransition();

    const handleLogout = async () => {
        startTransition(async () => {
            await logout();
        });
    };

    const navigation = [
        { name: 'Dashboard', href: ROUTES.DASHBOARD, icon: HomeIcon },
        { name: 'Directories', href: ROUTES.DASHBOARD_DIRECTORIES, icon: FolderIcon },
        { name: 'Analytics', href: ROUTES.DASHBOARD_ANALYTICS, icon: ChartIcon },
        { name: 'Settings', href: ROUTES.DASHBOARD_SETTINGS, icon: SettingsIcon },
    ];

    return (
        <aside
            className={cn(
                'fixed lg:relative top-0 h-full z-50',
                'transition-all duration-300 ease-in-out',
                'bg-surface-secondary dark:bg-surface-secondary-dark',
                'border-r border-border dark:border-border-dark',
                'w-80 flex-shrink-0',
                isOpen ? 'left-0' : '-left-80 lg:ml-[-20rem]',
                'xl:!left-0 xl:!ml-0', // Always visible on XL screens
            )}
        >
            <div className="flex flex-col h-full">
                <div className={cn('h-16 flex items-center px-6')}>
                    <div className="flex items-center justify-between w-full">
                        <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                            {APP_NAME}
                        </h1>

                        <button
                            onClick={onToggle}
                            className={cn(
                                'p-2 rounded-md transition-colors xl:hidden',
                                'text-text-muted dark:text-text-muted-dark',
                                'hover:text-text dark:hover:text-text-dark',
                                'hover:bg-surface dark:hover:bg-surface-dark',
                            )}
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="px-6 py-3">
                    <div className="flex bg-surface dark:bg-surface-dark rounded-lg p-1">
                        <button
                            onClick={() => setActiveMode('menu')}
                            className={cn(
                                'flex-1 py-2 text-center text-sm font-medium transition-colors rounded-md',
                                activeMode === 'menu'
                                    ? 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text dark:text-text-dark'
                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            Menu
                        </button>
                        <button
                            onClick={() => setActiveMode('chat')}
                            className={cn(
                                'flex-1 py-2 text-center text-sm font-medium transition-colors rounded-md',
                                activeMode === 'chat'
                                    ? 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text dark:text-text-dark'
                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            AI Chat
                        </button>
                    </div>
                </div>

                {activeMode === 'chat' ? (
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                        <ChatInterface />
                    </div>
                ) : (
                    <>
                        <div className="px-6 pb-4">
                            <Link
                                href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                className={cn(
                                    'w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors',
                                    'bg-primary hover:bg-primary-hover text-white',
                                )}
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M12 4v16m8-8H4"
                                    />
                                </svg>
                                <span className="font-medium">New Directory</span>
                            </Link>
                        </div>

                        <nav className="flex-1 px-6 overflow-y-auto min-h-0">
                            <ul className="space-y-1 pb-4">
                                {navigation.map((item) => {
                                    const isActive =
                                        pathname === item.href ||
                                        pathname?.startsWith(item.href + '/');
                                    return (
                                        <li key={item.name}>
                                            <Link
                                                href={item.href}
                                                className={cn(
                                                    'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors',
                                                    isActive
                                                        ? 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-primary'
                                                        : 'text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark hover:text-text dark:hover:text-text-dark',
                                                )}
                                            >
                                                <item.icon className="w-5 h-5" />
                                                <span className="text-sm">{item.name}</span>
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        </nav>

                        <div
                            className={cn(
                                'px-6 py-4',
                                'border-t border-border dark:border-border-dark',
                            )}
                        >
                            <div className="flex items-center gap-3 mb-4">
                                <div
                                    className={cn(
                                        'w-10 h-10 rounded-full flex items-center justify-center',
                                        'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                                    )}
                                >
                                    {user.avatar ? (
                                        <img
                                            src={user.avatar}
                                            alt={user.username}
                                            className="w-full h-full rounded-full"
                                        />
                                    ) : (
                                        <span className="text-sm font-medium text-text dark:text-text-dark">
                                            {user.username.charAt(0).toUpperCase()}
                                        </span>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {user.username}
                                    </p>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {user.email}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </>
                )}

                <div className="px-6 pb-6 mt-auto">
                    <button
                        onClick={handleLogout}
                        disabled={isPending}
                        className={cn(
                            'w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors',
                            'text-danger hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                            isPending && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                            />
                        </svg>
                        <span className="text-sm">{isPending ? 'Signing out...' : 'Sign Out'}</span>
                    </button>
                </div>
            </div>
        </aside>
    );
}

function HomeIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
            />
        </svg>
    );
}

function FolderIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
        </svg>
    );
}

function ChartIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
        </svg>
    );
}

function KeyIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
        </svg>
    );
}

function SettingsIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
        </svg>
    );
}
