import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        return `${key} ${Object.values(vars).join(' ')}`;
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const createTaskAction = vi.fn();
vi.mock('@/app/actions/tasks', () => ({
    createTaskAction: (...args: unknown[]) => createTaskAction(...args),
}));

const listAgentOptionsAction = vi.fn();
vi.mock('@/app/actions/agents', () => ({
    listAgentOptionsAction: (...args: unknown[]) => listAgentOptionsAction(...args),
}));

import { TaskSubtasksSection } from './TaskSubtasksSection';
import type { Task, TaskSubtaskRow } from '@/lib/api/tasks';

/**
 * Tasks upgrades — the Subtasks checklist.
 *
 * The behaviour worth pinning: a new sub-task INHERITS the parent's
 * owner tuple (the API rejects a child whose scope disagrees with its
 * parent, so sending anything else is a guaranteed 400), and the agent
 * chip resolves to a name only when there is an agent to name.
 */
function makeParent(overrides: Partial<Task> = {}): Task {
    return {
        id: 'parent-1',
        slug: 'T-1',
        title: 'Parent',
        status: 'todo',
        priority: 'p2',
        workId: 'work-1',
        missionId: null,
        ideaId: null,
        teamId: null,
        agentId: null,
        goalId: null,
        ...overrides,
    } as Task;
}

function makeRow(overrides: Partial<TaskSubtaskRow> = {}): TaskSubtaskRow {
    return {
        id: 'child-1',
        slug: 'T-2',
        title: 'Write spec',
        status: 'todo',
        priority: 'p2',
        agentAssigneeIds: [],
        userAssigneeIds: [],
        approverCount: 0,
        approvedCount: 0,
        requiresApproval: false,
        approvalCleared: true,
        ...overrides,
    } as TaskSubtaskRow;
}

describe('TaskSubtasksSection', () => {
    beforeEach(() => {
        createTaskAction.mockReset();
        listAgentOptionsAction.mockReset();
        createTaskAction.mockResolvedValue(makeRow());
        listAgentOptionsAction.mockResolvedValue([]);
    });

    it('renders the n/m checklist counter from the server meta', () => {
        render(
            <TaskSubtasksSection
                task={makeParent()}
                initial={[makeRow({ status: 'done' }), makeRow({ id: 'child-2' })]}
                initialMeta={{ total: 2, doneCount: 1 }}
            />,
        );
        expect(screen.getByTestId('task-subtasks-progress').textContent).toBe('1/2');
    });

    it('creates a sub-task under the parent with the parent`s scope', async () => {
        render(<TaskSubtasksSection task={makeParent()} initial={[]} />);
        fireEvent.change(screen.getByTestId('task-subtask-input'), {
            target: { value: '  Plan implementation  ' },
        });
        fireEvent.submit(screen.getByTestId('task-subtask-input').closest('form')!);

        await waitFor(() => expect(createTaskAction).toHaveBeenCalledTimes(1));
        expect(createTaskAction).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Plan implementation',
                parentTaskId: 'parent-1',
                workId: 'work-1',
                missionId: null,
                ideaId: null,
            }),
        );
    });

    // Regression: `assertParentScopeMatches` compares the WHOLE owner
    // tuple (work/mission/idea/team/agent/goal), so omitting the three
    // newer owners made "Add" fail with a scope-mismatch 400 on any Task
    // that had an Agent picked — the picker sits on this same page.
    it('forwards the parent`s agent/team/goal owners, not just the scope trio', async () => {
        render(
            <TaskSubtasksSection
                task={makeParent({ agentId: 'agent-9', teamId: 'team-3', goalId: 'goal-7' })}
                initial={[]}
            />,
        );
        fireEvent.change(screen.getByTestId('task-subtask-input'), {
            target: { value: 'Child under an agent-owned parent' },
        });
        fireEvent.submit(screen.getByTestId('task-subtask-input').closest('form')!);

        await waitFor(() => expect(createTaskAction).toHaveBeenCalledTimes(1));
        expect(createTaskAction).toHaveBeenCalledWith(
            expect.objectContaining({
                parentTaskId: 'parent-1',
                workId: 'work-1',
                agentId: 'agent-9',
                teamId: 'team-3',
                goalId: 'goal-7',
            }),
        );
    });

    it('sends explicit nulls for owners the parent does not carry', async () => {
        render(<TaskSubtasksSection task={makeParent()} initial={[]} />);
        fireEvent.change(screen.getByTestId('task-subtask-input'), {
            target: { value: 'Child' },
        });
        fireEvent.submit(screen.getByTestId('task-subtask-input').closest('form')!);

        await waitFor(() => expect(createTaskAction).toHaveBeenCalledTimes(1));
        expect(createTaskAction).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: null, teamId: null, goalId: null }),
        );
    });

    it('does not fetch the agent roster when no row carries an agent', () => {
        render(<TaskSubtasksSection task={makeParent()} initial={[makeRow()]} />);
        expect(listAgentOptionsAction).not.toHaveBeenCalled();
    });

    it('resolves an agent chip to the Agent name', async () => {
        listAgentOptionsAction.mockResolvedValue([
            { id: 'agent-a', name: 'Planner', slug: 'planner', status: 'active' },
        ]);
        render(
            <TaskSubtasksSection
                task={makeParent()}
                initial={[makeRow({ agentAssigneeIds: ['agent-a'] })]}
                initialMeta={{ total: 1, doneCount: 0 }}
            />,
        );
        expect(await screen.findByText('Planner')).toBeTruthy();
    });

    it('shows a pending approval badge only while the gate is open', () => {
        const { rerender } = render(
            <TaskSubtasksSection
                task={makeParent()}
                initial={[
                    makeRow({ requiresApproval: true, approvalCleared: false, approverCount: 2 }),
                ]}
            />,
        );
        expect(screen.getByTestId('task-subtask-approval-badge').textContent).toContain(
            'approvalPending',
        );

        rerender(
            <TaskSubtasksSection
                task={makeParent()}
                initial={[
                    makeRow({
                        requiresApproval: true,
                        approvalCleared: true,
                        approverCount: 2,
                        approvedCount: 2,
                    }),
                ]}
            />,
        );
        expect(screen.getByTestId('task-subtask-approval-badge').textContent).toContain(
            'approvalCleared',
        );
    });

    it('renders no badge at all for an ungated row', () => {
        render(<TaskSubtasksSection task={makeParent()} initial={[makeRow()]} />);
        expect(screen.queryByTestId('task-subtask-approval-badge')).toBeNull();
    });
});
