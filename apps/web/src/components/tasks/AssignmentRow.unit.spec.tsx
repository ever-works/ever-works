import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn() }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...(rest as Record<string, string>)}>
            {children}
        </a>
    ),
}));

import { AssignmentRow } from './TaskDetailClient';

/**
 * The rail's assignment rows: the picker re-files the Task, the arrow
 * beside it goes and looks at whatever is currently assigned. These
 * specs cover the arrow — the pickers themselves are covered in
 * MissionIdeaSelect.unit.spec.tsx.
 */
describe('AssignmentRow', () => {
    it('offers no open link when nothing is assigned', () => {
        render(
            <AssignmentRow label="Mission" href={null} openLabel="Open this Mission" error={null}>
                <span>picker</span>
            </AssignmentRow>,
        );

        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByText('picker')).toBeTruthy();
    });

    it('points the open link at the assigned entity and names it for screen readers', () => {
        render(
            <AssignmentRow
                label="Mission"
                href="/missions/m-1"
                openLabel="Open this Mission"
                error={null}
                testId="task-detail-mission-open"
            >
                <span>picker</span>
            </AssignmentRow>,
        );

        const link = screen.getByRole('link', { name: 'Open this Mission' });
        expect(link.getAttribute('href')).toBe('/missions/m-1');
        expect(screen.getByTestId('task-detail-mission-open')).toBeTruthy();
    });

    it('reports an update failure as an alert without hiding the picker or the link', () => {
        render(
            <AssignmentRow
                label="Idea"
                href="/ideas/i-1"
                openLabel="Open this Idea"
                error="Failed to update Idea"
            >
                <span>picker</span>
            </AssignmentRow>,
        );

        expect(screen.getByRole('alert').textContent).toBe('Failed to update Idea');
        expect(screen.getByRole('link', { name: 'Open this Idea' })).toBeTruthy();
        expect(screen.getByText('picker')).toBeTruthy();
    });
});
