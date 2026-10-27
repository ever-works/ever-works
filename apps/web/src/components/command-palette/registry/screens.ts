import {
    Activity,
    Bot,
    Brain,
    Calendar,
    CalendarClock,
    Compass,
    CreditCard,
    FileText,
    Gauge,
    GitFork,
    Home,
    Inbox,
    LayoutTemplate,
    Lightbulb,
    Monitor,
    ListChecks,
    Plug,
    ScrollText,
    Server,
    Settings,
    Sparkles,
    Target,
    Users,
    Folder,
    Workflow,
} from 'lucide-react';
import { FLEET_ACTIONS_RUNNER_CAPABILITY } from '@ever-works/contracts';
import { actionsJobsHref, runnersInstallHref } from '@/components/fleet/runners/runners.shared';
import { ROUTES } from '@/lib/constants';
import { getWorkIdFromPath } from '@/lib/utils/work-route';
import type { PaletteScreen, PaletteTranslator } from './types';

const settings = (t: PaletteTranslator) => [t('dashboard.settings.title')];

/**
 * Every top-level dashboard screen and every Settings sub-page, built from
 * `ROUTES` so a moved path cannot drift from the palette. Titles reuse the
 * sidebar and Settings-tab labels that already exist and are already
 * translated.
 *
 * `ROUTES.DASHBOARD_NOTIFICATIONS` is deliberately absent: `constants.ts`
 * documents it as a route with no page (it soft-404s). The Settings →
 * Notifications entry points at `DASHBOARD_SETTINGS_NOTIFICATIONS` instead.
 */
