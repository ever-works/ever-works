import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskDiffSheet } from './TaskDiffSheet';

/**
 * PR insights (kanban run cockpit M6) — the diff preview sheet.
 *
 * The load-bearing behaviour:
 *
 *  1. failures branch on the action's stable `code`, NEVER on a message
 *     (production redacts thrown Server-Action messages, so a
 *     message-driven UI silently shows nothing once deployed);
 *  2. a truncated response SAYS SO and links out — the sheet must never
 *     imply it is showing the whole change;
 *  3. patch text renders as text, inside `<pre>`, with +/- tinting and
 *     no markup interpretation (repo content is third-party text).
 */

const getTaskDiffAction = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
    getTaskDiffAction: (...args: unknown[]) => getTaskDiffAction(...args),
}));

const diffOk = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    data: {
        taskId: 't1',
        source: 'pull-request' as const,
        prNumber: 241,
        prUrl: 'https://provider.invalid/acme/widgets/pull/241',
        branchRef: 'task/t-1-abc',
        baseRef: 'main',
        diff: {
            files: [
                {
                    path: 'src/a.ts',
                    status: 'modified',
                    additions: 4,
                    deletions: 1,
                    patch: '@@ -1 +1 @@\n-old line\n+new line\n',
                },
            ],
            truncated: false,
            totalFiles: 1,
            totalAdditions: 4,
            totalDeletions: 1,
            patchBytes: 32,
            ...(overrides.diff ?? {}),
        },
        ...overrides,
    },
});

describe('TaskDiffSheet', () => {
    beforeEach(() => {
        getTaskDiffAction.mockReset();
        getTaskDiffAction.mockResolvedValue(diffOk());
    });

    it('renders nothing while closed and does not fetch', () => {
        const { container } = render(
            <TaskDiffSheet taskId="t1" open={false} onClose={() => undefined} />,
        );
        expect(container.firstChild).toBeNull();
        expect(getTaskDiffAction).not.toHaveBeenCalled();
    });

    it('loads the diff for the task when opened', async () => {
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        await waitFor(() => expect(getTaskDiffAction).toHaveBeenCalledWith('t1'));
        expect(await screen.findByTestId('task-diff-sheet')).toBeTruthy();
    });

    it('summarises the change with pre-cap totals', async () => {
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        const summary = await screen.findByTestId('task-diff-summary');
        expect(summary.textContent).toContain('1 file');
        expect(summary.textContent).toContain('+4');
        expect(summary.textContent).toContain('1');
    });

    it('lists each file with its add/del counts', async () => {
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        const rows = await screen.findAllByTestId('task-diff-file');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('src/a.ts');
    });

    it('reveals the patch as tinted text only when the file is expanded', async () => {
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        await screen.findAllByTestId('task-diff-file');
        expect(screen.queryByTestId('task-diff-patch')).toBeNull();

        fireEvent.click(screen.getAllByTestId('task-diff-file-toggle')[0]);
        const patch = await screen.findByTestId('task-diff-patch');
        expect(patch.tagName).toBe('PRE');
        expect(patch.textContent).toContain('+new line');
        expect(patch.textContent).toContain('-old line');
    });

    it('announces a capped response and links to the full diff', async () => {
        getTaskDiffAction.mockResolvedValue(
            diffOk({ diff: { files: [], truncated: true, totalFiles: 400 } }),
        );
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        expect(await screen.findByTestId('task-diff-truncated')).toBeTruthy();
        const link = screen.getByTestId('task-diff-full-link');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('does not link out when the PR URL is unsafe', async () => {
        getTaskDiffAction.mockResolvedValue(
            diffOk({
                prUrl: 'javascript:alert(1)',
                diff: { files: [], truncated: true, totalFiles: 400 },
            }),
        );
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        await screen.findByTestId('task-diff-truncated');
        expect(screen.queryByTestId('task-diff-full-link')).toBeNull();
    });

    it('explains a NOT_FOUND result instead of showing an empty sheet', async () => {
        getTaskDiffAction.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        const error = await screen.findByTestId('task-diff-error');
        expect(error.textContent).toContain('no branch or pull request');
    });

    it('explains a provider without the diff capability', async () => {
        getTaskDiffAction.mockResolvedValue({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        const error = await screen.findByTestId('task-diff-error');
        expect(error.textContent).toContain('cannot supply a diff');
    });

    it('falls back to a generic message for an unrecognised code', async () => {
        getTaskDiffAction.mockResolvedValue({ ok: false, code: 'SOMETHING_NEW' });
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        const error = await screen.findByTestId('task-diff-error');
        expect(error.textContent).toContain('could not be loaded');
    });

    it('says so when the branch has no file changes', async () => {
        getTaskDiffAction.mockResolvedValue(
            diffOk({ diff: { files: [], truncated: false, totalFiles: 0 } }),
        );
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        expect(await screen.findByTestId('task-diff-empty')).toBeTruthy();
    });

    it('flags a file whose patch the server dropped for the byte budget', async () => {
        getTaskDiffAction.mockResolvedValue(
            diffOk({
                diff: {
                    files: [
                        {
                            path: 'big.ts',
                            status: 'modified',
                            additions: 900,
                            deletions: 0,
                            patchOmitted: true,
                        },
                    ],
                    truncated: true,
                    totalFiles: 1,
                },
            }),
        );
        render(<TaskDiffSheet taskId="t1" open onClose={() => undefined} />);
        expect(await screen.findByTestId('task-diff-patch-omitted')).toBeTruthy();
    });

    it('closes on the close button and on Escape', async () => {
        const onClose = vi.fn();
        render(<TaskDiffSheet taskId="t1" open onClose={onClose} />);
        await screen.findByTestId('task-diff-sheet');

        fireEvent.click(screen.getByTestId('task-diff-close'));
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
