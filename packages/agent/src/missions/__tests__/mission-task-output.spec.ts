import {
    missionFilesTasks,
    normalizeMissionOutputMode,
    normalizeMissionTaskOutput,
} from '../mission-task-output';

/**
 * APW-08 T34 — a Mission's output, read without trusting the stored value: every field in bounds
 * or its default, garbage toward the defaults (plan §3.3), an unknown mode as `ideas`.
 */
describe('normalizeMissionTaskOutput (APW-08 T34)', () => {
    const AGENT = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    it.each([
        ['nothing', undefined, { tasksPerTick: 1, openTasksCap: 3 }],
        ['null', null, { tasksPerTick: 1, openTasksCap: 3 }],
        ['an array', [2, 5], { tasksPerTick: 1, openTasksCap: 3 }],
        ['a string', 'tasks', { tasksPerTick: 1, openTasksCap: 3 }],
        [
            'the bounds',
            { tasksPerTick: 3, openTasksCap: 10 },
            { tasksPerTick: 3, openTasksCap: 10 },
        ],
        ['the floors', { tasksPerTick: 1, openTasksCap: 1 }, { tasksPerTick: 1, openTasksCap: 1 }],
        [
            'over the ceilings',
            { tasksPerTick: 4, openTasksCap: 11 },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'under the floors',
            { tasksPerTick: 0, openTasksCap: -1 },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'non-integers',
            { tasksPerTick: 1.5, openTasksCap: '5' },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'an agent id',
            { agentId: AGENT },
            { tasksPerTick: 1, openTasksCap: 3, agentId: AGENT.toLowerCase() },
        ],
        ['a non-uuid agent id', { agentId: 'agent-1' }, { tasksPerTick: 1, openTasksCap: 3 }],
    ])('%s', (_name, raw, expected) => {
        expect(normalizeMissionTaskOutput(raw)).toEqual(expected);
    });
});

describe('the output mode (APW-08 T34)', () => {
    it('keeps the three modes and reads anything else as ideas', () => {
        expect(['ideas', 'tasks', 'both'].map(normalizeMissionOutputMode)).toEqual([
            'ideas',
            'tasks',
            'both',
        ]);
        for (const raw of [undefined, null, '', 'TASKS', 'all', 3]) {
            expect(normalizeMissionOutputMode(raw)).toBe('ideas');
        }
    });

    it('files Tasks for tasks and both only', () => {
        expect(missionFilesTasks('tasks')).toBe(true);
        expect(missionFilesTasks('both')).toBe(true);
        expect(missionFilesTasks('ideas')).toBe(false);
        expect(missionFilesTasks('garbage')).toBe(false);
    });
});
