import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '@/lib/constants';
import { WORKS_SEARCH_HREF } from '@/lib/hooks/use-keyboard-shortcuts';
import { createEnTranslator } from '../__tests__/en-translator';
import {
    commandsFor,
    organizationCommands,
    PALETTE_COMMANDS,
    workSwitchCommands,
} from './commands';
import { PALETTE_KINDS, statusBadge } from './kinds';
import { localMatchScore } from './local-match';
import { DASHBOARD_SCREENS, screensFor } from './screens';
import type { PaletteCommandContext } from './types';

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => '/',
}));

function context(overrides: Partial<PaletteCommandContext> = {}): PaletteCommandContext {
    return {
        t: createEnTranslator(),
        pathname: '/dashboard',
        navigate: vi.fn(),
        openHelp: vi.fn(),
        toggleTheme: vi.fn(),
        isDark: false,
        sidebarCollapsed: false,
        setSidebarCollapsed: vi.fn(),
        chatOpen: false,
        setChatOpen: vi.fn(),
        copyLink: vi.fn(),
        signOut: vi.fn(),
        switchOrganization: vi.fn(),
        organizations: [],
        activeOrganizationSlug: null,
        ...overrides,
    };
}

/** Every static string path in ROUTES, plus every builder applied to a sample id. */
function routeValues(): Set<string> {
    const values = new Set<string>();
    for (const value of Object.values(ROUTES)) {
        if (typeof value === 'string') values.add(value);
        if (typeof value === 'function') values.add((value as (id: string) => string)('sample-id'));
    }
    return values;
}

describe('command registry', () => {
    it('gives every command a translated label and at least two aliases', () => {
        const ctx = context();
        for (const command of PALETTE_COMMANDS) {
            expect(command.label(ctx).length, command.id).toBeGreaterThan(0);
            const aliases = command
                .aliases(ctx)
                .split(',')
                .map((alias) => alias.trim())
                .filter(Boolean);
            expect(aliases.length, `${command.id} aliases`).toBeGreaterThanOrEqual(2);
        }
    });

    it('covers every P1 command family', () => {
        const ids = PALETTE_COMMANDS.map((command) => command.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                'newMission',
                'newIdea',
                'newWork',
                'newTask',
                'newAgent',
                'newTeam',
                'newSkill',
                'newGoal',
                'newMeeting',
                'searchWorks',
                'openHelp',
                'keyboardShortcuts',
                'toggleTheme',
                'collapseSidebar',
                'expandSidebar',
                'openChat',
                'closeChat',
                'copyPageLink',
                'signOut',
            ]),
        );
    });

    it('keeps the original Ctrl/Cmd+K destination reachable as "Search Works"', () => {
        const ctx = context();
        const command = PALETTE_COMMANDS.find((entry) => entry.id === 'searchWorks');
        expect(command).toBeDefined();
        command?.run(ctx);
        expect(ctx.navigate).toHaveBeenCalledWith(`${ROUTES.DASHBOARD_WORKS}?focus=search`);
        expect(WORKS_SEARCH_HREF).toBe('/works?focus=search');
    });

    it('sends "New Task" and "New Mission" to their own creation screens', () => {
        const ctx = context();
        PALETTE_COMMANDS.find((entry) => entry.id === 'newTask')?.run(ctx);
        PALETTE_COMMANDS.find((entry) => entry.id === 'newMission')?.run(ctx);
        expect(ctx.navigate).toHaveBeenNthCalledWith(1, ROUTES.DASHBOARD_TASK_NEW);
        expect(ctx.navigate).toHaveBeenNthCalledWith(2, ROUTES.DASHBOARD_MISSIONS_NEW);
    });

    it('opens the Help drawer on its Shortcuts tab for "Keyboard shortcuts"', () => {
        const ctx = context();
        PALETTE_COMMANDS.find((entry) => entry.id === 'keyboardShortcuts')?.run(ctx);
        PALETTE_COMMANDS.find((entry) => entry.id === 'openHelp')?.run(ctx);
        expect(ctx.openHelp).toHaveBeenNthCalledWith(1, 'shortcuts');
        expect(ctx.openHelp).toHaveBeenNthCalledWith(2);
    });

    it('offers only the sidebar and chat command that applies to the current state', () => {
        const collapsed = commandsFor(context({ sidebarCollapsed: true, chatOpen: true })).map(
            (c) => c.id,
        );
        expect(collapsed).toContain('expandSidebar');
        expect(collapsed).not.toContain('collapseSidebar');
        expect(collapsed).toContain('closeChat');
        expect(collapsed).not.toContain('openChat');

        const withoutShellControls = commandsFor(
            context({ setSidebarCollapsed: undefined, setChatOpen: undefined }),
        ).map((c) => c.id);
        expect(withoutShellControls).not.toContain('collapseSidebar');
        expect(withoutShellControls).not.toContain('openChat');
    });

    it('offers the App Launcher command only when the shell supplied an opener (APW-11 T15, ACC-11-04 unit half)', () => {
        const opener = vi.fn();
        const withLauncher = commandsFor(context({ openAppLauncher: opener })).map((c) => c.id);
        expect(withLauncher).toContain('openAppLauncher');

        // …and an installation without the launcher — or a provider whose element
        // failed to load — offers no such command rather than one that opens
        // nothing. The gate is `!== undefined`, so the explicit `undefined` here is
        // the same thing as the field being absent from the context object.
        expect(commandsFor(context()).map((c) => c.id)).not.toContain('openAppLauncher');
        expect(commandsFor(context({ openAppLauncher: undefined })).map((c) => c.id)).not.toContain(
            'openAppLauncher',
        );
    });

    it('finds the App Launcher command by "launcher", "apps" and "switch app" (ACC-11-04 unit half)', () => {
        const ctx = context();
        const command = PALETTE_COMMANDS.find((entry) => entry.id === 'openAppLauncher');
        expect(command).toBeDefined();

        const label = command!.label(ctx);
        const aliases = command!.aliases(ctx);
        for (const query of ['launcher', 'apps', 'switch app']) {
            expect(localMatchScore(query, label, aliases), query).not.toBeNull();
        }
        // A query that should not find it, as the control: without this, an
        // `aliases` value that matched everything would pass the loop above.
        expect(localMatchScore('deploy the app', label, aliases)).toBeNull();
    });

    it('runs the supplied opener, and never navigates on its own', () => {
        const ctx = context({ openAppLauncher: vi.fn() });
        PALETTE_COMMANDS.find((entry) => entry.id === 'openAppLauncher')?.run(ctx);
        expect(ctx.openAppLauncher).toHaveBeenCalledTimes(1);
        expect(ctx.navigate).not.toHaveBeenCalled();
    });

    it('lists one "Switch workspace" command per other Organization', () => {
        const ctx = context({
            organizations: [
                { slug: 'acme', label: 'Acme' },
                { slug: 'globex', label: 'Globex' },
            ],
            activeOrganizationSlug: 'acme',
        });
        const commands = organizationCommands(ctx);
        expect(commands.map((command) => command.id)).toEqual(['switchWorkspace:globex']);
        expect(commands[0].label(ctx)).toBe('Switch workspace → Globex');
        commands[0].run(ctx);
        expect(ctx.switchOrganization).toHaveBeenCalledWith('globex');
    });

    it('switches Work on the same sub-page, and only while inside a Work', () => {
        const works = [
            { id: 'w1', title: 'Current' },
            { id: 'w2', title: 'Other' },
        ];
        expect(workSwitchCommands(context({ pathname: '/tasks' }), works)).toEqual([]);

        const ctx = context({ pathname: '/works/w1/kb' });
        const commands = workSwitchCommands(ctx, works);
        expect(commands.map((command) => command.id)).toEqual(['switchWork:w2']);
        commands[0].run(ctx);
        expect(ctx.navigate).toHaveBeenCalledWith('/works/w2/kb');
    });
});

