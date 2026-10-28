import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Task } from '@/lib/api/tasks';
import { TaskBranchChip } from './TaskBranchChip';

/**
 * C-12 (stored XSS): the kanban card's branch chip links its pull request from
 * `prUrl`, which an agent run / provider response writes. Only a plain `https:` URL
 * (`safePrUrl`) becomes a link; anything else keeps the number as inert text.
 */
const make = (prUrl: string | null) =>
    ({
        id: 't1',
        branchRef: 'task/t-1-add-field-x',
        branchState: 'pr-open',
        prNumber: 10,
        prUrl,
    }) as unknown as Task;

describe('TaskBranchChip - C-12: a hostile prUrl never becomes a clickable link', () => {
    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'https://user:pw@evil.invalid/pull/1',
    ])('keeps #10 as text for %j', (prUrl) => {
        const { container } = render(<TaskBranchChip task={make(prUrl)} />);

        expect(screen.queryByTestId('task-branch-chip-pr-link')).toBeNull();
        expect(container.querySelector('a')).toBeNull();
        expect(screen.getByTestId('task-branch-chip').textContent).toContain('#10');
    });

    it('control: links a plain https pull request URL', () => {
        render(<TaskBranchChip task={make('https://github.com/acme/repo/pull/10')} />);

        expect(screen.getByTestId('task-branch-chip-pr-link').getAttribute('href')).toBe(
            'https://github.com/acme/repo/pull/10',
        );
    });
});
