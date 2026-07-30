import type { TaskPriority } from '@/lib/api/tasks';

/**
 * How a Task priority is PRESENTED in the web app.
 *
 * Mirrors `@/lib/work-kinds/catalog` in intent: the vocabulary itself
 * (`TaskPriority`) lives in the API types; this module owns only the
 * Tailwind classes, which are a React/Tailwind concern.
 *
 * It exists so a priority reads identically wherever it is rendered —
 * the Tasks list/kanban pills, the detail page's Details rail, and the
 * New Task form's picker all take their colour from here. Without it the
 * surfaces drift, and a P2 that is amber on one screen and orange on the
 * next quietly teaches users that the colour means nothing.
 *
 * The hues are the ones the Tasks cards have always used (`pill`): the
 * two top priorities are red — P0 louder than P1 — P2 is warning, and
 * P3/P4 are deliberately neutral so only the urgent rows pull the eye.
 * `dot`/`tone`/`chip` are the same five hues in other shapes.
 */
export interface TaskPriorityPresentation {
    /** Tailwind `bg-*` for the solid dot. Passed to `Select` via `data-dot`. */
    readonly dot: string;
    /** Tailwind `text-*` for an accompanying label. */
    readonly tone: string;
    /**
     * Tailwind surface + border for a SELECTED chip in the priority picker
     * (`TaskPrioritySelect`). Tinted from the same hue as `dot`/`tone` so the
     * picked chip reads as the priority itself rather than a generic
     * "selected" highlight.
     */
    readonly chip: string;
    /**
     * Tailwind surface + text for the filled pill on a Task card, table row
     * or kanban card (`TasksList`, `TasksKanbanView`, `RecentTasks`). This is
     * the treatment users see first and most often, so it anchors the hue the
     * other three follow.
     */
    readonly pill: string;
}

export const TASK_PRIORITY_PRESENTATION: Record<TaskPriority, TaskPriorityPresentation> = {
    p0: {
        dot: 'bg-danger',
        tone: 'text-danger',
        chip: 'bg-danger/20 border-danger/50',
        pill: 'bg-danger/20 text-danger',
    },
    p1: {
        dot: 'bg-danger/70',
        tone: 'text-danger',
        chip: 'bg-danger/10 border-danger/40',
        pill: 'bg-danger/10 text-danger',
    },
    p2: {
        dot: 'bg-warning',
        tone: 'text-warning',
        chip: 'bg-warning/10 border-warning/40',
        pill: 'bg-warning/10 text-warning',
    },
    p3: {
        dot: 'bg-text-secondary',
        tone: 'text-text-secondary',
        chip: 'bg-surface-secondary border-border',
        pill: 'bg-surface-secondary text-text-secondary',
    },
    p4: {
        dot: 'bg-text-muted',
        tone: 'text-text-muted',
        chip: 'bg-text-muted/10 border-text-muted/40',
        pill: 'bg-text-muted/10 text-text-muted',
    },
};
