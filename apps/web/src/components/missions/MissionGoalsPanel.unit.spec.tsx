import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const linkMock = vi.fn();
vi.mock('@/app/actions/dashboard/mission-goals', () => ({
    linkGoalToMissionAction: (...args: unknown[]) => linkMock(...args),
}));

// Stub the `Select` primitive with a native <select> — the real one is
// a portal-rendered custom listbox, and this spec is about the panel's
// wiring, not the picker's internals (same convention as
// GithubRepoWidgets.unit.spec.tsx).
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        children,
        onValueChange,
        ...rest
    }: {
        value: string;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
    } & Record<string, unknown>) => (
        <select
            data-testid={rest['data-testid'] as string}
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            <option value="" />
            {children}
        </select>
    ),
}));

import { MissionGoalsPanel } from './MissionGoalsPanel';
import type { MissionGoalLinkDto } from '@/lib/api/missions';
import type { Goal } from '@/lib/api/goals';

function mkGoal(overrides: Partial<Goal> = {}): Goal {
    return {
        id: 'g1',
        title: 'Reach 1k signups',
        description: null,
        metricSource: { pluginId: 'p', metricId: 'm' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'signups',
        window: 'total',
        baselineValue: null,
        currentValue: 250,
        currentValueAt: null,
        deadline: null,
        checkFrequencyMinutes: 60,
        nextCheckAt: null,
        status: 'active',
        outcome: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function mkLink(overrides: Partial<MissionGoalLinkDto> = {}): MissionGoalLinkDto {
    return {
        id: 'l1',
        missionId: 'm1',
        goalId: 'g1',
        isPrimary: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        goal: mkGoal(),
        ...overrides,
    };
}

describe('MissionGoalsPanel', () => {
    beforeEach(() => {
        linkMock.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
    });

    it('renders the empty state when no Goals are attached', () => {
        render(<MissionGoalsPanel missionId="m1" initialLinks={[]} attachableGoals={[]} />);
        expect(screen.getByText('empty')).toBeInTheDocument();
        // No Goals to attach either — the select is replaced by a hint.
        expect(screen.getByText('noGoalsToAttach')).toBeInTheDocument();
        expect(screen.queryByTestId('mission-attach-goal-select')).toBeNull();
    });

    it('tags each picker option with a status-keyed Goal icon', () => {
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[]}
                attachableGoals={[
                    { id: 'g1', title: 'Reach 1k signups', status: 'active' },
                    { id: 'g2', title: 'Cut churn', status: 'completed' },
                    // No status → the neutral icon, never a missing key.
                    { id: 'g3', title: 'Ship v2' },
                ]}
            />,
        );
        const select = screen.getByTestId('mission-attach-goal-select');
        const icons = Array.from(select.querySelectorAll('option[value]'))
            .filter((o) => o.getAttribute('value'))
            .map((o) => o.getAttribute('data-icon'));
        expect(icons).toEqual(['active', 'completed', 'unknown']);
    });

    it('renders attached Goals with progress and a primary badge', () => {
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink({ isPrimary: true })]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );
        expect(screen.getByTestId('mission-goals-row-g1')).toBeInTheDocument();
        expect(screen.getByTestId('mission-goals-primary-g1')).toBeInTheDocument();
        expect(screen.getByText('Reach 1k signups').closest('a')).toHaveAttribute(
            'href',
            '/goals/g1',
        );
        // currentValue / comparator + targetValue, both unit-suffixed.
        expect(screen.getByText(/250 signups/)).toBeInTheDocument();
        expect(screen.getByText(/≥ 1,000 signups/)).toBeInTheDocument();
    });

    it('does not render a primary badge for a non-primary link', () => {
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink()]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );
        expect(screen.queryByTestId('mission-goals-primary-g1')).toBeNull();
    });

    it('attaches the selected Goal and replaces the list with the action result', async () => {
        linkMock.mockResolvedValue([mkLink({ id: 'l2', goalId: 'g2', isPrimary: true })]);
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[]}
                attachableGoals={[
                    { id: 'g1', title: 'Reach 1k signups' },
                    { id: 'g2', title: 'Cut churn' },
                ]}
            />,
        );

        fireEvent.change(screen.getByTestId('mission-attach-goal-select'), {
            target: { value: 'g2' },
        });
        fireEvent.click(screen.getByTestId('mission-attach-goal-primary'));
        fireEvent.click(screen.getByTestId('mission-attach-goal-submit'));

        await waitFor(() => expect(linkMock).toHaveBeenCalledTimes(1));
        expect(linkMock).toHaveBeenCalledWith('m1', { goalId: 'g2', isPrimary: true });
        await waitFor(() => expect(screen.getByTestId('mission-goals-row-g2')).toBeInTheDocument());
        expect(screen.getByTestId('mission-goals-primary-g2')).toBeInTheDocument();
        expect(toastSuccess).toHaveBeenCalledWith('toasts.attached');
    });

    it('defaults isPrimary to false when the checkbox is untouched', async () => {
        linkMock.mockResolvedValue([mkLink()]);
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );

        fireEvent.change(screen.getByTestId('mission-attach-goal-select'), {
            target: { value: 'g1' },
        });
        fireEvent.click(screen.getByTestId('mission-attach-goal-submit'));

        await waitFor(() =>
            expect(linkMock).toHaveBeenCalledWith('m1', { goalId: 'g1', isPrimary: false }),
        );
    });

    it('keeps the existing list and toasts on failure', async () => {
        linkMock.mockRejectedValue(new Error('nope'));
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink()]}
                attachableGoals={[{ id: 'g2', title: 'Cut churn' }]}
            />,
        );

        fireEvent.change(screen.getByTestId('mission-attach-goal-select'), {
            target: { value: 'g2' },
        });
        fireEvent.click(screen.getByTestId('mission-attach-goal-submit'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(screen.getByTestId('mission-goals-row-g1')).toBeInTheDocument();
    });

    it('disables the submit button until a Goal is selected', () => {
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );
        expect(screen.getByTestId('mission-attach-goal-submit')).toBeDisabled();
    });
});
