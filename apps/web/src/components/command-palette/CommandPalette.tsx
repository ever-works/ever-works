'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Dialog, DialogPanel } from '@headlessui/react';
import { Command } from 'cmdk';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { logout } from '@/app/actions/auth';
import { useChatContextOptional } from '@/components/ai/ChatProvider';
import { usePathname, useRouter } from '@/i18n/navigation';
import { withWorkspaceHref } from '@/i18n/navigation-client';
import { ROUTES } from '@/lib/constants';
import { useActiveScope } from '@/lib/hooks/use-active-scope';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { useTheme } from '@/lib/hooks/use-theme';
import {
    isModKey,
    resolveShortcut,
    SHORTCUT_PRIORITY,
    SHORTCUT_SCOPE,
} from '@/lib/keyboard/shortcut-registry';
import { cn } from '@/lib/utils/cn';
import {
    navigateToWorkspaceDashboard,
    persistActiveOrganization,
} from '@/lib/workspace-navigation';
import { parseWorkspacePath, serializeWorkspaceScope } from '@/lib/workspace-scope';
import { useCommandPalette } from './CommandPaletteProvider';
import { useAppLauncher } from '@/components/app-launcher/AppLauncherProvider';
import { PaletteFooter, type PaletteBanner } from './PaletteFooter';
import { PaletteRow } from './PaletteRow';
import { useIsMac } from './hooks/use-is-mac';
import { usePaletteKeyboard } from './hooks/use-palette-keyboard';
import { PALETTE_RECENT_BOOST_WINDOW_MS, usePaletteRecents } from './hooks/use-palette-recents';
import { useWorkspaceSearch } from './hooks/use-workspace-search';
import { isInAppDestination } from './registry/destination';
import { commandsFor, workSwitchCommands } from './registry/commands';
import { screensFor } from './registry/screens';
import {
    buildPaletteSections,
    filterLabel,
    flattenRows,
    PALETTE_FILTERED_ROWS,
    PALETTE_GROUP_ROWS,
    type PaletteFilter,
    type PaletteRow as PaletteRowModel,
} from './registry/sections';
import type { PaletteCommandContext, PaletteTranslator } from './registry/types';

export interface CommandPaletteProps {
    /** Keys the per-browser Recent list, so two people on one browser never share it. */
    userId: string;
    onOpenHelp: (tab?: 'shortcuts') => void;
    sidebarCollapsed?: boolean;
    onSidebarCollapsedChange?: (collapsed: boolean) => void;
    chatOpen?: boolean;
    onChatOpenChange?: (open: boolean) => void;
}

const ORGANIZATION_PREFIX = /^\/org\/[^/]+(\/.*)?$/;

/** The app path without the `/org/<slug>` workspace prefix. */
export function withoutWorkspacePrefix(pathname: string): string {
    const match = ORGANIZATION_PREFIX.exec(pathname);
    return match ? (match[1] ?? '/') : pathname;
}

function workspaceKey(pathname: string): string {
    try {
        return serializeWorkspaceScope(parseWorkspacePath(pathname));
    } catch {
        return 'personal';
    }
}

/** Rows that stand for real results, as opposed to "Show all" or fallbacks. */
function isResultRow(row: PaletteRowModel): boolean {
    return (
        row.action.type === 'record' ||
        row.action.type === 'command' ||
        row.action.type === 'screen'
    );
}

/**
 * The dashboard command palette (AW-01): one overlay, opened with `Ctrl/Cmd+K`,
 * `/` or the top-bar trigger, that reaches every screen, every record the
 * operator can open in the active workspace, and the everyday actions.
 *
 * Built on the same list primitive as the Knowledge-Base workbench palette.
 * The dialog traps focus, makes the page behind it inert, closes on `Esc`, an
 * outside click or a route change, and returns focus to where it was.
 */
