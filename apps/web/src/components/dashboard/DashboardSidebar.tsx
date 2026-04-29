'use client';

import { useEffect, useState, useTransition } from 'react';
import Image from 'next/image';
import { AuthUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import { cn } from '@/lib/utils/cn';
import { ROUTES, getSiteConfig } from '@/lib/constants';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import {
    Home,
    FolderClosed,
    Settings,
    LogOut,
    Plus,
    X,
    Plug,
    PanelLeftClose,
    PanelLeftOpen,
    HelpCircle,
    MessageSquare,
    Keyboard,
    Activity,
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
import { LogoEverWork, FaviconEverWork } from '../logos';
import { useDirectoryDetail } from '../directories/detail/DirectoryDetailContext';
import { ChatPanelExpandButton } from '@/components/ai/ChatPanel';
import { SidebarActivityIndicator } from './SidebarActivityIndicator';
import { useMounted } from '@/lib/hooks/use-mounted';

interface DashboardSidebarProps {
    user: AuthUser;
    isOpen: boolean;
    onToggle: () => void;
    isCollapsed?: boolean;
    onCollapsedChange?: (v: boolean) => void;
    onOpenHelp?: () => void;
    chatOpen?: boolean;
    onOpenChat?: () => void;
    onInteraction?: () => void;
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
    onInteraction,
}: DashboardSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [avatarError, setAvatarError] = useState(false);
    const mounted = useMounted();
    const t = useTranslations('dashboard.sidebar');
    const { config } = useDirectoryDetail();

    const handleCollapsedChange = (v: boolean) => {
        onCollapsedChange?.(v);
    };

    const handleLogout = async () => {
        startTransition(() => {
            void (async () => {
                await logout();
            })();
        });
    };

    const navigation = [
        { name: t('navigation.dashboard'), href: ROUTES.DASHBOARD, icon: Home },
        {
            name: t('navigation.directories'),
            href: ROUTES.DASHBOARD_DIRECTORIES,
            icon: FolderClosed,
        },
        { name: t('navigation.plugins'), href: ROUTES.DASHBOARD_PLUGINS, icon: Plug },
        { name: t('navigation.activity'), href: ROUTES.DASHBOARD_ACTIVITY, icon: Activity },
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
                        'h-15 flex items-center shrink-0',
                        isCollapsed ? 'justify-center px-2' : 'px-4',
                    )}
                >
                    <div className="w-full relative">
                        <div className={cn('flex items-center -ml-2')}>
                            <FaviconEverWork
                                config={config}
                                className={cn(isCollapsed ? 'w-11 ml-[5px]' : 'w-12')}
                            />
                            <LogoEverWork config={config} className={cn(isCollapsed && 'hidden')} />
                        </div>
                        <div
                            className={cn(
                                'flex items-center gap-0.5',
                                isCollapsed && 'w-full justify-center',
                            )}
                        >
                            {onCollapsedChange && (
                                <div
                                    className={cn(
                                        isCollapsed
                                            ? 'absolute -right-5 top-2'
                                            : 'absolute -right-1 top-2',
                                    )}
                                >
                                    <Tooltip
                                        content={
                                            isCollapsed
                                                ? t('tooltips.expandSidebar')
                                                : t('tooltips.collapseSidebar')
                                        }
                                        position="right"
                                    >
                                        <button
                                            onClick={() => handleCollapsedChange(!isCollapsed)}
                                            className={cn(
                                                'flex items-center justify-center w-5 h-5 rounded-md transition-colors cursor-pointer',
                                                'text-text-muted dark:text-text-muted-dark',
                                                'hover:text-text dark:hover:text-white hover:bg-surface-secondary dark:hover:bg-white/5',
                                            )}
                                        >
                                            {isCollapsed ? (
                                                <PanelLeftOpen
                                                    className="w-4 h-4"
                                                    strokeWidth={1.3}
                                                />
                                            ) : (
                                                <PanelLeftClose
                                                    className="w-4 h-4"
                                                    strokeWidth={1.3}
                                                />
                                            )}
                                        </button>
                                    </Tooltip>
                                </div>
                            )}
                            {!isCollapsed && (
                                <Button
                                    onClick={onToggle}
                                    variant="ghost"
                                    size="icon"
                                    className="xl:hidden text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    <X className="w-5 h-5" strokeWidth={1.3} />
                                </Button>
                            )}
                        </div>
                    </div>
                </div>

                {/* New Directory */}
                <div
                    className={cn(isCollapsed ? 'px-2 py-3 flex justify-center' : 'px-4 pt-5 pb-6')}
                >
                    {isCollapsed ? (
                        <ConditionalTooltip show content={t('newDirectory')}>
                            <Button
                                href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                                variant="primary"
                                size="icon"
                                className="w-8 h-8 shadow-sm rounded-xl"
                                onClick={() => onInteraction?.()}
                            >
                                <Plus className="w-5 h-5" strokeWidth={1.3} />
                            </Button>
                        </ConditionalTooltip>
                    ) : (
                        <Button
                            href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                            variant="primary"
                            size="sm"
                            fullWidth
                            className="shadow-s dark:border"
                            onClick={() => onInteraction?.()}
                        >
                            <Plus className="w-5 h-5"/>
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
                                            onClick={() => onInteraction?.()}
                                            className={cn(
                                                'flex items-center relative rounded-sm transition-colors border border-transparent',
                                                isCollapsed
                                                    ? 'justify-center w-8 h-8 px-0'
                                                    : 'gap-3 px-4 py-2',
                                                isActive
                                                    ? 'border bg-surface-secondary border-surface-tertiary dark:border-transparent dark:bg-card-secondary-dark text-text dark:text-text-dark'
                                                    : 'text-text dark:text-text-secondary-dark/70 hover:bg-surface-secondary dark:hover:bg-card-primary-dark hover:text-text dark:hover:text-text-dark',
                                            )}
                                        >
                                            <span className="shrink-0 inline-flex">
                                                <item.icon className="w-5 h-5" strokeWidth={1.5} />
                                            </span>
                                            {!isCollapsed && (
                                                <span className="text-sm">{item.name}</span>
                                            )}
                                            <div className="absolute -top-3 -right-0.5">
                                                {item.href === ROUTES.DASHBOARD_DIRECTORIES && (
                                                    <SidebarActivityIndicator />
                                                )}
                                            </div>
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
                        'mt-auto shrink-0 border-t h-16 border-border dark:border-border-dark z-999999',
                        isCollapsed ? 'px-2' : 'px-4',
                    )}
                >
                    <div className="flex items-center gap-2 py-1 relative">
                        {mounted ? (
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    className={cn(
                                        'w-full mx-auto rounded-md transition-colors cursor-pointer focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus:border-transparent focus-visible:border-transparent',
                                        'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                                        isCollapsed ? 'p-2 flex justify-center' : 'p-2',
                                    )}
                                >
                                    <div
                                        className={cn(
                                            'flex items-center gap-3 ',
                                            isCollapsed && 'justify-center',
                                        )}
                                    >
                                        <ConditionalTooltip
                                            show={isCollapsed}
                                            content={user.username}
                                        >
                                            <div
                                                className={cn(
                                                    'relative w-8 h-8 rounded-full shrink-0 flex items-center justify-center overflow-hidden',
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
                                                        sizes="32px"
                                                    />
                                                ) : (
                                                    <span className="text-xs font-semibold text-text dark:text-text-dark">
                                                        {user.username.charAt(0).toUpperCase()}
                                                    </span>
                                                )}
                                            </div>
                                        </ConditionalTooltip>
                                        {!isCollapsed && (
                                            <div className="flex-1 min-w-0 text-left">
                                                <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                                    {user.username}
                                                </p>
                                                <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                                    {user.email}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    side="top"
                                    align="start"
                                    className="w-56 bg-white"
                                >
                                    <DropdownMenuLabel className="cursor-pointer px-3 rounded-md hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark">
                                        <p className="truncate">{user.username}</p>
                                        <p className="text-xs font-normal text-text-muted dark:text-text-muted-dark truncate">
                                            {user.email}
                                        </p>
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onClick={() => {
                                            onInteraction?.();
                                            router.push(ROUTES.DASHBOARD_SETTINGS);
                                        }}
                                        className="cursor-pointer px-3 rounded-md hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark"
                                    >
                                        <Settings
                                            className="w-4 h-4 mr-2 shrink-0"
                                            strokeWidth={1.5}
                                        />
                                        {t('profileMenu.accountSettings')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            onInteraction?.();
                                            window.open('https://docs.ever.works', '_blank');
                                        }}
                                        className="cursor-pointer px-3 rounded-sm hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark"
                                    >
                                        <HelpCircle
                                            className="w-4 h-4 mr-2 shrink-0"
                                            strokeWidth={1.5}
                                        />
                                        {t('profileMenu.helpDocs')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            onInteraction?.();
                                            window.open(
                                                'https://github.com/ever-works/ever-works/issues',
                                                '_blank',
                                            );
                                        }}
                                        className="cursor-pointer px-3 rounded-md hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark"
                                    >
                                        <MessageSquare
                                            className="w-4 h-4 mr-2 shrink-0"
                                            strokeWidth={1.5}
                                        />
                                        {t('profileMenu.support')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            onInteraction?.();
                                            onOpenHelp?.();
                                        }}
                                        disabled={!onOpenHelp}
                                        className="cursor-pointer px-3 rounded-md hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark"
                                    >
                                        <Keyboard
                                            className="w-4 h-4 mr-2 shrink-0"
                                            strokeWidth={1.3}
                                        />
                                        {t('profileMenu.keyboardShortcuts')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onClick={() => {
                                            onInteraction?.();
                                            handleLogout();
                                        }}
                                        disabled={isPending}
                                        className="text-danger hover:bg-danger/10 cursor-pointer px-3"
                                    >
                                        <LogOut
                                            className="w-4 h-4 mr-2 shrink-0"
                                            strokeWidth={1.3}
                                        />
                                        {isPending ? t('signingOut') : t('signOut')}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : (
                            <div
                                className={cn(
                                    'w-full mx-auto rounded-md p-2',
                                    isCollapsed ? 'flex justify-center' : '',
                                )}
                            >
                                <div
                                    className={cn(
                                        'flex items-center gap-3',
                                        isCollapsed && 'justify-center',
                                    )}
                                >
                                    <div
                                        className={cn(
                                            'relative w-8 h-8 rounded-full shrink-0 flex items-center justify-center overflow-hidden',
                                            'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                                        )}
                                    >
                                        <span className="text-xs font-semibold text-text dark:text-text-dark">
                                            {user.username.charAt(0).toUpperCase()}
                                        </span>
                                    </div>
                                    {!isCollapsed && (
                                        <div className="flex-1 min-w-0 text-left">
                                            <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                                {user.username}
                                            </p>
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                                {user.email}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Expand chat button — on sidebar right border, only when chat is collapsed */}
            {!chatOpen && onOpenChat && <ChatPanelExpandButton onClick={onOpenChat} />}
        </aside>
    );
}
