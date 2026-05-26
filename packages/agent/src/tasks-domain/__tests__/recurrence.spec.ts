import {
    validateRecurrenceRule,
    computeNextOccurrence,
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

    it('copies identity but resets state', () => {
        const clone = cloneRecurringTaskAsInstance(template);
        expect(clone.title).toBe('Daily standup notes');
        expect(clone.priority).toBe(TaskPriority.P2);
        expect(clone.labels).toEqual(['daily']);
        expect(clone.status).toBe('backlog');
        expect(clone.startedAt).toBeNull();
        expect(clone.completedAt).toBeNull();
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
