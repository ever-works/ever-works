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
const unlinkMock = vi.fn();
vi.mock('@/app/actions/dashboard/mission-goals', () => ({
    linkGoalToMissionAction: (...args: unknown[]) => linkMock(...args),
    unlinkGoalFromMissionAction: (...args: unknown[]) => unlinkMock(...args),
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
        // Self-build slice AG: `Goal.goalKind` is required on the wire type;
        // every Goal in this spec is the metric kind it always was.
        goalKind: 'metric',
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
        // Autonomy layer — a Goal that never opted into the execution loop,
        // which is what every Mission-linked Goal in this spec is.
        dodCriteria: null,
        dodSummary: {
            total: 0,
            done: 0,
            waived: 0,
            open: 0,
            proposed: 0,
            closed: 0,
            complete: false,
        },
        spendCapCents: null,
        spentCents: 0,
        wallClockLimitHours: null,
        stuckThresholdIterations: null,
        sessionBudgetMinutes: null,
        gracePeriodMinutes: null,
        executionTarget: null,
        plannerModelHint: null,
        workerModelHint: null,
        iteration: 0,
        lastProgressIteration: 0,
        activeAgentId: null,
        assignedAgentId: null,
        loopStatus: null,
        loopStartedAt: null,
        archivedAt: null,
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
        unlinkMock.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
        vi.restoreAllMocks();
    });

    it('renders the empty state when no Goals are attached', () => {
        render(<MissionGoalsPanel missionId="m1" initialLinks={[]} attachableGoals={[]} />);
        expect(screen.getByText('empty')).toBeInTheDocument();
        // No Goals to attach either — the select is replaced by a hint.
        expect(screen.getByText('noGoalsToAttach')).toBeInTheDocument();
        expect(screen.queryByTestId('mission-attach-goal-select')).toBeNull();
    });

    it('shows the current/target readout for a metric Goal', () => {
        render(<MissionGoalsPanel missionId="m1" initialLinks={[mkLink()]} attachableGoals={[]} />);
        const row = screen.getByTestId('mission-goals-row-g1');
        expect(row.textContent).toContain('≥');
        expect(row.textContent).toContain('1,000 signups');
        expect(screen.queryByText('rollup')).toBeNull();
    });

    it('shows the Definition-of-Done rollup instead of a metric readout for a delivery Goal', () => {
        // Self-build slice AG: a delivery Goal has no metric fields at all.
        const delivery = mkGoal({
            goalKind: 'delivery',
            metricSource: null,
            comparator: null,
            targetValue: null,
            unit: null,
            currentValue: null,
            dodSummary: {
                total: 3,
                done: 1,
                waived: 0,
                open: 2,
                proposed: 0,
                closed: 1,
                complete: false,
            },
        });
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink({ goal: delivery })]}
                attachableGoals={[]}
            />,
        );
        const row = screen.getByTestId('mission-goals-row-g1');
        // The mocked `t` echoes the key — the rollup rendered, the glyph did not.
        expect(screen.getByText('rollup')).toBeInTheDocument();
        expect(row.textContent).not.toContain('≥');
        expect(row.textContent).not.toContain('≤');
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

    it('asks in a dialog before detaching, never a window.confirm', async () => {
        const nativeConfirm = vi.spyOn(window, 'confirm');
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink()]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );

        // Closed until the trash button is pressed.
        expect(screen.queryByTestId('mission-goals-detach-confirm')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-goals-detach-g1'));

        await waitFor(() =>
            expect(screen.getByTestId('mission-goals-detach-confirm')).toBeInTheDocument(),
        );
        expect(screen.getByText('detachDialog.title')).toBeInTheDocument();
        expect(nativeConfirm).not.toHaveBeenCalled();
        // Nothing is sent just by opening the dialog.
        expect(unlinkMock).not.toHaveBeenCalled();
    });

    it('detaches a Goal once confirmed and drops only that row', async () => {
        unlinkMock.mockResolvedValue({ deleted: true });
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink(), mkLink({ id: 'l2', goalId: 'g2' })]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-goals-detach-g1'));
        fireEvent.click(await screen.findByTestId('mission-goals-detach-confirm'));

        await waitFor(() => expect(unlinkMock).toHaveBeenCalledWith('m1', 'g1'));
        await waitFor(() => expect(screen.queryByTestId('mission-goals-row-g1')).toBeNull());
        // The sibling edge is untouched — detach removes one row, not the list.
        expect(screen.getByTestId('mission-goals-row-g2')).toBeInTheDocument();
        expect(toastSuccess).toHaveBeenCalledWith('toasts.detached');
        // The dialog closes itself on success.
        await waitFor(() =>
            expect(screen.queryByTestId('mission-goals-detach-confirm')).toBeNull(),
        );
    });

    it('does nothing when the detach dialog is cancelled', async () => {
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink()]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-goals-detach-g1'));
        fireEvent.click(await screen.findByTestId('mission-goals-detach-cancel'));

        expect(unlinkMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('mission-goals-row-g1')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.queryByTestId('mission-goals-detach-confirm')).toBeNull(),
        );
    });

    it('keeps the row and shows the error in the dialog when detaching fails', async () => {
        unlinkMock.mockRejectedValue(new Error('locked'));
        render(
            <MissionGoalsPanel
                missionId="m1"
                initialLinks={[mkLink()]}
                attachableGoals={[{ id: 'g1', title: 'Reach 1k signups' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-goals-detach-g1'));
        fireEvent.click(await screen.findByTestId('mission-goals-detach-confirm'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('locked'));
        // The dialog stays open carrying the reason, so the user can retry.
        expect(screen.getByTestId('mission-goals-detach-error')).toHaveTextContent('locked');
        expect(screen.getByTestId('mission-goals-row-g1')).toBeInTheDocument();
    });
});