export const DASHBOARD_SCREENS: readonly PaletteScreen[] = [
    {
        id: 'home',
        href: ROUTES.DASHBOARD,
        icon: Home,
        title: (t) => t('dashboard.sidebar.navigation.dashboard'),
    },
    {
        id: 'inbox',
        href: ROUTES.DASHBOARD_INBOX,
        icon: Inbox,
        title: (t) => t('dashboard.sidebar.navigation.inbox'),
    },
    {
        id: 'missions',
        href: ROUTES.DASHBOARD_MISSIONS,
        icon: Target,
        title: (t) => t('dashboard.sidebar.navigation.missions'),
    },
    {
        id: 'goals',
        href: ROUTES.DASHBOARD_GOALS,
        icon: Gauge,
        title: (t) => t('dashboard.sidebar.navigation.goals'),
    },
    {
        id: 'ideas',
        href: ROUTES.DASHBOARD_IDEAS,
        icon: Lightbulb,
        title: (t) => t('dashboard.sidebar.navigation.ideas'),
    },
    {
        id: 'works',
        href: ROUTES.DASHBOARD_WORKS,
        icon: Folder,
        title: (t) => t('dashboard.sidebar.navigation.works'),
    },
    {
        id: 'tasks',
        href: ROUTES.DASHBOARD_TASKS,
        icon: ListChecks,
        title: (t) => t('dashboard.sidebar.navigation.tasks'),
    },
    {
        id: 'agents',
        href: ROUTES.DASHBOARD_AGENTS,
        icon: Bot,
        title: (t) => t('dashboard.sidebar.navigation.agents'),
    },
    {
        id: 'skills',
        href: ROUTES.DASHBOARD_AGENTS_SKILLS,
        icon: Sparkles,
        title: (t) => t('dashboard.sidebar.navigation.skills'),
    },
    {
        id: 'teams',
        href: ROUTES.DASHBOARD_TEAMS,
        icon: Users,
        title: (t) => t('dashboard.sidebar.navigation.teams'),
    },
    {
        id: 'memory',
        href: ROUTES.DASHBOARD_MEMORY,
        icon: Brain,
        title: (t) => t('dashboard.sidebar.navigation.memory'),
    },
    {
        id: 'meetings',
        href: ROUTES.DASHBOARD_MEMORY_MEETINGS,
        icon: Calendar,
        title: (t) => t('dashboard.sidebar.navigation.meetings'),
    },
    {
        id: 'templates',
        href: ROUTES.DASHBOARD_TEMPLATES,
        icon: LayoutTemplate,
        title: (t) => t('dashboard.sidebar.navigation.templates'),
    },
    // Capability & playbook catalogue (AW-21). Reached from the palette
    // rather than a new sidebar entry; its title reuses the navigation label.
    {
        id: 'catalog',
        href: ROUTES.DASHBOARD_CATALOG,
        icon: Compass,
        title: (t) => t('dashboard.sidebar.navigation.catalog'),
    },
    {
        id: 'catalog.workflows',
        href: ROUTES.DASHBOARD_CATALOG_WORKFLOWS,
        icon: GitFork,
        title: (t) => t('dashboard.catalogPage.sections.workflows'),
        breadcrumb: (t) => [t('dashboard.sidebar.navigation.catalog')],
    },
    {
        id: 'plugins',
        href: ROUTES.DASHBOARD_PLUGINS,
        icon: Plug,
        title: (t) => t('dashboard.sidebar.navigation.plugins'),
    },
    {
        // The Schedules list lives on the Activity page now; the entry stays
        // (people search for "schedules", not for "activity") but points at the
        // view that owns it instead of at a redirect.
        id: 'schedules',
        href: ROUTES.DASHBOARD_ACTIVITY_SCHEDULES,
        icon: CalendarClock,
        title: (t) => t('dashboard.sidebar.navigation.schedules'),
    },
    {
        id: 'activity',
        href: ROUTES.DASHBOARD_ACTIVITY,
        icon: Activity,
        title: (t) => t('dashboard.sidebar.navigation.activity'),
    },
    {
        id: 'settings.profile',
        href: ROUTES.DASHBOARD_SETTINGS_PROFILE,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.profile'),
        breadcrumb: settings,
    },
    {
        id: 'settings.organization',
        href: `${ROUTES.DASHBOARD_SETTINGS}/organization`,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.organization'),
        breadcrumb: settings,
    },
    {
        id: 'settings.security',
        href: ROUTES.DASHBOARD_SETTINGS_SECURITY,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.security'),
        breadcrumb: settings,
    },
    {
        id: 'settings.apiKeys',
        href: ROUTES.DASHBOARD_SETTINGS_API_KEYS,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.apiKeys'),
        breadcrumb: settings,
    },
    {
        id: 'settings.data',
        href: ROUTES.DASHBOARD_SETTINGS_DATA,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.data'),
        breadcrumb: settings,
    },
    {
        id: 'settings.githubApp',
        href: ROUTES.DASHBOARD_SETTINGS_GITHUB_APP,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.githubApp'),
        breadcrumb: settings,
    },
    {
        id: 'settings.repositories',
        href: ROUTES.DASHBOARD_SETTINGS_REPOSITORIES,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.repositories'),
        breadcrumb: settings,
    },
    {
        id: 'settings.workAgent',
        href: ROUTES.DASHBOARD_SETTINGS_WORK_AGENT,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.workAgent'),
        breadcrumb: settings,
    },
    {
        id: 'settings.fleet',
        href: ROUTES.DASHBOARD_SETTINGS_FLEET,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.fleet'),
        breadcrumb: settings,
    },
    {
        id: 'settings.jobRuntime',
        href: ROUTES.DASHBOARD_SETTINGS_JOB_RUNTIME,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.jobRuntime'),
        breadcrumb: settings,
    },
    {
        id: 'settings.environments',
        href: ROUTES.DASHBOARD_SETTINGS_ENVIRONMENTS,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.environments'),
        breadcrumb: settings,
    },
    {
        id: 'settings.connections',
        href: `${ROUTES.DASHBOARD_SETTINGS}/connections`,
        icon: Plug,
        title: (t) => t('dashboard.settings.tabs.connections'),
        breadcrumb: settings,
    },
    {
        id: 'settings.agentPlugins',
        href: ROUTES.DASHBOARD_SETTINGS_AGENT_PLUGINS,
        icon: Plug,
        title: (t) => t('dashboard.settings.tabs.agentPlugins'),
        breadcrumb: settings,
    },
    {
        id: 'settings.digest',
        href: `${ROUTES.DASHBOARD_SETTINGS}/digest`,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.digest'),
        breadcrumb: settings,
    },
    {
        id: 'settings.notifications',
        href: ROUTES.DASHBOARD_SETTINGS_NOTIFICATIONS,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.notifications'),
        breadcrumb: settings,
    },
    {
        id: 'settings.channels',
        href: `${ROUTES.DASHBOARD_SETTINGS}/integrations/channels`,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.channels'),
        breadcrumb: settings,
    },
    {
        id: 'settings.emails',
        href: `${ROUTES.DASHBOARD_SETTINGS}/integrations/emails`,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.emails'),
        breadcrumb: settings,
    },
    {
        id: 'settings.billing',
        href: ROUTES.DASHBOARD_SETTINGS_BILLING,
        icon: CreditCard,
        title: (t) => t('dashboard.settings.tabs.billing'),
        breadcrumb: settings,
    },
    {
        id: 'settings.usage',
        href: ROUTES.DASHBOARD_USAGE,
        icon: CreditCard,
        title: (t) => t('dashboard.settings.tabs.usageCredits'),
        breadcrumb: settings,
    },
    {
        id: 'settings.dangerZone',
        href: ROUTES.DASHBOARD_SETTINGS_DANGER_ZONE,
        icon: Settings,
        title: (t) => t('dashboard.settings.tabs.dangerZone'),
        breadcrumb: settings,
    },
];

