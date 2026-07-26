import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        // The real messages interpolate `{count}` / `{terms}`; the mock
        // appends the values so specs can assert on them directly.
        return `${key} ${Object.values(vars).join(' ')}`;
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
}));

const conflictsMock = vi.fn();
vi.mock('@/app/actions/tasks', () => ({
    getTaskDecisionConflictsAction: (...args: unknown[]) => conflictsMock(...args),
}));

import { TaskDecisionConflicts } from './TaskDecisionConflicts';
import type { DecisionConflictDto } from '@ever-works/contracts';

function conflict(overrides: Partial<DecisionConflictDto> = {}): DecisionConflictDto {
    return {
        documentId: 'dec-1',
        path: 'decision/database-engine.md',
        slug: 'database-engine',
        title: 'Use PostgreSQL as the primary database engine',
        workId: 'work-1',
        rationale: 'JSONB + pgvector',
        decidedAt: '2026-07-01T10:00:00.000Z',
        score: 0.83,
        overlapTerms: ['database', 'engine', 'postgresql'],
        signal: 'strong',
        ...overrides,
    };
}

describe('TaskDecisionConflicts', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.clearAllMocks());

    it('renders nothing when there are no conflicts (silent by default)', () => {
        const { container } = render(
            <TaskDecisionConflicts taskId="task-1" initialConflicts={[]} />,
        );
        expect(container.firstChild).toBeNull();
        expect(conflictsMock).not.toHaveBeenCalled();
    });

    it('lists conflicting decisions with a link into the KB document', () => {
        render(<TaskDecisionConflicts taskId="task-1" initialConflicts={[conflict()]} />);
        expect(screen.getByTestId('task-decision-conflicts')).toBeTruthy();
        expect(screen.getByTestId('task-decision-conflict-dec-1-link').getAttribute('href')).toBe(
            '/works/work-1/kb/decision/database-engine.md',
        );
    });

    it('renders the rationale and the shared terms that produced the flag', () => {
        render(<TaskDecisionConflicts taskId="task-1" initialConflicts={[conflict()]} />);
        const row = screen.getByTestId('task-decision-conflict-dec-1');
        expect(row.textContent).toContain('JSONB + pgvector');
        expect(row.textContent).toContain('database, engine, postgresql');
    });

    it('distinguishes strong from moderate signals', () => {
        render(
            <TaskDecisionConflicts
                taskId="task-1"
                initialConflicts={[
                    conflict(),
                    conflict({ documentId: 'dec-2', signal: 'moderate', workId: null }),
                ]}
            />,
        );
        expect(screen.getByTestId('task-decision-conflict-dec-1').dataset.signal).toBe('strong');
        expect(screen.getByTestId('task-decision-conflict-dec-2').dataset.signal).toBe('moderate');
        // No workId ⇒ no KB link (nothing to point at), but the row still renders.
        expect(screen.queryByTestId('task-decision-conflict-dec-2-link')).toBeNull();
    });

    it('fetches on mount when no pre-computed conflicts are supplied', async () => {
        conflictsMock.mockResolvedValue({
            conflicts: [conflict()],
            scanned: 3,
            heuristic: 'term-overlap/v1',
        });
        render(<TaskDecisionConflicts taskId="task-1" />);
        await waitFor(() => expect(screen.getByTestId('task-decision-conflicts')).toBeTruthy());
        expect(conflictsMock).toHaveBeenCalledWith('task-1');
    });

    it('re-checks when the refresh key changes (description edited)', async () => {
        conflictsMock.mockResolvedValue({
            conflicts: [],
            scanned: 0,
            heuristic: 'term-overlap/v1',
        });
        const { rerender } = render(
            <TaskDecisionConflicts taskId="task-1" initialConflicts={[]} refreshKey={0} />,
        );
        expect(conflictsMock).not.toHaveBeenCalled();

        rerender(<TaskDecisionConflicts taskId="task-1" initialConflicts={[]} refreshKey={1} />);
        await waitFor(() => expect(conflictsMock).toHaveBeenCalledWith('task-1'));
    });

    it('stays silent when the re-check comes back empty', async () => {
        conflictsMock.mockResolvedValue({
            conflicts: [],
            scanned: 5,
            heuristic: 'term-overlap/v1',
        });
        const { container } = render(<TaskDecisionConflicts taskId="task-1" />);
        await waitFor(() => expect(conflictsMock).toHaveBeenCalled());
        expect(container.firstChild).toBeNull();
    });
});
