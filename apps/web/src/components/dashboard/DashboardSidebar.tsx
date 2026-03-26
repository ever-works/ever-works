'use client';

import { useState, useTransition } from 'react';
import Image from 'next/image';
import { AuthUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import {
    Home,
    Folder,
    Settings,
    LogOut,
    Plus,
    X,
    Plug,
    PanelLeftClose,
    PanelLeftOpen,
    User,
    HelpCircle,
    MessageSquare,
    Keyboard,
    ChevronUp,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { LogoEverWork } from '../logos';
import { useDirectoryDetail } from '../directories/detail/DirectoryDetailContext';
import { ChatPanelExpandButton } from '@/components/ai/ChatPanel';

interface DashboardSidebarProps {
    user: AuthUser;
    isOpen: boolean;
    onToggle: () => void;
    isCollapsed?: boolean;
    onCollapsedChange?: (v: boolean) => void;
    onOpenHelp?: () => void;
    chatOpen?: boolean;
    onOpenChat?: () => void;
}

function ConditionalTooltip({
    show,
    content,
    children,
}: {
    show: boolean;
    content: string;
    children: React.ReactNode;
}) {
    if (!show) return <>{children}</>;
    return (
        <Tooltip content={content} position="right">
            {children}
        </Tooltip>
    );
}

export function DashboardSidebar({
    user,
    isOpen,
    onToggle,
    isCollapsed = false,
    onCollapsedChange,
    onOpenHelp,
    chatOpen,
    onOpenChat,
}: DashboardSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [avatarError, setAvatarError] = useState(false);
    const t = useTranslations('dashboard.sidebar');
    const { config } = useDirectoryDetail();

    const handleCollapsedChange = (v: boolean) => {
        onCollapsedChange?.(v);
    };

    const handleLogout = async () => {
        startTransition(async () => {
            await logout();
        });
    };

    const navigation = [
        { name: t('navigation.dashboard'), href: ROUTES.DASHBOARD, icon: Home },
        { name: t('navigation.directories'), href: ROUTES.DASHBOARD_DIRECTORIES, icon: Folder },
        { name: t('navigation.plugins'), href: ROUTES.DASHBOARD_PLUGINS, icon: Plug },
        { name: t('navigation.settings'), href: ROUTES.DASHBOARD_SETTINGS, icon: Settings },
    ];

    return (
        <aside
            className={cn(
                'fixed lg:relative top-0 h-full z-50',
                'transition-[left,margin,width] duration-300 ease-in-out',
                'bg-white dark:bg-surface-dark',
                'border-r border-border dark:border-border-dark',
                'shrink-0',
                isCollapsed ? 'w-16' : 'w-60',
                isOpen ? 'left-0' : '-left-80 lg:-ml-80',
                'xl:left-0! xl:ml-0!',
            )}
        >
            <div className="flex flex-col h-full">
                {/* Logo + controls */}
                <div
                    className={cn(
                        'h-14 flex items-center shrink-0',
                        isCollapsed ? 'justify-center px-2' : 'px-5',
                    )}
                >
                    <div className="flex items-center justify-between w-full">
                        {!isCollapsed && <LogoEverWork config={config} />}
                        <div
                            className={cn(
                                'flex items-center gap-0.5',
                                isCollapsed && 'w-full justify-center',
                            )}
                        >
                            {onCollapsedChange && (
                                <Tooltip
                                    content={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                                    position="right"
                                >
                                    <button
                                        onClick={() => handleCollapsedChange(!isCollapsed)}
                                        className={cn(
                                            'flex items-center justify-center w-7 h-7 rounded-md transition-colors',
                                            'text-text-muted dark:text-text-muted-dark',
                                            'hover:text-text dark:hover:text-white hover:bg-surface-secondary dark:hover:bg-white/5',
                                        )}
                                    >
                                        {isCollapsed ? (
                                            <PanelLeftOpen className="w-4 h-4" />
                                        ) : (
                                            <PanelLeftClose className="w-4 h-4" />
                                        )}
                                    </button>
                                </Tooltip>
                            )}
                            {!isCollapsed && (
                                <Button
                                    onClick={onToggle}
                                    variant="ghost"
                                    size="icon"
                                    className="xl:hidden text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    <X className="w-5 h-5" />
                                </Button>
                            )}
                        </div>
                    </div>
                </div>

                {/* New Directory */}
                <div
                    className={cn(isCollapsed ? 'px-2 py-3 flex justify-center' : 'px-4 pt-2 pb-6')}
                >
                    {isCollapsed ? (
                        <ConditionalTooltip show content={t('newDirectory')}>
                            <Button
                                href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                variant="primary"
                                size="icon"
                                className="w-9 h-9 text-white bg-primary-hover hover:bg-primary-hover/80 shadow-sm rounded-xl"
                            >
                                <Plus className="w-5 h-5" />
                            </Button>
                        </ConditionalTooltip>
                    ) : (
                        <Button
                            href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                            variant="primary"
                            size="lg"
                            fullWidth
                            className="dark:text-white hover:text-white text-primary-hover rounded-xl dark:bg-primary-hover/20 text-sm bg-primary-hover/10 hover:bg-primary-hover/80 shadow-sm ring-1 dark:ring-white/6 dark:border dark:border-primary-hover dark:hover:border-white/12"
                        >
                            <Plus className="w-5 h-5" />
                            <span className="font-medium">{t('newDirectory')}</span>
                        </Button>
                    )}
                </div>

                {/* Navigation */}
                <nav
                    className={cn('flex-1 min-h-0', isCollapsed ? 'px-2' : 'px-4 overflow-y-auto')}
                >
                    <ul
                        className={cn(
                            'pb-4',
                            isCollapsed ? 'space-y-1 flex flex-col items-center' : 'space-y-0.5',
                        )}
                    >
                        {navigation.map((item) => {
                            const isActive =
                                pathname === item.href || pathname?.startsWith(item.href + '/');
                            return (
                                <li
                                    key={item.name}
                                    className={isCollapsed ? 'w-full flex justify-center' : ''}
                                >
                                    <ConditionalTooltip show={isCollapsed} content={item.name}>
                                        <Link
                                            href={item.href}
                                            className={cn(
                                                'flex items-center rounded-lg transition-colors border border-transparent',
                                                isCollapsed
                                                    ? 'justify-center w-8 h-8 px-0'
                                                    : 'gap-3 px-3 py-2',
                                                isActive
                                                    ? 'border bg-surface-secondary border-surface-tertiary dark:border-primary/10 dark:bg-surface-secondary-dark/50 text-text dark:text-primary'
                                                    : 'text-text dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark/30 hover:text-text dark:hover:text-text-dark',
                                            )}
                                        >
                                            <item.icon className="w-4.5 h-4.5 shrink-0" />
                                            {!isCollapsed && (
                                                <span className="text-sm">{item.name}</span>
                                            )}
                                        </Link>
                                    </ConditionalTooltip>
                                </li>
                            );
                        })}
                    </ul>
                </nav>

                {/* Bottom section: user menu */}
                <div
                    className={cn(
                        'mt-auto shrink-0 border-t border-border dark:border-border-dark',
                        isCollapsed ? 'px-2' : 'px-4',
                    )}
                >
                    <div className="py-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                className={cn(
                                    'w-full rounded-lg transition-colors cursor-pointer',
                                    'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                    isCollapsed ? 'p-1 flex justify-center' : 'p-2',
                                )}
                            >
                                <div
                                    className={cn(
                                        'flex items-center gap-3',
                                        isCollapsed && 'justify-center',
                                    )}
                                >
                                    <ConditionalTooltip show={isCollapsed} content={user.username}>
                                        <div
                                            className={cn(
                                                'relative w-7 h-7 rounded-full shrink-0 flex items-center justify-center overflow-hidden',
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
                                                    sizes="28px"
                                                />
                                            ) : (
                                                <span className="text-[10px] font-semibold text-text dark:text-text-dark">
                                                    {user.username.charAt(0).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                    </ConditionalTooltip>
                                    {!isCollapsed && (
                                        <>
                                            <div className="flex-1 min-w-0 text-left">
                                                <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                                    {user.username}
                                                </p>
                                                <p className="text-[11px] text-text-muted dark:text-text-muted-dark truncate">
                                                    {user.email}
                                                </p>
                                            </div>
                                            <ChevronUp className="w-3.5 h-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                        </>
                                    )}
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start" className="w-56">
                                <DropdownMenuLabel>
                                    <p className="truncate">{user.username}</p>
                                    <p className="text-xs font-normal text-text-muted dark:text-text-muted-dark truncate">
                                        {user.email}
                                    </p>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={() => router.push(ROUTES.DASHBOARD_SETTINGS)}
                                >
                                    <User className="w-4 h-4 mr-2 shrink-0" />
                                    {t('profileMenu.accountSettings')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => window.open('https://docs.ever.works', '_blank')}
                                >
                                    <HelpCircle className="w-4 h-4 mr-2 shrink-0" />
                                    {t('profileMenu.helpDocs')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() =>
                                        window.open(
                                            'https://github.com/ever-works/ever-works/issues',
                                            '_blank',
                                        )
                                    }
                                >
                                    <MessageSquare className="w-4 h-4 mr-2 shrink-0" />
                                    {t('profileMenu.support')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={onOpenHelp} disabled={!onOpenHelp}>
                                    <Keyboard className="w-4 h-4 mr-2 shrink-0" />
                                    {t('profileMenu.keyboardShortcuts')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={handleLogout}
                                    disabled={isPending}
                                    className="text-danger"
                                >
                                    <LogOut className="w-4 h-4 mr-2 shrink-0" />
                                    {isPending ? t('signingOut') : t('signOut')}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </div>

            {/* Expand chat button — on sidebar right border, only when chat is collapsed */}
            {!chatOpen && onOpenChat && <ChatPanelExpandButton onClick={onOpenChat} />}
        </aside>
    );
}