/**
 * Fleet hub (FL-01, FR-13) — "Fleet" and its six hub tabs, offered only while
 * the hub is on (`FLEET_ENABLED` + `FLEET_HUB_ENABLED`); with it off the
 * palette lists exactly what it listed before (FR-15). They sit right after
 * Teams, the way the sidebar entry does.
 */
const fleet = (t: PaletteTranslator) => [t('fleet.nav.label')];

export const FLEET_HUB_SCREENS: readonly PaletteScreen[] = [
    {
        id: 'fleet',
        href: ROUTES.DASHBOARD_FLEET,
        icon: Server,
        title: (t) => t('fleet.nav.label'),
    },
    {
        id: 'fleet.overview',
        href: ROUTES.DASHBOARD_FLEET,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.overview'),
        breadcrumb: fleet,
    },
    {
        id: 'fleet.computers',
        href: ROUTES.DASHBOARD_FLEET_COMPUTERS,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.computers'),
        breadcrumb: fleet,
    },
    {
        id: 'fleet.sessions',
        href: ROUTES.DASHBOARD_FLEET_SESSIONS,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.sessions'),
        breadcrumb: fleet,
    },
    {
        id: 'fleet.checkouts',
        href: ROUTES.DASHBOARD_FLEET_CHECKOUTS,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.checkouts'),
        breadcrumb: fleet,
    },
    {
        id: 'fleet.commands',
        href: ROUTES.DASHBOARD_FLEET_COMMANDS,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.commands'),
        breadcrumb: fleet,
    },
    {
        id: 'fleet.usage',
        href: ROUTES.DASHBOARD_FLEET_USAGE,
        icon: Server,
        title: (t) => t('fleet.hub.tabs.usage'),
        breadcrumb: fleet,
    },
];

/**
 * Fleet hub (FL-01, FR-33, T-27) — "Go to computer <name>" for every computer
 * the viewer may see, matched on its name like any other screen. The palette
 * reads the computers when it opens (`useFleetPaletteComputers`) and adds
 * these after the fixed list; with the hub off it reads none.
 */
export function fleetComputerScreens(
    computers: ReadonlyArray<{ id: string; name: string }>,
    options: { logs?: boolean } = {},
): PaletteScreen[] {
    const screens: PaletteScreen[] = computers.map((computer) => ({
        id: `fleet.computer.${computer.id}`,
        href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id),
        icon: Monitor,
        title: (t: PaletteTranslator) => t('fleet.palette.goToComputer', { name: computer.name }),
        breadcrumb: fleet,
    }));
    // Logs on computers (FL-08, FR-33): "Logs on <computer>" for every
    // computer the viewer may see, opening its Logs tab — only while machine
    // facts are on (the tab is not registered otherwise).
    if (options.logs) {
        for (const computer of computers) {
            screens.push({
                id: `fleet.computer.${computer.id}.logs`,
                href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id, 'logs'),
                icon: ScrollText,
                title: (t: PaletteTranslator) => t('fleet.logs.palette', { name: computer.name }),
                breadcrumb: fleet,
            });
        }
    }
    return screens;
}

/**
 * Services, Docker and processes (FL-09, FR-23) — "Services on <name>",
 * "Docker on <name>" and "Processes on <name>" for every computer the viewer
 * may see that advertises the matching tag (a node only does under
 * `--manage`), each opening that computer's tab. Docker's tab arrives with
 * FL-09 P2; until then its row opens the tab's placeholder.
 */
const FLEET_MACHINE_TABS = [
    { tag: 'services', tab: 'services', key: 'fleet.palette.servicesOn' },
    { tag: 'docker', tab: 'docker', key: 'fleet.palette.dockerOn' },
    { tag: 'processes', tab: 'processes', key: 'fleet.palette.processesOn' },
    // Files on computers (FL-11, spec §5.9): "Files on <name>" for a computer with an allowed root.
    { tag: 'files', tab: 'files', key: 'fleet.palette.filesOn' },
] as const;

