import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@/lib/api/tasks';

// Returns the key, plus the ICU values when the caller passed any — so a
// test can assert WHICH message was chosen and what count it was given
// without depending on the English wording.
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// `Button` pulls in the locale-aware Link, which resolves
// `next/navigation` through next-intl — unavailable under jsdom.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/app/actions/tasks', () => ({
    discardTaskBranchAction: vi.fn(),
    resolveTaskConflictsAction: vi.fn(),
    updateTaskAction: vi.fn(),
}));

import { discardTaskBranchAction } from '@/app/actions/tasks';
import { TaskBranchSection } from './TaskBranchSection';

/**
 * Multi-repo Task workspaces (self-build slice C) on the Task page: the
 * branch panel's "Also in" list. One row per linked repository — a link
 * with the PR number (or the generic open-PR label when the provider gave
 * no number), a "pushed, no PR yet" state, and a "failed" state carrying
 * the provider's error as a tooltip — and no list at all for a Task that
 * spans one repository.
 */
const baseTask = {
    id: 't1',
    slug: 't-1',
    title: 'Add field X',
    branchRef: 'task/t-1-add-field-x',
    branchState: 'pr-open',
    baseSha: 'a'.repeat(40),
    prNumber: 10,
    prUrl: 'https://github.com/acme/repo/pull/10',
    conflictPaths: null,
    isolationMode: null,
    linkedPullRequests: null,
} as unknown as Task;

const make = (overrides: Partial<Task> = {}) => ({ ...baseTask, ...overrides }) as Task;

describe('TaskBranchSection — linked pull requests', () => {
    it('lists every linked repository with its pull request, pushed or failed state', () => {
        render(
            <TaskBranchSection
                task={make({
                    linkedPullRequests: [
                        {
                            repositoryId: 'acme/template',
                            branch: 'task/t-1-add-field-x',
                            baseRef: 'main',
                            headSha: 'b'.repeat(40),
                            prNumber: 7,
                            prUrl: 'https://github.com/acme/template/pull/7',
                            state: 'pr-open',
                            error: null,
                            updatedAt: '2026-09-03T00:00:00.000Z',
                        },
                        {
                            repositoryId: 'acme/docs',
                            branch: 'task/t-1-add-field-x',
                            baseRef: 'main',
                            headSha: 'c'.repeat(40),
                            prNumber: null,
                            prUrl: null,
                            state: 'failed',
                            error: '403: resource not accessible',
                            updatedAt: '2026-09-03T00:00:00.000Z',
                        },
                        {
                            repositoryId: 'acme/workspace',
                            branch: 'task/t-1-add-field-x',
                            baseRef: 'main',
                            headSha: 'd'.repeat(40),
                            prNumber: null,
                            prUrl: null,
                            state: 'pushed',
                            error: null,
                            updatedAt: '2026-09-03T00:00:00.000Z',
                        },
                        {
                            repositoryId: 'acme/no-number',
                            branch: 'task/t-1-add-field-x',
                            baseRef: 'main',
                            headSha: null,
                            prNumber: null,
                            prUrl: 'https://github.com/acme/no-number/pull/new',
                            state: 'pr-open',
                            error: null,
                            updatedAt: '2026-09-03T00:00:00.000Z',
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByTestId('task-linked-prs')).toBeInTheDocument();

        const opened = screen.getByTestId('task-linked-pr-acme/template');
        const link = opened.querySelector('a');
        expect(link).toHaveAttribute('href', 'https://github.com/acme/template/pull/7');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link?.textContent).toContain('#7');

        const failed = screen.getByTestId('task-linked-pr-acme/docs');
        expect(failed.querySelector('a')).toBeNull();
        expect(failed).toHaveTextContent('linkedPrFailed');
        const failedState = failed.querySelector('[title]');
        expect(failedState).toHaveAttribute('title', '403: resource not accessible');
        expect(failedState?.className).toContain('text-danger');

        const pushed = screen.getByTestId('task-linked-pr-acme/workspace');
        expect(pushed).toHaveTextContent('linkedPrPushed');
        expect(pushed.querySelector('[title]')).toBeNull();

        // A provider that gave a URL but no number: the generic label, still a link.
        const unnumbered = screen.getByTestId('task-linked-pr-acme/no-number');
        expect(unnumbered.querySelector('a')?.textContent).toContain('openPr');
    });

    it('renders no linked list for a single-repository Task', () => {
        const { rerender } = render(
            <TaskBranchSection task={make({ linkedPullRequests: null })} />,
        );
        expect(screen.getByTestId('task-branch-section')).toBeInTheDocument();
        expect(screen.queryByTestId('task-linked-prs')).toBeNull();

        rerender(<TaskBranchSection task={make({ linkedPullRequests: [] })} />);
        expect(screen.queryByTestId('task-linked-prs')).toBeNull();
        // The primary pull request is untouched by the list.
        expect(screen.getByTestId('task-branch-pr-link')).toHaveAttribute(
            'href',
            'https://github.com/acme/repo/pull/10',
        );
    });
});

/**
 * Discard is an irreversible, credentialed, cross-repository action. Since the
 * discard learned to reach every repository the Task pushed, one click deletes
 * N+1 branches and closes every pull request open on them — so the sentence the
 * operator actually gives consent against has to describe that, not the
 * single-branch action it used to be.
 */
describe('TaskBranchSection - the discard confirmation matches what discard does', () => {
    const linked = (repositoryId: string) => ({
        repositoryId,
        branch: 'task/t-1-add-field-x',
        baseRef: 'main',
        headSha: 'b'.repeat(40),
        prNumber: 7,
        prUrl: `https://github.com/${repositoryId}/pull/7`,
        state: 'pr-open' as const,
        error: null,
        updatedAt: '2026-09-03T00:00:00.000Z',
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(discardTaskBranchAction).mockClear();
    });

    it('names every repository it will delete a branch in, counting the primary', () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(
            <TaskBranchSection
                task={make({
                    linkedPullRequests: [linked('acme/template'), linked('acme/docs')],
                })}
            />,
        );

        fireEvent.click(screen.getByTestId('task-discard-branch'));

        // Two mounts plus the Task's own branch: three branches, three
        // pull requests. The single-branch wording would understate it.
        expect(confirmSpy).toHaveBeenCalledWith('discardConfirmMultiRepo {"count":3}');
        expect(discardTaskBranchAction).toHaveBeenCalledWith('t1');
    });

    it('keeps the single-branch wording for a Task that spans one repository', () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<TaskBranchSection task={make({ linkedPullRequests: null })} />);

        fireEvent.click(screen.getByTestId('task-discard-branch'));

        expect(confirmSpy).toHaveBeenCalledWith('discardConfirm');
    });

    it('discards nothing when the operator declines', () => {
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(
            <TaskBranchSection task={make({ linkedPullRequests: [linked('acme/template')] })} />,
        );

        fireEvent.click(screen.getByTestId('task-discard-branch'));

        expect(discardTaskBranchAction).not.toHaveBeenCalled();
    });
});
