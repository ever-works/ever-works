import {
    validateRecurrenceRule,
    validateRecurrenceCron,
    computeNextOccurrence,
    computeNextTemplateOccurrence,
    cloneRecurringTaskAsInstance,
} from '../recurrence';
import { TaskPriority, TaskStatus } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

describe('recurrence.validateRecurrenceRule', () => {
    it('rejects empty input', () => {
        const out = validateRecurrenceRule('');
        expect(out.valid).toBe(false);
    });

    it('rejects rules over 200 chars', () => {
        const out = validateRecurrenceRule('FREQ=DAILY;' + 'X='.repeat(200));
        expect(out.valid).toBe(false);
    });

    it('rejects malformed input', () => {
        const out = validateRecurrenceRule('not-a-real-rule');
        expect(out.valid).toBe(false);
    });

    it('accepts a valid daily RRULE', () => {
        expect(validateRecurrenceRule('FREQ=DAILY').valid).toBe(true);
    });

    it('accepts a valid weekly RRULE with BYDAY', () => {
        expect(validateRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,WE,FR').valid).toBe(true);
    });
});

describe('recurrence.validateRecurrenceCron', () => {
    it('accepts a valid 5-field expression', () => {
        expect(validateRecurrenceCron('0 9 * * 1').valid).toBe(true);
    });

    it('rejects empty input', () => {
        expect(validateRecurrenceCron('').valid).toBe(false);
    });

    it('rejects a malformed expression', () => {
        expect(validateRecurrenceCron('not a cron').valid).toBe(false);
    });

    it('rejects out-of-range fields', () => {
        expect(validateRecurrenceCron('99 99 * * *').valid).toBe(false);
    });

    it('rejects expressions over 120 chars', () => {
        expect(validateRecurrenceCron('0 9 * * 1' + ' '.repeat(120)).valid).toBe(false);
    });
});

describe('recurrence.computeNextTemplateOccurrence', () => {
    it('routes RRULE templates through the rrule engine', () => {
        const next = computeNextTemplateOccurrence({
            rule: 'FREQ=DAILY',
            from: new Date('2026-05-26T00:00:00Z'),
        });
        expect(next).not.toBeNull();
        expect(next!.getTime()).toBeGreaterThan(new Date('2026-05-26T00:00:00Z').getTime());
    });

    it('routes cron templates through computeNextCronFire', () => {
        const next = computeNextTemplateOccurrence({
            cron: '0 9 * * *',
            from: new Date('2026-05-26T00:00:00Z'),
        });
        expect(next).not.toBeNull();
        expect(next!.getUTCHours()).toBe(9);
        expect(next!.getUTCMinutes()).toBe(0);
    });

    it('honors the max-occurrences cap for cron templates', () => {
        const next = computeNextTemplateOccurrence({
            cron: '0 9 * * *',
            from: new Date('2026-05-26T00:00:00Z'),
            recurrenceMaxOccurrences: 3,
            recurrenceOccurredCount: 3,
        });
        expect(next).toBeNull();
    });

    it('honors recurrenceEndsAt for cron templates', () => {
        const next = computeNextTemplateOccurrence({
            cron: '0 9 * * *',
            from: new Date('2026-05-26T10:00:00Z'),
            recurrenceEndsAt: new Date('2026-05-26T12:00:00Z'),
        });
        // Next 09:00 fire is the following day — past the end date.
        expect(next).toBeNull();
    });

    it('returns null when neither dialect is provided', () => {
        expect(computeNextTemplateOccurrence({ from: new Date() })).toBeNull();
    });

    it('returns null for an invalid cron expression', () => {
        expect(computeNextTemplateOccurrence({ cron: 'garbage', from: new Date() })).toBeNull();
    });
});

describe('recurrence.computeNextOccurrence', () => {
    it('returns null when the recurrence is exhausted by count', () => {
        const next = computeNextOccurrence({
            rule: 'FREQ=DAILY',
            from: new Date('2026-05-26T00:00:00Z'),
            recurrenceMaxOccurrences: 5,
            recurrenceOccurredCount: 5,
        });
        expect(next).toBeNull();
    });

    it('returns null when the next slot is past recurrenceEndsAt', () => {
        const next = computeNextOccurrence({
            rule: 'FREQ=DAILY',
            from: new Date('2026-05-26T00:00:00Z'),
            recurrenceEndsAt: new Date('2026-05-26T01:00:00Z'),
        });
        expect(next).toBeNull();
    });

    it('returns the next daily slot after `from`', () => {
        const next = computeNextOccurrence({
            rule: 'FREQ=DAILY',
            from: new Date('2026-05-26T00:00:00Z'),
        });
        expect(next).not.toBeNull();
        expect(next!.getTime()).toBeGreaterThan(new Date('2026-05-26T00:00:00Z').getTime());
    });

    it('returns null for an invalid rule', () => {
        const next = computeNextOccurrence({
            rule: 'GARBAGE',
            from: new Date(),
        });
        expect(next).toBeNull();
    });
});

describe('recurrence.cloneRecurringTaskAsInstance', () => {
    const template: Task = {
        id: 'tmpl-1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Daily standup notes',
        description: 'Take notes',
        status: TaskStatus.BACKLOG,
        previousStatus: null,
        priority: TaskPriority.P2,
        labels: ['daily'],
        missionId: 'm1',
        ideaId: null,
        workId: null,
        parentTaskId: 'parent-1',
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: true,
        recurrenceRule: 'FREQ=DAILY',
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: new Date(),
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 3,
        parentRecurringTaskId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as Task;

    it('copies identity but resets state (instances land actionable in todo)', () => {
        const clone = cloneRecurringTaskAsInstance(template);
        expect(clone.title).toBe('Daily standup notes');
        expect(clone.priority).toBe(TaskPriority.P2);
        expect(clone.labels).toEqual(['daily']);
        // Schedule-modes fix: instances are created `todo` (actionable +
        // dispatchable), no longer parked in backlog.
        expect(clone.status).toBe('todo');
        expect(clone.startedAt).toBeNull();
        expect(clone.completedAt).toBeNull();
    });

    it('keeps the FULL owner tuple — teamId/agentId/goalId no longer dropped', () => {
        const clone = cloneRecurringTaskAsInstance({
            ...template,
            teamId: 'team-1',
            agentId: 'agent-1',
            goalId: 'goal-1',
            workId: 'work-1',
        } as Task);
        expect(clone.teamId).toBe('team-1');
        expect(clone.agentId).toBe('agent-1');
        expect(clone.goalId).toBe('goal-1');
        expect(clone.workId).toBe('work-1');
        expect(clone.missionId).toBe('m1');
    });

    it('clears the one-shot schedule columns on the instance', () => {
        const clone = cloneRecurringTaskAsInstance({
            ...template,
            scheduledAt: new Date(),
            scheduleClaimedAt: new Date(),
        } as Task);
        expect(clone.scheduledAt).toBeNull();
        expect(clone.scheduleClaimedAt).toBeNull();
        expect(clone.recurrenceCron).toBeNull();
    });

    it('sets parentRecurringTaskId and clears recurring columns on the instance', () => {
        const clone = cloneRecurringTaskAsInstance(template);
        expect(clone.parentRecurringTaskId).toBe('tmpl-1');
        expect(clone.isRecurring).toBe(false);
        expect(clone.recurrenceRule).toBeNull();
        expect(clone.nextOccurrenceAt).toBeNull();
        expect(clone.recurrenceOccurredCount).toBe(0);
    });

    it('clears parentTaskId on the instance (recurrence ≠ sub-task)', () => {
        const clone = cloneRecurringTaskAsInstance(template);
        expect(clone.parentTaskId).toBeNull();
    });
});