export function CommandPalette({
    userId,
    onOpenHelp,
    sidebarCollapsed,
    onSidebarCollapsedChange,
    chatOpen,
    onChatOpenChange,
}: CommandPaletteProps) {
    const palette = useCommandPalette();
    const { openAppLauncher } = useAppLauncher();
    const open = palette?.open ?? false;
    const closePalette = palette?.closePalette;
    const t = useTranslations() as unknown as PaletteTranslator;
    const router = useRouter();
    const pathname = usePathname();
    const appPath = withoutWorkspacePrefix(pathname);
    const isMac = useIsMac();
    const { isDark, toggleTheme } = useTheme();
    const { organizations } = useOrganizations();
    const { slug: activeOrganizationSlug } = useActiveScope();
    const chat = useChatContextOptional();
    const [, startTransition] = useTransition();

    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<PaletteFilter | null>(null);
    const [selected, setSelected] = useState('');
    const trimmed = query.trim();

    const close = useCallback(() => closePalette?.(), [closePalette]);

    // Reset to a fresh, unfiltered box every time the palette closes.
    useEffect(() => {
        if (!open) {
            setQuery('');
            setFilter(null);
        }
    }, [open]);

    // Navigating away closes the palette.
    const lastPathRef = useRef(pathname);
    useEffect(() => {
        if (lastPathRef.current === pathname) return;
        lastPathRef.current = pathname;
        close();
    }, [pathname, close]);

    const scopeKey = workspaceKey(pathname);
    const { recents, record, refresh } = usePaletteRecents(`${userId}:${scopeKey}`);
    useEffect(() => {
        // Recent may have been written from another tab since the last open.
        if (open) refresh();
    }, [open, refresh]);

    const recentKeys = useMemo(() => {
        const cutoff = Date.now() - PALETTE_RECENT_BOOST_WINDOW_MS;
        return recents.filter((entry) => entry.openedAt >= cutoff).map((entry) => entry.key);
    }, [recents]);

    const localFilter = filter === 'command' || filter === 'screen';
    const recordFilter = filter && !localFilter ? filter : null;
    const search = useWorkspaceSearch({
        query,
        enabled: open && !localFilter,
        kinds: recordFilter ? [recordFilter] : undefined,
        perKindLimit: recordFilter ? PALETTE_FILTERED_ROWS : PALETTE_GROUP_ROWS,
        recent: recentKeys,
        scopeKey,
    });
    const settled = search.status === 'ready' && !search.stale;

    const copyLink = useCallback(() => {
        const href = window.location.href;
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard) {
            toast.error(t('dashboard.commandPalette.linkCopyFailed'));
            return;
        }
        clipboard.writeText(href).then(
            () => toast.success(t('dashboard.commandPalette.linkCopied')),
            () => toast.error(t('dashboard.commandPalette.linkCopyFailed')),
        );
    }, [t]);

    const commandContext = useMemo<PaletteCommandContext>(
        () => ({
            t,
            pathname: appPath,
            navigate: (href) => router.push(href),
            openHelp: onOpenHelp,
            toggleTheme: () => toggleTheme(),
            isDark,
            sidebarCollapsed,
            setSidebarCollapsed: onSidebarCollapsedChange,
            chatOpen,
            setChatOpen: onChatOpenChange,
            copyLink,
            signOut: () =>
                startTransition(() => {
                    void logout();
                }),
            switchOrganization: (slug) => {
                persistActiveOrganization(slug)
                    .then(() => navigateToWorkspaceDashboard({ kind: 'organization', slug }))
                    .catch(() => toast.error(t('dashboard.commandPalette.switchWorkspaceFailed')));
            },
            organizations: organizations.map((org) => ({
                slug: org.slug,
                label: org.displayName ?? org.slug,
            })),
            activeOrganizationSlug,
            /**
             * APW-11 T15 — the launcher's opener, from the provider that mounts
             * the element. `undefined` when the launcher is off for this
             * installation OR when the header's control is not mounted, and the
             * command's `available` gate reads exactly that, so the palette never
             * offers a command that opens nothing.
             */
            openAppLauncher,
        }),
        [
            t,
            appPath,
            router,
            onOpenHelp,
            toggleTheme,
            isDark,
            sidebarCollapsed,
            onSidebarCollapsedChange,
            chatOpen,
            onChatOpenChange,
            copyLink,
            organizations,
            activeOrganizationSlug,
            openAppLauncher,
        ],
    );

    const response = search.response;
    const commands = useMemo(() => {
        const works =
            response?.groups
                .find((group) => group.kind === 'work')
                ?.hits.map((hit) => ({ id: hit.sourceId, title: hit.title })) ?? [];
        return [...commandsFor(commandContext), ...workSwitchCommands(commandContext, works)];
    }, [commandContext, response]);
    const screens = useMemo(() => screensFor(appPath), [appPath]);

    const sections = useMemo(
        () =>
            buildPaletteSections({
                t,
                query,
                filter,
                commandContext,
                commands,
                screens,
                recents,
                response,
                settled,
            }),
        [t, query, filter, commandContext, commands, screens, recents, response, settled],
    );
    const rows = useMemo(() => flattenRows(sections), [sections]);

    // Keep a valid selection: the first row whenever the current one is gone.
    useEffect(() => {
        if (rows.length === 0) {
            if (selected !== '') setSelected('');
            return;
        }
        if (!rows.some((row) => row.key === selected)) setSelected(rows[0].key);
    }, [rows, selected]);

    const openHref = useCallback(
        (href: string, newTab: boolean) => {
            // Security: the palette only ever navigates inside the app.
            if (!isInAppDestination(href)) return;
            if (newTab) {
                window.open(withWorkspaceHref(href, pathname), '_blank', 'noopener,noreferrer');
                return;
            }
            router.push(href);
        },
        [pathname, router],
    );

    const activate = useCallback(
        (row: PaletteRowModel, options: { newTab?: boolean } = {}) => {
            const newTab = options.newTab === true;
            const { action } = row;
            switch (action.type) {
                case 'showAll':
                    if (!newTab) setFilter(action.filter);
                    return;
                case 'command':
                    if (newTab) return;
                    close();
                    action.command.run(commandContext);
                    return;
                case 'screen':
                    close();
                    openHref(action.href, newTab);
                    return;
                case 'record':
                    // A destination that is not an in-app path is neither opened
                    // nor remembered, so it can never come back as a Recent row.
                    if (!isInAppDestination(action.record.destination)) return;
                    record(action.record);
                    close();
                    openHref(action.record.destination, newTab);
                    return;
                case 'openList':
                    close();
                    openHref(action.href, newTab);
                    return;
                case 'askChat':
                    if (newTab) return;
                    close();
                    onChatOpenChange?.(true);
                    chat?.sendMessage(trimmed);
                    return;
                case 'createTask':
                    close();
                    openHref(
                        `${ROUTES.DASHBOARD_TASK_NEW}?prompt=${encodeURIComponent(trimmed)}`,
                        newTab,
                    );
                    return;
                case 'openHelp':
                    if (newTab) return;
                    close();
                    onOpenHelp();
                    return;
            }
        },
        [chat, close, commandContext, onChatOpenChange, onOpenHelp, openHref, record, trimmed],
    );

    const selectedRow = rows.find((row) => row.key === selected) ?? null;
    const retryPending = search.status === 'timeout' || search.status === 'error';

    const onKeyDown = usePaletteKeyboard(
        { query, hasFilter: filter !== null, retryPending },
        {
            close,
            applyFilter: () => {
                if (selectedRow?.filter) setFilter(selectedRow.filter);
            },
            removeFilter: () => setFilter(null),
            openInNewTab: () => {
                if (selectedRow) activate(selectedRow, { newTab: true });
            },
            activateIndex: (index) => {
                const row = rows[index];
                if (row) activate(row);
            },
            retry: search.retry,
        },
    );

    // While open, `Ctrl/Cmd+K` does not reset the palette (it is already
    // open). On a screen with its own scoped palette, it hands over to that
    // one instead, so two palettes are never open at once.
    useShortcut(
        {
            id: 'commandPalette.open',
            scope: SHORTCUT_SCOPE.overlay,
            priority: SHORTCUT_PRIORITY.overlay,
            allowInInput: true,
            enabled: open,
        },
        (event) => isModKey(event, 'k'),
        (event) => {
            const underneath = resolveShortcut(event, {
                maxPriority: SHORTCUT_PRIORITY.overlay - 1,
            });
            if (underneath && underneath.scope !== SHORTCUT_SCOPE.global) {
                close();
                underneath.handler(event);
            }
        },
    );

    let banner: PaletteBanner | null = null;
    if (search.status === 'offline') banner = 'offline';
    else if (search.status === 'throttled') banner = 'throttled';
    else if (search.status === 'timeout') banner = 'timeout';
    else if (search.status === 'error') banner = 'error';
    else if (settled && (response?.degradedKinds.length ?? 0) > 0) banner = 'partial';
    else if (trimmed.length === 1 && !localFilter) banner = 'tooShort';

    const dimmed = response !== null && (retryPending || search.status === 'throttled');
    const showSkeleton =
        !localFilter && trimmed.length >= 2 && search.status === 'loading' && response === null;
    const noResults = sections.length === 1 && sections[0].kind === 'fallback';
    const resultCount = rows.filter(isResultRow).length;
    const announcement = settled
        ? t('dashboard.commandPalette.announceResults', { count: resultCount })
        : '';
    const dialogLabel = t('dashboard.commandPalette.dialogLabel');

    return (
        <Dialog open={open} onClose={close} className="relative z-50" aria-label={dialogLabel}>
            <div className="fixed inset-0 bg-black/50 dark:bg-black/70" aria-hidden="true" />
            <div className="fixed inset-0 flex items-stretch justify-center md:items-start md:p-4 md:pt-[12vh]">
                <DialogPanel
                    data-testid="command-palette"
                    className={cn(
                        'flex h-full w-full flex-col overflow-hidden',
                        'bg-white dark:bg-surface-dark',
                        'md:h-auto md:max-h-[70vh] md:max-w-2xl md:rounded-lg md:border md:shadow-xl',
                        'md:border-border md:dark:border-border-dark',
                    )}
                >
                    <Command
                        label={dialogLabel}
                        shouldFilter={false}
                        vimBindings={false}
                        value={selected}
                        onValueChange={setSelected}
                        onKeyDown={onKeyDown}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        <div className="flex items-center gap-2 border-b border-border px-3 py-2 dark:border-border-dark">
                            <Search
                                className="h-4 w-4 shrink-0 text-text-muted"
                                aria-hidden="true"
                            />
                            {filter ? (
                                <span
                                    data-testid="command-palette-filter-chip"
                                    data-filter={filter}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary"
                                >
                                    {filterLabel(t, filter)}
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        aria-label={t('dashboard.commandPalette.removeFilter', {
                                            group: filterLabel(t, filter),
                                        })}
                                        onClick={() => setFilter(null)}
                                        className="rounded-full p-0.5 hover:bg-primary/20"
                                    >
                                        <X className="h-3 w-3" aria-hidden="true" />
                                    </button>
                                </span>
                            ) : null}
                            <Command.Input
                                data-testid="command-palette-input"
                                data-autofocus
                                autoFocus
                                value={query}
                                onValueChange={setQuery}
                                placeholder={t('dashboard.commandPalette.placeholder')}
                                className={cn(
                                    'min-h-9 min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm',
                                    'text-text dark:text-text-dark placeholder:text-text-muted',
                                )}
                            />
                            {query ? (
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-label={t('dashboard.commandPalette.clearQuery')}
                                    onClick={() => setQuery('')}
                                    className="rounded p-1 text-text-muted hover:text-text dark:hover:text-text-dark"
                                >
                                    <X className="h-4 w-4" aria-hidden="true" />
                                </button>
                            ) : null}
                        </div>

                        <Command.List
                            data-testid="command-palette-list"
                            className={cn(
                                'min-h-0 flex-1 overflow-y-auto p-1 transition-opacity md:max-h-[55vh]',
                                dimmed && 'opacity-50',
                            )}
                        >
                            {noResults ? (
                                <p
                                    data-testid="command-palette-no-results"
                                    className="px-3 pt-4 text-center text-sm text-text dark:text-text-dark"
                                >
                                    {t('dashboard.commandPalette.noResults.title', {
                                        query: trimmed,
                                    })}
                                </p>
                            ) : null}
                            {sections.map((section) => (
                                <Command.Group
                                    key={section.key}
                                    data-testid="command-palette-group"
                                    data-group-kind={section.kind}
                                    heading={
                                        <span className="flex items-center justify-between gap-2">
                                            <span>{section.heading}</span>
                                            {section.total !== null && filter === null ? (
                                                <span className="tabular-nums">
                                                    {section.total}
                                                </span>
                                            ) : null}
                                        </span>
                                    }
                                    className={cn(
                                        '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2',
                                        '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase',
                                        '[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-muted',
                                    )}
                                >
                                    {section.rows.map((row) => (
                                        <PaletteRow key={row.key} row={row} onActivate={activate} />
                                    ))}
                                </Command.Group>
                            ))}
                            {showSkeleton ? (
                                <div
                                    data-testid="command-palette-loading"
                                    className="flex flex-col gap-2 p-3"
                                    aria-hidden="true"
                                >
                                    {[0, 1, 2].map((index) => (
                                        <div
                                            key={index}
                                            className="h-8 animate-pulse rounded-md bg-surface-secondary dark:bg-surface-secondary-dark"
                                        />
                                    ))}
                                    <p className="text-center text-xs text-text-muted">
                                        {t('dashboard.commandPalette.loading')}
                                    </p>
                                </div>
                            ) : null}
                        </Command.List>

                        <PaletteFooter banner={banner} hasFilter={filter !== null} isMac={isMac} />
                    </Command>
                    <div
                        aria-live="polite"
                        role="status"
                        className="sr-only"
                        data-testid="command-palette-announcer"
                    >
                        {announcement}
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
