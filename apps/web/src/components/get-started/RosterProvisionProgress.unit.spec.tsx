import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const getRosterState = vi.fn();
vi.mock('@/app/actions/onboarding/roster', () => ({
    getRosterState: (...args: unknown[]) => getRosterState(...args),
    acknowledgeRoster: vi.fn(),
}));

// The introduction owns a Headless UI dialog; it has its own coverage and
// renders nothing while closed, so stub it to keep this spec about polling
// and per-lane outcomes.
vi.mock('./RosterIntroduction', () => ({
    RosterIntroduction: ({ open }: { open: boolean }) =>
        open ? <div data-testid="stub-introduction" /> : null,
}));

import {
    ROSTER_POLL_INTERVAL_MS,
    ROSTER_STALL_AFTER_MS,
    RosterProvisionProgress,
} from './RosterProvisionProgress';
import type { RosterStateResponse } from '@/lib/api/onboarding';
import type { LaneOutcome, RosterProvisionState } from '@ever-works/contracts/api';

function lane(
    laneKey: string,
    outcome: LaneOutcome,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        laneKey,
        templateSlug: 'template',
        requestedName: laneKey,
        outcome,
        ...extra,
    };
}

function state(
    runState: RosterProvisionState,
    lanes: Record<string, unknown>[],
): RosterStateResponse {
    return {
        state: runState,
        provisioning: {
            runId: 'run-1',
            blueprintSlug: 'general',
            state: runState,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            lanes: lanes as never,
        },
        acknowledgedAt: null,
        agents: [],
        canCreateAgents: true,
    };
}

describe('RosterProvisionProgress', () => {
    beforeEach(() => {
        getRosterState.mockReset();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('names the outcome of every lane, including while the run is still going', () => {
        render(
            <RosterProvisionProgress
                runId="run-1"
                initialState={state('creating', [
                    lane('coordination', 'created'),
                    lane('research', 'reused'),
                    lane('content', 'skippedNoSeat'),
                    lane('social', 'failed', { failureReason: 'nameUnavailable' }),
                    lane('outreach', 'pending'),
                ])}
            />,
        );

        expect(screen.getByTestId('roster-provision-lane-coordination')).toHaveTextContent(
            'onboarding.provisioning.outcomes.created',
        );
        expect(screen.getByTestId('roster-provision-lane-research')).toHaveTextContent(
            'onboarding.provisioning.outcomes.reused',
        );
        expect(screen.getByTestId('roster-provision-lane-content')).toHaveTextContent(
            'onboarding.provisioning.outcomes.skippedNoSeat',
        );
        expect(screen.getByTestId('roster-provision-lane-social')).toHaveTextContent(
            'onboarding.provisioning.failures.nameUnavailable',
        );
        // In flight, an unreached lane is being worked on — NOT "not
        // attempted", which is what it means once the run has ended.
        expect(screen.getByTestId('roster-provision-lane-outreach')).toHaveTextContent(
            'onboarding.provisioning.outcomes.working',
        );
    });

    it('says a lane was renamed rather than silently showing a different name', () => {
        render(
            <RosterProvisionProgress
                runId="run-1"
                initialState={state('ready', [
                    lane('research', 'created', { finalName: 'Research 2' }),
                ])}
            />,
        );

        expect(screen.getByTestId('roster-provision-lane-research')).toHaveTextContent(
            'onboarding.provisioning.renamed',
        );
    });

    it('counts only the lanes that landed', () => {
        render(
            <RosterProvisionProgress
                runId="run-1"
                initialState={state('partial', [
                    lane('coordination', 'created'),
                    lane('research', 'reused'),
                    lane('content', 'skippedNoSeat'),
                ])}
            />,
        );

        expect(screen.getByTestId('roster-provision-counter')).toHaveTextContent('"done":2');
        expect(screen.getByTestId('roster-provision-counter')).toHaveTextContent('"total":3');
    });

    it('offers to finish the missing lanes after a partial run', () => {
        const onRetry = vi.fn();
        render(
            <RosterProvisionProgress
                runId="run-1"
                onRetry={onRetry}
                initialState={state('partial', [
                    lane('coordination', 'created'),
                    lane('content', 'skippedNoSeat'),
                ])}
            />,
        );

        expect(screen.getByTestId('roster-provision-partial')).toBeInTheDocument();
        expect(screen.getByTestId('roster-provision-open-intro')).toBeInTheDocument();
    });

    it('offers a retry and no introduction when nothing was created', () => {
        render(
            <RosterProvisionProgress
                runId="run-1"
                initialState={state('failed', [
                    lane('coordination', 'failed', { failureReason: 'unknown' }),
                ])}
            />,
        );

        expect(screen.getByTestId('roster-provision-failed')).toBeInTheDocument();
        expect(screen.queryByTestId('roster-provision-open-intro')).toBeNull();
    });

    it('polls while a run is in flight and stops the moment it reaches a terminal state', async () => {
        getRosterState
            .mockResolvedValueOnce({
                success: true,
                data: state('creating', [lane('coordination', 'created')]),
            })
            .mockResolvedValueOnce({
                success: true,
                data: state('ready', [lane('coordination', 'created')]),
            });

        render(<RosterProvisionProgress runId="run-1" />);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ROSTER_POLL_INTERVAL_MS);
        });
        expect(getRosterState).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ROSTER_POLL_INTERVAL_MS);
        });
        expect(getRosterState).toHaveBeenCalledTimes(2);

        // Terminal now — a panel that keeps asking after the answer
        // arrived is indistinguishable from one that is still working.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ROSTER_POLL_INTERVAL_MS * 5);
        });
        expect(getRosterState).toHaveBeenCalledTimes(2);
    });

    it('stops polling and says so once the run has outlived its budget', async () => {
        getRosterState.mockResolvedValue({
            success: true,
            data: state('creating', [lane('coordination', 'pending')]),
        });

        render(<RosterProvisionProgress runId="run-1" />);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ROSTER_STALL_AFTER_MS + ROSTER_POLL_INTERVAL_MS);
        });

        expect(screen.getByTestId('roster-provision-stalled')).toBeInTheDocument();
        const callsAtStall = getRosterState.mock.calls.length;

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ROSTER_POLL_INTERVAL_MS * 10);
        });
        expect(getRosterState).toHaveBeenCalledTimes(callsAtStall);
    });

    it('tells the caller once when a run has finished', () => {
        const onFinished = vi.fn();
        render(
            <RosterProvisionProgress
                runId="run-1"
                onFinished={onFinished}
                initialState={state('ready', [lane('coordination', 'created')])}
            />,
        );

        expect(onFinished).toHaveBeenCalledTimes(1);
    });
});