export function fleetComputerMachineScreens(
    computers: ReadonlyArray<{ id: string; name: string; capabilities?: readonly string[] }>,
): PaletteScreen[] {
    const out: PaletteScreen[] = [];
    for (const computer of computers) {
        for (const entry of FLEET_MACHINE_TABS) {
            if (!computer.capabilities?.includes(entry.tag)) continue;
            out.push({
                id: `fleet.computer.${computer.id}.${entry.tab}`,
                href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id, entry.tab),
                icon: Monitor,
                title: (t: PaletteTranslator) => t(entry.key, { name: computer.name }),
                breadcrumb: fleet,
            });
        }
    }
    return out;
}

/**
 * Servers and ports (FL-10, FR-21) — "Ports on <computer>" for every computer
 * the viewer may see that advertises `ports` (a node only does under
 * `--manage`), opening its Ports tab.
 */
export function fleetComputerPortsScreens(
    computers: ReadonlyArray<{ id: string; name: string; capabilities?: readonly string[] }>,
): PaletteScreen[] {
    // Like FL-09's rows: only a computer that advertises the tag (`ports`, under `--manage`).
    return computers
        .filter((computer) => computer.capabilities?.includes('ports') ?? false)
        .map((computer) => ({
            id: `fleet.computer.${computer.id}.ports`,
            href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id, 'ports'),
            icon: Monitor,
            title: (t: PaletteTranslator) => t('fleet.palette.portsOn', { name: computer.name }),
            breadcrumb: fleet,
        }));
}

/**
 * Virtual computers (FL-16, spec FR-34, §5.9) — "New virtual computer" (the
 * Computers tab with the dialog open) and, for every virtual computer the
 * viewer may see, "Start <name>" or "Stop <name>", opening its page where the
 * act and its confirmation live. Only while `FLEET_VIRTUAL_ENABLED` is on.
 */
export function fleetVirtualScreens(
    computers: ReadonlyArray<{ id: string; name: string; hostNodeId?: string; virtualState?: string }>,
    enabled: boolean,
): PaletteScreen[] {
    if (!enabled) return [];
    const screens: PaletteScreen[] = [
        {
            id: 'fleet.virtual.new',
            href: `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=virtual`,
            icon: Server,
            title: (t: PaletteTranslator) => t('fleet.virtual.palette.newVirtual'),
            breadcrumb: fleet,
        },
    ];
    for (const computer of computers) {
        if (!computer.hostNodeId) continue;
        const running = computer.virtualState === 'running';
        if (!running && computer.virtualState !== 'stopped') continue;
        screens.push({
            id: `fleet.virtual.${computer.id}.${running ? 'stop' : 'start'}`,
            href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id),
            icon: Monitor,
            title: (t: PaletteTranslator) =>
                running
                    ? t('fleet.virtual.palette.stop', { name: computer.name })
                    : t('fleet.virtual.palette.start', { name: computer.name }),
            breadcrumb: fleet,
        });
    }
    return screens;
}

/**
 * Cloud computers (FL-17, spec §5.8) — "New cloud computer" (the Computers tab
 * with the dialog open) and, for every cloud computer the viewer may see,
 * "Power off <name>" or "Power on <name>", opening its page where the act and
 * its confirmation (with the billing sentence) live. Only while
 * `FLEET_CLOUD_ENABLED` is on.
 */
export function fleetCloudScreens(
    computers: ReadonlyArray<{ id: string; name: string; cloudPowerState?: string }>,
    enabled: boolean,
): PaletteScreen[] {
    if (!enabled) return [];
    const screens: PaletteScreen[] = [
        {
            id: 'fleet.cloud.new',
            href: `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=cloud`,
            icon: Server,
            title: (t: PaletteTranslator) => t('fleet.cloud.palette.newCloud'),
            breadcrumb: fleet,
        },
    ];
    for (const computer of computers) {
        const running = computer.cloudPowerState === 'running';
        if (!running && computer.cloudPowerState !== 'off') continue;
        screens.push({
            id: `fleet.cloud.${computer.id}.${running ? 'off' : 'on'}`,
            href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.id),
            icon: Monitor,
            title: (t: PaletteTranslator) =>
                running
                    ? t('fleet.cloud.palette.powerOff', { name: computer.name })
                    : t('fleet.cloud.palette.powerOn', { name: computer.name }),
            breadcrumb: fleet,
        });
    }
    return screens;
}

