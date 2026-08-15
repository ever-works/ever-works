import { RRule } from 'rrule';
import { TaskStatus, type Task } from '../entities/task.entity';
import { parseCron } from '../missions/cron-matcher';
import { computeNextCronFire } from '../schedules/cadence';

/**
 * Tasks feature — Phase 17.2 / 17.3.
 *
 * RRULE validation + next-occurrence computation. Wraps the `rrule`
 * package so the rest of the platform doesn't need to import its
 * surface directly. All datetime math is in UTC; the per-template
 * `recurrenceTimezone` column is a hint for UI rendering, not for
 * the dispatcher.
 *
 * RRULE strings follow RFC 5545 (e.g. `FREQ=DAILY;BYHOUR=9`).
 */

export function validateRecurrenceRule(
    rule: string,
): { valid: true } | { valid: false; reason: string } {
    if (!rule || typeof rule !== 'string') {
        return { valid: false, reason: 'recurrenceRule is required when isRecurring=true.' };
    }
    if (rule.length > 200) {
        return { valid: false, reason: 'recurrenceRule exceeds 200 characters.' };
    }
    try {
        const parsed = RRule.fromString(rule);
        if (!parsed.options.freq && parsed.options.freq !== 0) {
            return { valid: false, reason: 'RRULE missing FREQ.' };
        }
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            reason: `RRULE parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Schedule-modes upgrade — validate a 5-field cron expression for the
 * `recurrenceCron` alternative cadence. Reuses the Mission tick worker's
 * `parseCron` so accepted syntax matches what the dispatcher later
 * evaluates via `computeNextCronFire` exactly.
 */
export function validateRecurrenceCron(
    expr: string,
): { valid: true } | { valid: false; reason: string } {
    if (!expr || typeof expr !== 'string') {
        return { valid: false, reason: 'recurrenceCron is required when provided.' };
    }
    if (expr.length > 120) {
        return { valid: false, reason: 'recurrenceCron exceeds 120 characters.' };
    }
    try {
        parseCron(expr.trim());
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            reason: `Cron parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

export interface NextOccurrenceContext {
    rule: string;
    from: Date;
    recurrenceEndsAt?: Date | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceOccurredCount?: number;
}

/**
 * Compute the next occurrence strictly after `from`. Honors
 * `recurrenceEndsAt` + `recurrenceMaxOccurrences` caps. Returns
 * null when the recurrence is exhausted (no more fires).
 */
export function computeNextOccurrence(ctx: NextOccurrenceContext): Date | null {
    if (
        ctx.recurrenceMaxOccurrences != null &&
        (ctx.recurrenceOccurredCount ?? 0) >= ctx.recurrenceMaxOccurrences
    ) {
        return null;
    }
    let parsed: RRule;
    try {
        parsed = RRule.fromString(ctx.rule);
    } catch {
        return null;
    }
    const next = parsed.after(ctx.from, false);
    if (!next) return null;
    if (ctx.recurrenceEndsAt && next.getTime() > ctx.recurrenceEndsAt.getTime()) {
        return null;
    }
    return next;
}

export interface TemplateCadenceContext {
    /** RFC 5545 RRULE — XOR with `cron`. */
    rule?: string | null;
    /** 5-field cron expression — XOR with `rule`. */
    cron?: string | null;
    from: Date;
    recurrenceEndsAt?: Date | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceOccurredCount?: number;
}

/**
 * Cadence-dialect-agnostic next occurrence: RRULE templates go through
 * {@link computeNextOccurrence}, cron templates through
 * `schedules/cadence.ts#computeNextCronFire`. Same caps
 * (`recurrenceEndsAt` / `recurrenceMaxOccurrences`) apply to both, so
 * the dispatcher does not need to know which dialect a template uses.
 */
export function computeNextTemplateOccurrence(ctx: TemplateCadenceContext): Date | null {
    if (ctx.rule) {
        return computeNextOccurrence({
            rule: ctx.rule,
            from: ctx.from,
            recurrenceEndsAt: ctx.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: ctx.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: ctx.recurrenceOccurredCount ?? 0,
        });
    }
    if (!ctx.cron) return null;
    if (
        ctx.recurrenceMaxOccurrences != null &&
        (ctx.recurrenceOccurredCount ?? 0) >= ctx.recurrenceMaxOccurrences
    ) {
        return null;
    }
    const nextIso = computeNextCronFire(ctx.cron, ctx.from);
    if (!nextIso) return null;
    const next = new Date(nextIso);
    if (ctx.recurrenceEndsAt && next.getTime() > ctx.recurrenceEndsAt.getTime()) {
        return null;
    }
    return next;
}

/**
 * Phase 17.5 — clone a recurring template Task into a fresh
 * instance. Returns the partial entity ready to insert. Caller
 * (`TaskRecurrenceDispatcherService.dispatchDue`) sets the slug +
 * userTaskCounter increment.
 *
 * The clone:
 *   - copies identity (title, description, priority, labels, FULL owner
 *     tuple — mission/idea/work AND team/agent/goal, so a spawned
 *     instance keeps the agent binding that lets it dispatch)
 *   - resets state (status=todo — instances are actionable, not parked
 *     in backlog; startedAt/completedAt=null, previousStatus=null)
 *   - sets parentRecurringTaskId = template.id
 *   - clears recurring + scheduled columns (the instance is NOT itself
 *     recurring, nor a one-shot)
 *   - clears parentTaskId (recurrence ≠ sub-task; service-layer
 *     callers can re-link if needed)
 *
 * Schedule-modes fix: previously the clone dropped teamId/agentId/goalId
 * (and the dispatcher copied no assignees), so spawned instances sat
 * inert with nothing to run them. Assignee rows are copied by the
 * dispatcher (`TaskRecurrenceDispatcherService`) since they live in a
 * side table this pure function cannot reach.
 */
export function cloneRecurringTaskAsInstance(template: Task): Partial<Task> {
    return {
        userId: template.userId,
        title: template.title,
        description: template.description ?? null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: template.priority,
        labels: template.labels ?? null,
        missionId: template.missionId ?? null,
        ideaId: template.ideaId ?? null,
        workId: template.workId ?? null,
        teamId: template.teamId ?? null,
        agentId: template.agentId ?? null,
        goalId: template.goalId ?? null,
        parentTaskId: null,
        createdByType: template.createdByType,
        createdById: template.createdById,
        requireAllApprovers: template.requireAllApprovers,
        startedAt: null,
        completedAt: null,
        // Recurring columns — the instance is not itself a template.
        isRecurring: false,
        recurrenceRule: null,
        recurrenceCron: null,
        recurrenceTimezone: null,
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: template.id,
        // One-shot columns — never inherited.
        scheduledAt: null,
        scheduleClaimedAt: null,
    };
}
