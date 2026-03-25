'use client';

import { useState, useTransition, useRef } from 'react';
import Image from 'next/image';
import { AuthUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import { cn } from '@/lib/utils/cn';
import { ChatInterface } from '@/components/ai/ChatInterface';
import { ChatProvider } from '@/components/ai/ChatProvider';
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
    Bot,
    LayoutList,
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
import { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '@/lib/hooks/use-sidebar-persistence';

interface DashboardSidebarProps {
    user: AuthUser;
    isOpen: boolean;
    onToggle: () => void;
    width?: number;
    onWidthChange?: (w: number) => void;
    isCollapsed?: boolean;
    onCollapsedChange?: (v: boolean) => void;
    onOpenHelp?: () => void;
}

// Only shows tooltip when collapsed — transparent passthrough when expanded
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
    width,
    onWidthChange,
    isCollapsed = false,
    onCollapsedChange,
    onOpenHelp,
}: DashboardSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [activeMode, setActiveMode] = useState<'menu' | 'chat'>('menu');
    const [chatPanelOpen, setChatPanelOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const [avatarError, setAvatarError] = useState(false);
    const t = useTranslations('dashboard.sidebar');
    const { config } = useDirectoryDetail();
    const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

    // When collapsing, close the floating chat panel
    const handleCollapsedChange = (v: boolean) => {
        if (!v) setChatPanelOpen(false);
        onCollapsedChange?.(v);
    };

    const handleDragStart = (e: React.MouseEvent) => {
        e.preventDefault();
        const aside = e.currentTarget.closest('aside') as HTMLElement | null;
        dragRef.current = { startX: e.clientX, startWidth: aside?.offsetWidth ?? width ?? 320 };
        const onMouseMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = ev.clientX - dragRef.current.startX;
            const newWidth = Math.min(
                SIDEBAR_WIDTH_MAX,
                Math.max(SIDEBAR_WIDTH_MIN, dragRef.current.startWidth + delta),
            );
            onWidthChange?.(newWidth);
        };
        const onMouseUp = () => {
            dragRef.current = null;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
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
        // { name: 'Analytics', href: ROUTES.DASHBOARD_ANALYTICS, icon: ChartIcon },
        { name: t('navigation.settings'), href: ROUTES.DASHBOARD_SETTINGS, icon: Settings },
    ];

    return (
        <ChatProvider>
            <aside
                style={isCollapsed ? { width: 64 } : width ? { width } : undefined}
                className={cn(
                    'fixed lg:relative top-0 h-full z-50',
                    'transition-[left,margin,width] duration-300 ease-in-out',
                    'bg-white dark:bg-surface-dark',
                    'border-r border-border dark:border-border-dark',
                    !width && !isCollapsed && 'w-80',
                    'shrink-0',
                    isOpen ? 'left-0' : '-left-80 lg:-ml-80',
                    'xl:left-0! xl:ml-0!',
                )}
            >
                {/* Drag-to-resize handle — only in chat mode when expanded */}
                {onWidthChange && !isCollapsed && activeMode === 'chat' && (
                    <div
                        onMouseDown={handleDragStart}
                        className={cn(
                            'absolute right-0 top-0 h-full w-1 z-10',
                            'cursor-col-resize',
                            'transition-colors duration-150',
                            'group/drag',
                        )}
                    />
                )}
                <div className="flex flex-col h-full">
                    <div
                        className={cn(
                            'h-16 flex items-center shrink-0',
                            !isCollapsed && 'max-w-80',
                            isCollapsed ? 'justify-center px-2' : 'px-6',
                        )}
                    >
                        <div className="flex items-center justify-between w-full duration-300 ease-in-out">
                            {!isCollapsed && <LogoEverWork config={config} />}
                            <div
                                className={cn(
                                    'flex items-center gap-1',
                                    isCollapsed && 'w-full justify-center',
                                )}
                            >
                                {/* Collapse / expand toggle */}
                                {onCollapsedChange && (
                                    <Tooltip
                                        content={
                                            isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
                                        }
                                        position="right"
                                    >
                                        <button
                                            onClick={() => handleCollapsedChange(!isCollapsed)}
                                            className={cn(
                                                'flex items-center justify-center w-8 h-8 rounded-lg transition-colors',
                                                'text-text-muted dark:text-text-muted-dark',
                                                'hover:text-text dark:hover:text-white hover:bg-surface dark:hover:bg-white/5',
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
                                        className={cn(
                                            'xl:hidden',
                                            'text-text-muted dark:text-text-muted-dark',
                                            'hover:text-text dark:hover:text-text-dark',
                                            'hover:bg-surface dark:hover:bg-surface-dark',
                                        )}
                                    >
                                        <X className="w-5 h-5" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div
                        className={cn(
                            'pb-3 shrink-0 duration-300 ease-in-out',
                            !isCollapsed && 'max-w-80 duration-300 ease-in-out',
                            isCollapsed ? 'px-2' : 'px-4',
                        )}
                    >
                        <div
                            className={cn(
                                'flex items-center rounded-xl duration-300 ease-in-out p-1 gap-0.5 border border-border bg-surface-secondary dark:bg-surface-dark dark:border-surface-tertiary/10',
                                isCollapsed && 'flex-col',
                            )}
                        >
                            <ConditionalTooltip show={isCollapsed} content={t('menu')}>
                                <button
                                    onClick={() => {
                                        setActiveMode('menu');
                                        setChatPanelOpen(false);
                                        onWidthChange?.(320);
                                    }}
                                    className={cn(
                                        'flex items-center cursor-pointer justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
                                        isCollapsed ? 'w-8 h-8 px-0 ' : 'flex-1',
                                        (isCollapsed ? !chatPanelOpen : activeMode === 'menu')
                                            ? 'bg-surface-dark/90 text-white shadow-sm ring-1 ring-white/8 dark:bg-white/10 dark:text-white'
                                            : 'text-text-secondary hover:text-text hover:bg-surface-tertiary/50 dark:text-white/60 dark:hover:text-white dark:hover:bg-white/5',
                                    )}
                                >
                                    <LayoutList className="w-4 h-4 shrink-0" />
                                    {!isCollapsed && <span>{t('menu')}</span>}
                                </button>
                            </ConditionalTooltip>
                            <ConditionalTooltip show={isCollapsed} content={t('aiChat')}>
                                <button
                                    onClick={() => {
                                        if (isCollapsed) {
                                            setChatPanelOpen((o) => !o);
                                        } else {
                                            setActiveMode('chat');
                                        }
                                    }}
                                    className={cn(
                                        'flex items-center justify-center cursor-pointer gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
                                        isCollapsed ? 'w-8 h-8 px-0' : 'flex-1',
                                        (isCollapsed ? chatPanelOpen : activeMode === 'chat')
                                            ? 'bg-surface-dark/90 text-white shadow-sm ring-1 ring-white/8 dark:bg-white/10 dark:text-white'
                                            : 'text-text-secondary hover:text-text hover:bg-surface-tertiary/50 dark:text-white/60 dark:hover:text-white dark:hover:bg-white/5',
                                    )}
                                >
                                    <Bot className="w-4 h-4 shrink-0" />
                                    {!isCollapsed && <span>{t('aiChat')}</span>}
                                </button>
                            </ConditionalTooltip>
                        </div>
                    </div>

                    {!isCollapsed && activeMode === 'chat' ? (
                        <div className="flex-1 flex flex-col min-h-0 overflow-hidden w-full">
                            <ChatInterface />
                        </div>
                    ) : (
                        <div
                            className={cn(
                                'flex flex-col flex-1 min-h-0',
                                !isCollapsed && 'max-w-80',
                            )}
                        >
                            <div
                                className={cn(
                                    isCollapsed
                                        ? 'px-2 py-4 flex justify-center'
                                        : 'px-6 pt-4 pb-10',
                                )}
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

                            <nav
                                className={cn(
                                    'flex-1 min-h-0',
                                    isCollapsed ? 'px-2' : 'px-6 overflow-y-auto',
                                )}
                            >
                                <ul
                                    className={cn(
                                        'pb-4',
                                        isCollapsed
                                            ? 'space-y-1 flex flex-col items-center'
                                            : 'space-y-1',
                                    )}
                                >
                                    {navigation.map((item) => {
                                        const isActive =
                                            pathname === item.href ||
                                            pathname?.startsWith(item.href + '/');
                                        return (
                                            <li
                                                key={item.name}
                                                className={
                                                    isCollapsed ? 'w-full flex justify-center' : ''
                                                }
                                            >
                                                <ConditionalTooltip
                                                    show={isCollapsed}
                                                    content={item.name}
                                                >
                                                    <Link
                                                        href={item.href}
                                                        onClick={() => setChatPanelOpen(false)}
                                                        className={cn(
                                                            'flex items-center rounded-lg transition-colors border border-transparent',
                                                            isCollapsed
                                                                ? 'justify-center w-8 h-8 px-0'
                                                                : 'gap-3 px-4 py-2',
                                                            isActive
                                                                ? 'border bg-surface-secondary border-surface-tertiary dark:border-primary/10 dark:bg-surface-secondary-dark/50 text-text dark:text-primary'
                                                                : 'text-text dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark/30 hover:text-text dark:hover:text-text-dark',
                                                        )}
                                                    >
                                                        <item.icon className="w-5 h-5 shrink-0" />
                                                        {!isCollapsed && (
                                                            <span className="text-sm">
                                                                {item.name}
                                                            </span>
                                                        )}
                                                    </Link>
                                                </ConditionalTooltip>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </nav>
                        </div>
                    )}

                    <div
                        className={cn(
                            'mt-auto py-3 shrink-0 border-t border-border dark:border-border-dark',
                            !isCollapsed && 'max-w-80',
                            isCollapsed ? 'px-2' : 'px-4',
                        )}
                    >
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
                                        <>
                                            <div className="flex-1 min-w-0 text-left">
                                                <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                                                    {user.username}
                                                </p>
                                                <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                                    {user.email}
                                                </p>
                                            </div>
                                            <ChevronUp className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark" />
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
                                    onClick={() => {
                                        window.open('https://docs.ever.works', '_blank');
                                    }}
                                >
                                    <HelpCircle className="w-4 h-4 mr-2 shrink-0" />
                                    {t('profileMenu.helpDocs')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => {
                                        window.open(
                                            'https://github.com/ever-works/ever-works/issues',
                                            '_blank',
                                        );
                                    }}
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
            </aside>

            {/* Floating AI chat panel — only when sidebar is collapsed */}
            {isCollapsed && chatPanelOpen && (
                <div
                    className={cn(
                        'fixed top-0 left-16 h-full z-40 flex flex-col',
                        'w-80',
                        'bg-white dark:bg-surface-dark',
                        'border-r border-border dark:border-border-dark',
                        'shadow-xl',
                        'animate-in slide-in-from-left-2 duration-200',
                    )}
                >
                    {/* Panel header */}
                    <div className="h-12 flex items-center justify-between px-4 border-b border-border dark:border-border-dark shrink-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
                            <Bot className="w-4 h-4" />
                            <span>{t('aiChat')}</span>
                        </div>
                        <button
                            onClick={() => setChatPanelOpen(false)}
                            className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-white hover:bg-surface dark:hover:bg-white/5 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                        <ChatInterface />
                    </div>
                </div>
            )}

            {/* Backdrop to close floating panel on outside click */}
            {isCollapsed && chatPanelOpen && (
                <div className="fixed inset-0 z-30" onClick={() => setChatPanelOpen(false)} />
            )}
        </ChatProvider>
    );
}