describe('screens registry', () => {
    it('builds every href from ROUTES', () => {
        const known = routeValues();
        const settingsPrefix = `${ROUTES.DASHBOARD_SETTINGS}/`;
        for (const screen of screensFor('/works/sample-id/items')) {
            const traced =
                known.has(screen.href) ||
                screen.href.startsWith(settingsPrefix) ||
                screen.href.startsWith(`${ROUTES.DASHBOARD_WORK('sample-id')}/`);
            expect(traced, `${screen.id} → ${screen.href}`).toBe(true);
        }
    });

    it('never lists the dead notifications route', () => {
        const hrefs = screensFor('/works/sample-id').map((screen) => screen.href);
        expect(hrefs).not.toContain(ROUTES.DASHBOARD_NOTIFICATIONS);
        expect(hrefs).toContain(ROUTES.DASHBOARD_SETTINGS_NOTIFICATIONS);
    });

    it('resolves every title and breadcrumb to an existing message', () => {
        const t = createEnTranslator();
        for (const screen of screensFor('/works/sample-id')) {
            expect(screen.title(t).length, screen.id).toBeGreaterThan(0);
            screen.breadcrumb?.(t);
        }
    });

    it('adds a Work’s sub-pages only while that Work is open', () => {
        expect(screensFor('/tasks')).toHaveLength(DASHBOARD_SCREENS.length);
        const inside = screensFor('/works/w1');
        expect(inside.length).toBeGreaterThan(DASHBOARD_SCREENS.length);
        expect(inside.find((screen) => screen.id === 'work.kb')?.href).toBe(
            ROUTES.DASHBOARD_WORK_KB('w1'),
        );
    });

    it('reaches the capability catalogue and its saved workflows', () => {
        const t = createEnTranslator();
        const byId = new Map(screensFor('/tasks').map((screen) => [screen.id, screen]));
        expect(byId.get('catalog')?.href).toBe(ROUTES.DASHBOARD_CATALOG);
        expect(byId.get('catalog')?.title(t)).toBe('Catalog');
        expect(byId.get('catalog.workflows')?.href).toBe(ROUTES.DASHBOARD_CATALOG_WORKFLOWS);
        expect(byId.get('catalog.workflows')?.breadcrumb?.(t)).toEqual(['Catalog']);
    });

    it('has unique ids', () => {
        const ids = screensFor('/works/w1').map((screen) => screen.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('record kinds', () => {
    it('labels every kind with an existing message', () => {
        const t = createEnTranslator();
        for (const descriptor of Object.values(PALETTE_KINDS)) {
            expect(descriptor.groupLabel(t).length).toBeGreaterThan(0);
        }
    });

    it('translates Task statuses and makes other statuses readable text', () => {
        const t = createEnTranslator();
        expect(statusBadge(t, 'task', 'in_review')).toBe('In review');
        expect(statusBadge(t, 'mission', 'active')).toBe('Active');
        expect(statusBadge(t, 'work', 'in_progress')).toBe('In progress');
        expect(statusBadge(t, 'agent', null)).toBeNull();
    });
});
