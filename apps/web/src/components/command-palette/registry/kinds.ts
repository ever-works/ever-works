import {
    Activity,
    Bot,
    Brain,
    Calendar,
    FileText,
    Folder,
    Gauge,
    Inbox,
    Lightbulb,
    ListChecks,
    Plug,
    Server,
    Sparkles,
    Target,
    Users,
    type LucideIcon,
} from 'lucide-react';
import type { WorkspaceSearchKind } from '@ever-works/contracts/api';
import { ROUTES } from '@/lib/constants';
import type { PaletteTranslator } from './types';

export interface PaletteKindDescriptor {
    icon: LucideIcon;
    /** Group heading, e.g. `Missions`. */
    groupLabel: (t: PaletteTranslator) => string;
    /** The list screen a filtered group can hand off to, when one exists. */
    listHref: string | null;
}

/**
 * Presentation for every record kind the workspace search can return. Group
 * labels use the program's own nouns; a kind with no list screen of its own
 * simply offers no "open the full list" escape hatch.
 */
export const PALETTE_KINDS: Record<WorkspaceSearchKind, PaletteKindDescriptor> = {
    mission: {
        icon: Target,
        groupLabel: (t) => t('dashboard.commandPalette.groups.missions'),
        listHref: ROUTES.DASHBOARD_MISSIONS,
    },
    task: {
        icon: ListChecks,
        groupLabel: (t) => t('dashboard.commandPalette.groups.tasks'),
        listHref: ROUTES.DASHBOARD_TASKS,
    },
    agent: {
        icon: Bot,
        groupLabel: (t) => t('dashboard.commandPalette.groups.agents'),
        listHref: ROUTES.DASHBOARD_AGENTS,
    },
    work: {
        icon: Folder,
        groupLabel: (t) => t('dashboard.commandPalette.groups.works'),
        listHref: ROUTES.DASHBOARD_WORKS,
    },
    idea: {
        icon: Lightbulb,
        groupLabel: (t) => t('dashboard.commandPalette.groups.ideas'),
        listHref: ROUTES.DASHBOARD_IDEAS,
    },
    skill: {
        icon: Sparkles,
        groupLabel: (t) => t('dashboard.commandPalette.groups.skills'),
        listHref: ROUTES.DASHBOARD_AGENTS_SKILLS,
    },
    team: {
        icon: Users,
        groupLabel: (t) => t('dashboard.commandPalette.groups.teams'),
        listHref: ROUTES.DASHBOARD_TEAMS,
    },
    knowledge: {
        icon: FileText,
        groupLabel: (t) => t('dashboard.commandPalette.groups.knowledge'),
        listHref: null,
    },
    run: {
        icon: Activity,
        groupLabel: (t) => t('dashboard.commandPalette.groups.runs'),
        listHref: null,
    },
    decision: {
        icon: Inbox,
        groupLabel: (t) => t('dashboard.commandPalette.groups.decisions'),
        listHref: null,
    },
    memory: {
        icon: Brain,
        groupLabel: (t) => t('dashboard.commandPalette.groups.memory'),
        listHref: ROUTES.DASHBOARD_MEMORY,
    },
    goal: {
        icon: Gauge,
        groupLabel: (t) => t('dashboard.commandPalette.groups.goals'),
        listHref: ROUTES.DASHBOARD_GOALS,
    },
    meeting: {
        icon: Calendar,
        groupLabel: (t) => t('dashboard.commandPalette.groups.meetings'),
        listHref: ROUTES.DASHBOARD_MEETINGS,
    },
    node: {
        icon: Server,
        groupLabel: (t) => t('dashboard.commandPalette.groups.computers'),
        listHref: null,
    },
    connection: {
        icon: Plug,
        groupLabel: (t) => t('dashboard.commandPalette.groups.connections'),
        listHref: null,
    },
};

export function isRecordKind(value: string): value is WorkspaceSearchKind {
    return Object.prototype.hasOwnProperty.call(PALETTE_KINDS, value);
}

/**
 * The badge text for a record's raw status. Task statuses reuse the Task
 * board's translated labels; other kinds show the stored value made readable,
 * so the badge always carries text rather than colour alone.
 */
export function statusBadge(
    t: PaletteTranslator,
    kind: WorkspaceSearchKind,
    status: string | null | undefined,
): string | null {
    if (!status) return null;
    if (kind === 'task') {
        const key = `dashboard.tasksPage.status.${status}`;
        if (t.has(key)) return t(key);
    }
    const readable = status.replace(/[_-]+/g, ' ').trim();
    return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : null;
}
