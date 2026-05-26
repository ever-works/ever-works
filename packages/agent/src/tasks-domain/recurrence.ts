import { RRule } from 'rrule';
import type { Task } from '../entities/task.entity';

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

export function validateRecurrenceRule(rule: string): { valid: true } | { valid: false; reason: string } {
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

/**
 * Phase 17.5 — clone a recurring template Task into a fresh
 * instance. Returns the partial entity ready to insert. Caller
 * (`TaskRecurrenceDispatcherService.dispatchDue`) sets the slug +
 * userTaskCounter increment.
 *
 * The clone:
 *   - copies identity (title, description, priority, labels, scope)
 *   - resets state (status=backlog, startedAt/completedAt=null,
 *     previousStatus=null)
 *   - sets parentRecurringTaskId = template.id
 *   - clears recurring columns (the instance is NOT itself recurring)
 *   - clears parentTaskId (recurrence ≠ sub-task; service-layer
 *     callers can re-link if needed)
 */
export function cloneRecurringTaskAsInstance(template: Task): Partial<Task> {
	return {
		userId: template.userId,
		title: template.title,
		description: template.description ?? null,
		status: 'backlog' as any,
		previousStatus: null,
		priority: template.priority,
		labels: template.labels ?? null,
		missionId: template.missionId ?? null,
		ideaId: template.ideaId ?? null,
		workId: template.workId ?? null,
		parentTaskId: null,
		createdByType: template.createdByType,
		createdById: template.createdById,
		requireAllApprovers: template.requireAllApprovers,
		startedAt: null,
		completedAt: null,
		// Recurring columns — the instance is not itself a template.
		isRecurring: false,
		recurrenceRule: null,
		recurrenceTimezone: null,
		nextOccurrenceAt: null,
		recurrenceEndsAt: null,
		recurrenceMaxOccurrences: null,
		recurrenceOccurredCount: 0,
		parentRecurringTaskId: template.id,
	};
}