/**
 * Usage & cost on the fleet (FL-20 P2, spec §5.6) — "Fleet usage" (the hub's
 * Usage tab) and "Usage on <computer>" (the tab filtered to it) for every
 * computer the viewer may see. Only while `FLEET_USAGE_SCAN_ENABLED` is on.
 */
export function fleetUsageScreens(
    computers: ReadonlyArray<{ id: string; name: string }>,
    enabled: boolean,
): PaletteScreen[] {
    if (!enabled) return [];
    const screens: PaletteScreen[] = [
        {
            id: 'fleet.usage',
            href: ROUTES.DASHBOARD_FLEET_USAGE,
            icon: Server,
            title: (t: PaletteTranslator) => t('fleet.usage.palette.usage'),
            breadcrumb: fleet,
        },
    ];
    for (const computer of computers) {
        screens.push({
            id: `fleet.usage.${computer.id}`,
            href: `${ROUTES.DASHBOARD_FLEET_USAGE}?node=${encodeURIComponent(computer.id)}`,
            icon: Monitor,
            title: (t: PaletteTranslator) => t('fleet.usage.palette.usageOn', { name: computer.name }),
            breadcrumb: fleet,
        });
    }
    return screens;
}

/**
 * Actions runners on computers (FL-18, spec §5.7) — "Install Actions runners on
 * <name>" for every computer the viewer may see that advertises
 * `actions-runner` (a node with `--work` and a service manager), opening its
 * Overview with the Install dialog open (the dialog, its confirmation and the
 * server decide the rest). Only while `FLEET_ACTIONS_RUNNERS_ENABLED` is on.
 */
export function fleetRunnersScreens(
    computers: ReadonlyArray<{ id: string; name: string; capabilities?: readonly string[] }>,
    enabled: boolean,
): PaletteScreen[] {
    if (!enabled) return [];
    return computers
        .filter(
            (computer) => computer.capabilities?.includes(FLEET_ACTIONS_RUNNER_CAPABILITY) ?? false,
        )
        .map((computer) => ({
            id: `fleet.runners.${computer.id}.install`,
            href: runnersInstallHref(computer.id),
            icon: Workflow,
            title: (t: PaletteTranslator) =>
                t('fleet.runners.palette.install', { name: computer.name }),
            breadcrumb: fleet,
        }));
}

/**
 * Actions jobs (FL-18 P2, spec §5.7) — "Actions jobs": the hub's Overview at
 * its Actions jobs panel (a panel, not a tab or a route, CONTRACTS R-37). Only
 * while `FLEET_ACTIONS_RUNNERS_ENABLED` is on.
 */
export function fleetActionsJobsScreens(enabled: boolean): PaletteScreen[] {
    if (!enabled) return [];
    return [
        {
            id: 'fleet.runners.jobs',
            href: actionsJobsHref(),
            icon: Workflow,
            title: (t: PaletteTranslator) => t('fleet.runners.palette.jobs'),
            breadcrumb: fleet,
        },
    ];
}

/** What decides which screens exist beyond the fixed list. */
export interface ScreensForOptions {
    /** Fleet hub (FL-01): add the hub's screens after Teams. */
    fleetHubEnabled?: boolean;
}

function dashboardScreens(options: ScreensForOptions): PaletteScreen[] {
    if (!options.fleetHubEnabled) return [...DASHBOARD_SCREENS];
    const at = DASHBOARD_SCREENS.findIndex((screen) => screen.id === 'teams') + 1;
    return [
        ...DASHBOARD_SCREENS.slice(0, at),
        ...FLEET_HUB_SCREENS,
        ...DASHBOARD_SCREENS.slice(at),
    ];
}

type WorkScreenBuilder = {
    id: string;
    href: (workId: string) => string;
    title: (t: PaletteTranslator) => string;
};

