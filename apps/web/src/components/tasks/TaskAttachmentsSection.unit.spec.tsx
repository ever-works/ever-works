import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const attachUploadAction = vi.fn();
const detachAttachmentAction = vi.fn();
vi.mock('@/app/actions/tasks', () => ({
    attachUploadAction: (...args: unknown[]) => attachUploadAction(...args),
    detachAttachmentAction: (...args: unknown[]) => detachAttachmentAction(...args),
}));

// The shared tile grid is exercised by its own specs; here it is reduced
// to the two seams this wrapper owns — the attach callback and the per-row
// `badge` the wrapper derives from the attachment's role.
vi.mock('@/components/common/EntityAttachmentsSection', () => ({
    EntityAttachmentsSection: ({
        initial,
        onAttach,
    }: {
        initial: Array<{ id: string; badge?: string | null }>;
        onAttach: (uploadId: string) => Promise<unknown>;
    }) =>
        React.createElement(
            'div',
            null,
            React.createElement(
                'button',
                { 'data-testid': 'fake-attach', onClick: () => void onAttach('upload-1') },
                'attach',
            ),
            ...initial.map((row) =>
                React.createElement(
                    'span',
                    { key: row.id, 'data-testid': `tile-${row.id}` },
                    row.badge ?? '(no badge)',
                ),
            ),
        ),
}));

import { TaskAttachmentsSection } from './TaskAttachmentsSection';
import type { TaskAttachmentRow } from '@/lib/api/tasks';

/**
 * Tasks upgrades — attachment roles.
 *
 * The behaviour worth pinning: the `result` role has a PRODUCER. The
 * tile chip reads `row.role === 'result'`, so if nothing in the product
 * can send that role the chip is unreachable and the column is dead.
 */
function makeRow(overrides: Partial<TaskAttachmentRow> = {}): TaskAttachmentRow {
    return {
        id: 'att-1',
        taskId: 'task-1',
        uploadId: 'upload-1',
        createdAt: '2026-08-14T09:00:00.000Z',
        ...overrides,
    } as TaskAttachmentRow;
}

describe('TaskAttachmentsSection', () => {
    beforeEach(() => {
        attachUploadAction.mockReset();
        attachUploadAction.mockResolvedValue(makeRow());
    });

    it('attaches as `initial` by default', async () => {
        render(<TaskAttachmentsSection taskId="task-1" workId="work-1" initial={[]} />);
        fireEvent.click(screen.getByTestId('fake-attach'));

        await waitFor(() => expect(attachUploadAction).toHaveBeenCalledTimes(1));
        expect(attachUploadAction).toHaveBeenCalledWith('task-1', 'upload-1', 'initial');
    });

    it('attaches as `result` once the role is switched', async () => {
        render(<TaskAttachmentsSection taskId="task-1" workId="work-1" initial={[]} />);
        fireEvent.click(screen.getByTestId('task-attachment-role-result'));
        fireEvent.click(screen.getByTestId('fake-attach'));

        await waitFor(() => expect(attachUploadAction).toHaveBeenCalledTimes(1));
        expect(attachUploadAction).toHaveBeenCalledWith('task-1', 'upload-1', 'result');
    });

    it('chips a `result` row and leaves an `initial` row unmarked', () => {
        render(
            <TaskAttachmentsSection
                taskId="task-1"
                workId="work-1"
                initial={[
                    makeRow({ id: 'att-in', role: 'initial' }),
                    makeRow({ id: 'att-out', role: 'result' }),
                ]}
            />,
        );
        expect(screen.getByTestId('tile-att-in').textContent).toBe('(no badge)');
        expect(screen.getByTestId('tile-att-out').textContent).toBe('attachmentRoleResult');
    });

    it('hides the role picker on a Task that cannot own attachments', () => {
        render(<TaskAttachmentsSection taskId="task-1" workId={null} initial={[]} />);
        expect(screen.queryByTestId('task-attachment-role-result')).toBeNull();
    });
});
