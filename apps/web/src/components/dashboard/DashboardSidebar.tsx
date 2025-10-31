'use client';

import { useState, useTransition } from 'react';
import Image from 'next/image';
import { AuthUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import { cn } from '@/lib/utils/cn';
import { ChatInterface } from '@/components/ai/ChatInterface';
import { ChatProvider } from '@/components/ai/ChatProvider';
import { APP_NAME, ROUTES } from '@/lib/constants';
import { Link, usePathname } from '@/i18n/navigation';
import { Home, Folder, Settings, LogOut, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface DashboardSidebarProps {
    user: AuthUser;
    isOpen: boolean;
    onToggle: () => void;
}

export function DashboardSidebar({ user, isOpen, onToggle }: DashboardSidebarProps) {
    const pathname = usePathname();
    const [activeMode, setActiveMode] = useState<'menu' | 'chat'>('menu');
    const [isPending, startTransition] = useTransition();
    const [avatarError, setAvatarError] = useState(false);
    const t = useTranslations('dashboard.sidebar');

    const handleLogout = async () => {
        startTransition(async () => {
            await logout();
        });
    };

    const navigation = [
        { name: t('navigation.dashboard'), href: ROUTES.DASHBOARD, icon: Home },
        { name: t('navigation.directories'), href: ROUTES.DASHBOARD_DIRECTORIES, icon: Folder },
        // { name: 'Analytics', href: ROUTES.DASHBOARD_ANALYTICS, icon: ChartIcon },
        { name: t('navigation.settings'), href: ROUTES.DASHBOARD_SETTINGS, icon: Settings },
    ];

    return (
        <ChatProvider>
            <aside
                className={cn(
                    'fixed lg:relative top-0 h-full z-50',
                    'transition-all duration-300 ease-in-out',
                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                    'border-r border-border dark:border-border-dark',
                    'w-80 shrink-0',
                    isOpen ? 'left-0' : '-left-80 lg:-ml-80',
                    'xl:left-0! xl:ml-0!', // Always visible on XL screens
                )}
            >
                <div className="flex flex-col h-full">
                    <div className={cn('h-16 flex items-center px-6')}>
                        <div className="flex items-center justify-between w-full">
                            <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                                {APP_NAME}
                            </h1>

                            <Button
                                onClick={onToggle}
                                variant="ghost"
                                size="icon"
                                className={cn(
                                    'xl:hidden',
                                    'text-text-muted dark:text-text-muted-dark',
                                    'hover:text-text dark:hover:text-text-dark',
                                    'hover:bg-surface dark:hover:bg-surface-dark',
                                )}
                            >
                                <X className="w-5 h-5" />
                            </Button>
                        </div>
                    </div>

                    <div className="px-6 py-3">
                        <div className="flex bg-surface-tertiary/50 dark:bg-surface-dark rounded-lg p-1 gap-1">
                            <Button
                                onClick={() => setActiveMode('menu')}
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    'flex-1 text-sm font-medium transition-all rounded-md',
                                    activeMode === 'menu'
                                        ? 'bg-white dark:bg-surface-tertiary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'text-text-secondary dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {t('menu')}
                            </Button>
                            <Button
                                onClick={() => setActiveMode('chat')}
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    'flex-1 text-sm font-medium transition-all rounded-md',
                                    activeMode === 'chat'
                                        ? 'bg-white dark:bg-surface-tertiary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'text-text-secondary dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {t('aiChat')}
                            </Button>
                        </div>
                    </div>

                    {activeMode === 'chat' ? (
                        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                            <ChatInterface />
                        </div>
                    ) : (
                        <>
                            <div className="px-6 pb-4">
                                <Button
                                    href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                    variant="primary"
                                    size="lg"
                                    fullWidth
                                >
                                    <Plus className="w-5 h-5" />
                                    <span className="font-medium">{t('newDirectory')}</span>
                                </Button>
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
                                            'relative w-10 h-10 rounded-full flex items-center justify-center overflow-hidden',
                                            'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                                        )}
                                    >
                                        {user.avatar && !avatarError ? (
                                            <Image
                                                src={user.avatar}
                                                alt={user.username}
                                                fill
                                                className="object-cover"
                                                onError={() => setAvatarError(true)}
                                                sizes="40px"
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
                        <Button
                            onClick={handleLogout}
                            disabled={isPending}
                            loading={isPending}
                            variant="ghost"
                            fullWidth
                            className={cn(
                                'justify-start items-center gap-3 px-4 py-3',
                                'text-danger dark:text-danger hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                                'hover:text-danger',
                            )}
                        >
                            <LogOut className="w-5 h-5" />
                            <span className="text-sm">
                                {isPending ? t('signingOut') : t('signOut')}
                            </span>
                        </Button>
                    </div>
                </div>
            </aside>
        </ChatProvider>
    );
}
