import {
    ArrowLeftRight,
    Bot,
    Calendar,
    Folder,
    Gauge,
    HelpCircle,
    Keyboard,
    LayoutGrid,
    Lightbulb,
    Link2,
    ListChecks,
    LogOut,
    MessageSquare,
    Moon,
    PanelLeft,
    Search,
    Sparkles,
    Target,
    Users,
} from 'lucide-react';
// `WORKS_SEARCH_HREF` is imported from `@/lib/constants`, NOT from the
// `'use client'` hook module it used to live in: this file carries no directive of
// its own, and a value imported into a module that can render on the server
// arrives as a client REFERENCE rather than the string (the C22/C27 defect class).
// The hook still exports the same name, so its own consumers are unchanged.
import { ROUTES, WORKS_SEARCH_HREF } from '@/lib/constants';
import { getWorkIdFromPath, replaceWorkIdInPath } from '@/lib/utils/work-route';
import type { PaletteCommand, PaletteCommandContext } from './types';

const navigateTo =
    (href: string) =>
    (ctx: PaletteCommandContext): void =>
        ctx.navigate(href);

/**
 * The palette's P1 commands (AW-01 spec FR-22). Every command is pure
 * navigation or pure client-side UI state — none changes server data, so none
 * needs a confirmation step. Labels and aliases are translated message keys.
 */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
    {
        id: 'newMission',
        icon: Target,
        suggested: true,
        label: ({ t }) => t('dashboard.commandPalette.commands.newMission'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newMission'),
        run: navigateTo(ROUTES.DASHBOARD_MISSIONS_NEW),
    },
    {
        id: 'newTask',
        icon: ListChecks,
        suggested: true,
        label: ({ t }) => t('dashboard.commandPalette.commands.newTask'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newTask'),
        run: navigateTo(ROUTES.DASHBOARD_TASK_NEW),
    },
    {
        id: 'newIdea',
        icon: Lightbulb,
        label: ({ t }) => t('dashboard.commandPalette.commands.newIdea'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newIdea'),
        run: navigateTo(ROUTES.DASHBOARD_IDEAS_NEW),
    },
    {
        id: 'newWork',
        icon: Folder,
        label: ({ t }) => t('dashboard.commandPalette.commands.newWork'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newWork'),
        run: navigateTo(ROUTES.DASHBOARD_WORKS_NEW),
    },
    {
        id: 'newAgent',
        icon: Bot,
        label: ({ t }) => t('dashboard.commandPalette.commands.newAgent'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newAgent'),
        run: navigateTo(ROUTES.DASHBOARD_AGENT_NEW),
    },
    {
        id: 'newTeam',
        icon: Users,
        label: ({ t }) => t('dashboard.commandPalette.commands.newTeam'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newTeam'),
        run: navigateTo(ROUTES.DASHBOARD_TEAM_NEW),
    },
    {
        id: 'newSkill',
        icon: Sparkles,
        label: ({ t }) => t('dashboard.commandPalette.commands.newSkill'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newSkill'),
        run: navigateTo(ROUTES.DASHBOARD_SKILL_NEW),
    },
    {
        id: 'newGoal',
        icon: Gauge,
        label: ({ t }) => t('dashboard.commandPalette.commands.newGoal'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newGoal'),
        run: navigateTo(ROUTES.DASHBOARD_GOALS_NEW),
    },
    {
        id: 'newMeeting',
        icon: Calendar,
        label: ({ t }) => t('dashboard.commandPalette.commands.newMeeting'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.newMeeting'),
        run: navigateTo(ROUTES.DASHBOARD_MEETINGS_NEW),
    },
    {
        // The original Ctrl/Cmd+K destination, preserved as a command. Reuses
        // the label the Help drawer has always shown for that shortcut.
        id: 'searchWorks',
        icon: Search,
        label: ({ t }) => t('dashboard.header.help.shortcuts.search'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.searchWorks'),
        run: navigateTo(WORKS_SEARCH_HREF),
    },
    {
        id: 'openHelp',
        icon: HelpCircle,
        suggested: true,
        label: ({ t }) => t('dashboard.commandPalette.commands.openHelp'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.openHelp'),
        run: (ctx) => ctx.openHelp(),
    },
    {
        /**
         * APW-11 T15 — the launcher reached from the palette, which is the only
         * door to it from the keyboard. The command is offered exactly when the
         * shell supplied an opener, so an installation without the launcher (or a
         * provider whose element failed to load) never shows a command that
         * opens nothing — the launcher's own trigger lives in the header, and
         * this is the same action, not a second one.
         */
        id: 'openAppLauncher',
        icon: LayoutGrid,
        label: ({ t }) => t('dashboard.commandPalette.commands.openAppLauncher'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.openAppLauncher'),
        available: (ctx) => ctx.openAppLauncher !== undefined,
        run: (ctx) => ctx.openAppLauncher?.(),
    },
    {
        id: 'keyboardShortcuts',
        icon: Keyboard,
        label: ({ t }) => t('dashboard.commandPalette.commands.keyboardShortcuts'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.keyboardShortcuts'),
        run: (ctx) => ctx.openHelp('shortcuts'),
    },
    {
        id: 'toggleTheme',
        icon: Moon,
        suggested: true,
        label: ({ t }) => t('dashboard.commandPalette.commands.toggleTheme'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.toggleTheme'),
        run: (ctx) => ctx.toggleTheme(),
    },
    {
        id: 'collapseSidebar',
        icon: PanelLeft,
        label: ({ t }) => t('dashboard.commandPalette.commands.collapseSidebar'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.collapseSidebar'),
        available: (ctx) => Boolean(ctx.setSidebarCollapsed) && !ctx.sidebarCollapsed,
        run: (ctx) => ctx.setSidebarCollapsed?.(true),
    },
    {
        id: 'expandSidebar',
        icon: PanelLeft,
        label: ({ t }) => t('dashboard.commandPalette.commands.expandSidebar'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.expandSidebar'),
        available: (ctx) => Boolean(ctx.setSidebarCollapsed) && Boolean(ctx.sidebarCollapsed),
        run: (ctx) => ctx.setSidebarCollapsed?.(false),
    },
    {
        id: 'openChat',
        icon: MessageSquare,
        label: ({ t }) => t('dashboard.commandPalette.commands.openChat'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.openChat'),
        available: (ctx) => Boolean(ctx.setChatOpen) && !ctx.chatOpen,
        run: (ctx) => ctx.setChatOpen?.(true),
    },
    {
        id: 'closeChat',
        icon: MessageSquare,
        label: ({ t }) => t('dashboard.commandPalette.commands.closeChat'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.closeChat'),
        available: (ctx) => Boolean(ctx.setChatOpen) && Boolean(ctx.chatOpen),
        run: (ctx) => ctx.setChatOpen?.(false),
    },
    {
        id: 'copyPageLink',
        icon: Link2,
        label: ({ t }) => t('dashboard.commandPalette.commands.copyPageLink'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.copyPageLink'),
        run: (ctx) => ctx.copyLink(),
    },
    {
        id: 'signOut',
        icon: LogOut,
        label: ({ t }) => t('dashboard.commandPalette.commands.signOut'),
        aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.signOut'),
        run: (ctx) => ctx.signOut(),
    },
];

/** One "Switch workspace → {organization}" command per Organization the caller belongs to. */
export function organizationCommands(ctx: PaletteCommandContext): PaletteCommand[] {
    return ctx.organizations
        .filter((org) => org.slug !== ctx.activeOrganizationSlug)
        .map((org) => ({
            id: `switchWorkspace:${org.slug}`,
            icon: ArrowLeftRight,
            label: ({ t }) =>
                t('dashboard.commandPalette.commands.switchWorkspace', { name: org.label }),
            aliases: ({ t }) =>
                `${t('dashboard.commandPalette.commandAliases.switchWorkspace')}, ${org.slug}`,
            run: (inner) => inner.switchOrganization(org.slug),
        }));
}

/**
 * "Switch Work → {work}" — mirrors the top-bar Work switcher: while the
 * operator is inside a Work, jump to the same sub-page of another Work. The
 * candidates are the Works the current search matched.
 */
export function workSwitchCommands(
    ctx: PaletteCommandContext,
    works: ReadonlyArray<{ id: string; title: string }>,
): PaletteCommand[] {
    const currentWorkId = getWorkIdFromPath(ctx.pathname);
    if (!currentWorkId) return [];
    return works
        .filter((work) => work.id !== currentWorkId)
        .map((work) => ({
            id: `switchWork:${work.id}`,
            icon: ArrowLeftRight,
            label: ({ t }) =>
                t('dashboard.commandPalette.commands.switchWork', { name: work.title }),
            aliases: ({ t }) => t('dashboard.commandPalette.commandAliases.switchWork'),
            run: (inner) =>
                inner.navigate(
                    replaceWorkIdInPath(inner.pathname, work.id) ?? ROUTES.DASHBOARD_WORK(work.id),
                ),
        }));
}

/** Commands that apply right now, in registry order. */
export function commandsFor(ctx: PaletteCommandContext): PaletteCommand[] {
    return [...PALETTE_COMMANDS, ...organizationCommands(ctx)].filter(
        (command) => !command.available || command.available(ctx),
    );
}