/** Sub-pages of one Work, offered only while that Work is the current context. */
const WORK_SUBPAGES: readonly WorkScreenBuilder[] = [
    {
        id: 'overview',
        href: ROUTES.DASHBOARD_WORK,
        title: (t) => t('dashboard.workDetail.tabs.overview'),
    },
    {
        id: 'activity',
        href: ROUTES.DASHBOARD_WORK_ACTIVITY,
        title: (t) => t('dashboard.workDetail.tabs.activity'),
    },
    {
        id: 'items',
        href: ROUTES.DASHBOARD_WORK_ITEMS,
        title: (t) => t('dashboard.workDetail.tabs.items'),
    },
    {
        id: 'tasks',
        href: (id) => `${ROUTES.DASHBOARD_WORK(id)}/tasks`,
        title: (t) => t('dashboard.workDetail.tabs.tasks'),
    },
    {
        id: 'pullRequests',
        href: ROUTES.DASHBOARD_WORK_PULL_REQUESTS,
        title: (t) => t('dashboard.workDetail.tabs.pullRequests'),
    },
    { id: 'kb', href: ROUTES.DASHBOARD_WORK_KB, title: (t) => t('dashboard.workDetail.tabs.kb') },
    {
        id: 'generator',
        href: ROUTES.DASHBOARD_WORK_GENERATOR,
        title: (t) => t('dashboard.workDetail.tabs.generator'),
    },
    {
        id: 'schedule',
        href: ROUTES.DASHBOARD_WORK_SCHEDULE,
        title: (t) => t('dashboard.workDetail.tabs.schedule'),
    },
    {
        id: 'history',
        href: ROUTES.DASHBOARD_WORK_HISTORY,
        title: (t) => t('dashboard.workDetail.tabs.history'),
    },
    {
        id: 'comparisons',
        href: ROUTES.DASHBOARD_WORK_COMPARISONS,
        title: (t) => t('dashboard.workDetail.tabs.comparisons'),
    },
    {
        id: 'deploy',
        href: ROUTES.DASHBOARD_WORK_DEPLOY,
        title: (t) => t('dashboard.workDetail.tabs.deploy'),
    },
    {
        id: 'plugins',
        href: ROUTES.DASHBOARD_WORK_PLUGINS,
        title: (t) => t('dashboard.workDetail.tabs.plugins'),
    },
    {
        id: 'members',
        href: ROUTES.DASHBOARD_WORK_MEMBERS,
        title: (t) => t('dashboard.workDetail.tabs.members'),
    },
    {
        id: 'settings',
        href: ROUTES.DASHBOARD_WORK_SETTINGS,
        title: (t) => t('dashboard.workDetail.tabs.settings'),
    },
];

/** FL-19 (spec §5.4) — the Agent whose pages are open (`/agents/<uuid>…`, any locale prefix), or null. */
export function getAgentIdFromPath(pathname: string): string | null {
    const match =
        /(?:^|\/)agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$|\?|#)/i.exec(
            pathname,
        );
    return match ? match[1] : null;
}

/**
 * FL-19 (spec §5.4) — "Fleet tools for this Agent": the Capabilities tab's Fleet tools block of the
 * Agent being viewed (what it may read and do on my computers, and which gate refuses).
 */
export function agentFleetToolsScreens(
    pathname: string,
    options: { fleetEnabled?: boolean } = {},
): PaletteScreen[] {
    if (options.fleetEnabled === false) return [];
    const agentId = getAgentIdFromPath(pathname);
    if (!agentId) return [];
    return [
        {
            id: `agent.fleetTools.${agentId}`,
            href: `${ROUTES.DASHBOARD_AGENT_CAPABILITIES(agentId)}#fleet-tools`,
            icon: Server,
            title: (t: PaletteTranslator) => t('fleet.tools.palette.forThisAgent'),
            breadcrumb: (t: PaletteTranslator) => [t('dashboard.sidebar.navigation.agents')],
        },
    ];
}

/**
 * The screens available from `pathname`: every dashboard screen, plus the
 * sub-pages of the Work being viewed when the operator is inside one, plus
 * (FL-19) the Agent's Fleet tools when an Agent's pages are open.
 */
export function screensFor(pathname: string, options: ScreensForOptions = {}): PaletteScreen[] {
    const workId = getWorkIdFromPath(pathname);
    const screens = [
        ...dashboardScreens(options),
        ...agentFleetToolsScreens(pathname, { fleetEnabled: options.fleetHubEnabled }),
    ];
    if (!workId) return screens;
    return [
        ...screens,
        ...WORK_SUBPAGES.map((screen) => ({
            id: `work.${screen.id}`,
            href: screen.href(workId),
            icon: FileText,
            title: screen.title,
            breadcrumb: (t: PaletteTranslator) => [t('dashboard.sidebar.navigation.works')],
        })),
    ];
}
