import { BookOpen, Building2, Files, FolderClosed, FolderOpen, Globe, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { WORK_KINDS, normalizeWorkKind, type WorkKind } from '@ever-works/contracts';

/**
 * How a Work "kind" is PRESENTED in the web app.
 *
 * The kind vocabulary itself and the capability matrix keyed off it live in
 * `@ever-works/contracts` (`work-kind.ts` / `work-capabilities.ts`) so the
 * API, the agent package and this app all agree. This module owns only what
 * contracts cannot: icons and Tailwind classes, which are React/Tailwind
 * concerns.
 *
 * The creation surfaces (`NewPageClient`, `NewWorkClient`,
 * `WorksCreateComposer`) keep their own chip catalogs because they also own
 * kind-specific placeholder examples and intent copy. This module covers the
 * smaller, universal concern — "given a kind, what icon, label and colour
 * does a badge use?" — so every read-only surface (cards, headers, info
 * blocks, filters) renders a kind identically.
 *
 * Every member of `WorkKind` is represented, including the two that are
 * never user-selectable at creation time:
 *   - `default` — the column default, carried by every Work that predates
 *     the kind-aware create path. Presented as the generic "Work".
 *   - `company` — minted only by the Register-Company flow
 *     (`WorkLifecycleService.createCompanyWork`).
 */
export { WORK_KINDS, normalizeWorkKind };

export type WorkKindValue = WorkKind;

export interface WorkKindPresentation {
    /** Lucide icon rendered inside the badge. */
    readonly icon: LucideIcon;
    /**
     * Tailwind classes for the badge pill. Kept as literal strings (not
     * composed at runtime) so Tailwind's class scanner can see them.
     */
    readonly tone: string;
}

export const WORK_KIND_PRESENTATION: Record<WorkKindValue, WorkKindPresentation> = {
    website: {
        icon: Globe,
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    },
    'landing-page': {
        icon: Files,
        tone: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
    },
    blog: {
        icon: BookOpen,
        tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    },
    directory: {
        icon: FolderOpen,
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    'awesome-repo': {
        icon: Star,
        tone: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    },
    company: {
        icon: Building2,
        tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
    },
    default: {
        icon: FolderClosed,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
};
