import { resolveTaskIsolation, taskBranchName } from '../task-isolation';

describe('resolveTaskIsolation', () => {
    const workOn = { taskIsolation: 'worktree' };
    const workOff = { taskIsolation: 'off' };

    it('defaults OFF: no setting anywhere means exactly today’s behavior', () => {
        expect(resolveTaskIsolation({ workId: 'w1' }, workOff)).toBe('off');
        expect(resolveTaskIsolation({ workId: 'w1' }, null)).toBe('off');
        expect(resolveTaskIsolation({ workId: 'w1' }, undefined)).toBe('off');
    });

    it('inherits the Work setting when the Task does not override', () => {
        expect(resolveTaskIsolation({ workId: 'w1', isolationMode: null }, workOn)).toBe('on');
    });

    it('the per-Task override wins in BOTH directions', () => {
        expect(resolveTaskIsolation({ workId: 'w1', isolationMode: 'off' }, workOn)).toBe('off');
        expect(resolveTaskIsolation({ workId: 'w1', isolationMode: 'on' }, workOff)).toBe('on');
    });

    it('clamps OFF when the Task has no Work (nothing to branch)', () => {
        expect(resolveTaskIsolation({ workId: null, isolationMode: 'on' }, workOn)).toBe('off');
        expect(resolveTaskIsolation({}, workOn)).toBe('off');
    });

    it('clamps OFF when the Agent cannot commit to repos', () => {
        expect(
            resolveTaskIsolation({ workId: 'w1', isolationMode: 'on' }, workOn, {
                agentCanCommit: false,
            }),
        ).toBe('off');
    });

    it('unknown isolationMode values fall back to inheritance (never crash)', () => {
        expect(resolveTaskIsolation({ workId: 'w1', isolationMode: 'banana' }, workOn)).toBe('on');
        expect(resolveTaskIsolation({ workId: 'w1', isolationMode: 'banana' }, workOff)).toBe(
            'off',
        );
    });
});

describe('taskBranchName', () => {
    const id = '9f3c1a2b-1111-4222-8333-444455556666';

    it('is deterministic and carries slug readability + id uniqueness', () => {
        const name = taskBranchName({ id, slug: 'T-42' });
        expect(name).toBe('task/t-42-9f3c1a2b111142228333444455556666');
        expect(taskBranchName({ id, slug: 'T-42' })).toBe(name);
    });

    it('sanitizes hostile slugs into git-safe names', () => {
        expect(taskBranchName({ id, slug: '../..//evil branch!!' })).toBe(
            'task/evil-branch-9f3c1a2b111142228333444455556666',
        );
        expect(taskBranchName({ id, slug: '   ' })).toBe(
            'task/task-9f3c1a2b111142228333444455556666',
        );
        expect(taskBranchName({ id, slug: null })).toBe(
            'task/task-9f3c1a2b111142228333444455556666',
        );
    });

    it('distinguishes ids sharing an 8-char prefix (full-id identity)', () => {
        const a = taskBranchName({ id: '9f3c1a2b-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'T-42' });
        const b = taskBranchName({ id: '9f3c1a2b-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'T-42' });
        expect(a).not.toBe(b);
    });

    it('caps slug length so branch names stay manageable', () => {
        const name = taskBranchName({ id, slug: 'x'.repeat(200) });
        expect(name.length).toBeLessThanOrEqual('task/'.length + 40 + 1 + 32);
    });
});
