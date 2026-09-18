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
    ListChecks,
    Plug,
    Settings,
    Sparkles,
    Target,
    Users,
    Folder,
} from 'lucide-react';
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

/**
 * The screens available from `pathname`: every dashboard screen, plus the
 * sub-pages of the Work being viewed when the operator is inside one.
 */
export function screensFor(pathname: string): PaletteScreen[] {
    const workId = getWorkIdFromPath(pathname);
    if (!workId) return [...DASHBOARD_SCREENS];
    return [
        ...DASHBOARD_SCREENS,
        ...WORK_SUBPAGES.map((screen) => ({
            id: `work.${screen.id}`,
            href: screen.href(workId),
            icon: FileText,
            title: screen.title,
            breadcrumb: (t: PaletteTranslator) => [t('dashboard.sidebar.navigation.works')],
        })),
    ];
}
