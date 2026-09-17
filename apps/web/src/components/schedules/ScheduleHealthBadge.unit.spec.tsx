import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key}(${JSON.stringify(values)})` : `${ns}.${key}`,
}));

import { ScheduleHealthBadge } from './ScheduleHealthBadge';

const T = 'dashboard.schedules.health';

describe('ScheduleHealthBadge', () => {
    it('renders OK as a word, not just a colour', () => {
        render(
            <ScheduleHealthBadge
                health={{
                    ok: true,
                    reason: null,
                    reasonKey: null,
                    repair: 'none',
                    checkedAt: null,
                }}
            />,
        );
        const badge = screen.getByTestId('schedule-health-badge');
        expect(badge.textContent).toBe(`${T}.ok`);
        expect(badge.getAttribute('data-health')).toBe('ok');
        expect(badge.getAttribute('aria-label')).toContain(`${T}.badgeLabel`);
    });

    it('renders NEVER RUNS with the reason in its accessible name and tooltip', () => {
        render(
            <ScheduleHealthBadge
                health={{
                    ok: false,
                    reason: 'impossible-date',
                    reasonKey: 'impossibleDate',
                    repair: 'automatic',
                    checkedAt: '2026-09-14T10:00:00.000Z',
                }}
            />,
        );
        const badge = screen.getByTestId('schedule-health-badge');
        expect(badge.textContent).toBe(`${T}.neverRuns`);
        expect(badge.getAttribute('data-health')).toBe('never-runs');
        expect(badge.getAttribute('data-reason')).toBe('impossible-date');
        expect(badge.getAttribute('aria-label')).toContain(`${T}.reasons.impossibleDate`);
        expect(badge.getAttribute('title')).toBe(`${T}.reasons.impossibleDate`);
    });

    it('renders nothing when health is not known yet — never a false OK', () => {
        const { container } = render(<ScheduleHealthBadge health={undefined} />);
        expect(container.innerHTML).toBe('');
    });
});
