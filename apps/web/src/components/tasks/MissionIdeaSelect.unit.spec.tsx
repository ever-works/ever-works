import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/actions/dashboard/missions', () => ({
    listMissionsAction: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    listProposalsAction: vi.fn(),
}));

// Stub the `Select` primitive with a native <select> — the real one is a
// portal-rendered custom listbox that only mounts its options once open,
// and these specs are about what the pickers FEED it, not the picker's
// internals (same convention as MissionAttachedWorksPanel.unit.spec.tsx).
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
            {children}
        </select>
    ),
}));

import { MissionSelect } from './MissionSelect';
import { IdeaSelect } from './IdeaSelect';
import { listMissionsAction } from '@/app/actions/dashboard/missions';
import { listProposalsAction } from '@/app/actions/dashboard/work-proposals';

const listMissions = vi.mocked(listMissionsAction);
const listIdeas = vi.mocked(listProposalsAction);

const MISSIONS = [
    { id: 'm-1', title: 'Grow the docs traffic', status: 'active' },
    { id: 'm-2', title: 'Retire the legacy importer', status: 'paused' },
];

const IDEAS = [
    { id: 'i-1', title: 'Directory of AI evals', status: 'pending' },
    { id: 'i-2', title: 'Changelog aggregator', status: 'accepted' },
];

/** The option labels a picker is currently offering, in order. */
function optionLabels(testId: string): string[] {
    const select = screen.getByTestId(testId) as HTMLSelectElement;
    return Array.from(select.options).map((o) => o.textContent ?? '');
}

beforeEach(() => {
    vi.clearAllMocks();
    // The pickers read only id/title/status; the full DTOs are large and
    // irrelevant to what an option row renders.
    listMissions.mockResolvedValue(MISSIONS as never);
    listIdeas.mockResolvedValue(IDEAS as never);
});

describe('MissionSelect', () => {
    it('offers the none option plus every Mission once loaded', async () => {
        render(
            <MissionSelect
                value=""
                onValueChange={vi.fn()}
                noneLabel="No Mission"
                testId="mission-select"
            />,
        );

        await waitFor(() => expect(listMissions).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(optionLabels('mission-select')).toEqual([
                'No Mission',
                'Grow the docs traffic',
                'Retire the legacy importer',
            ]),
        );
    });

    it('keeps an id outside the fetched page selectable so it cannot silently drop off', async () => {
        render(
            <MissionSelect
                value="deadbeef-0000-0000-0000-000000000000"
                onValueChange={vi.fn()}
                noneLabel="No Mission"
                testId="mission-select"
            />,
        );

        await waitFor(() => expect(optionLabels('mission-select')).toContain('deadbeef…'));
    });

    it('surfaces a load failure instead of rendering an empty picker', async () => {
        listMissions.mockRejectedValue(new Error('boom'));
        render(
            <MissionSelect
                value=""
                onValueChange={vi.fn()}
                noneLabel="No Mission"
                testId="mission-select"
            />,
        );

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));
    });
});

describe('IdeaSelect', () => {
    it('requests every status except dismissed', async () => {
        render(
            <IdeaSelect
                value=""
                onValueChange={vi.fn()}
                noneLabel="No Idea"
                testId="idea-select"
            />,
        );

        await waitFor(() => expect(listIdeas).toHaveBeenCalledTimes(1));
        const [statuses] = listIdeas.mock.calls[0];
        expect(statuses).toEqual(['pending', 'queued', 'building', 'accepted', 'failed']);
        expect(statuses).not.toContain('dismissed');
    });

    it('offers the none option plus every Idea once loaded', async () => {
        render(
            <IdeaSelect
                value=""
                onValueChange={vi.fn()}
                noneLabel="No Idea"
                testId="idea-select"
            />,
        );

        await waitFor(() =>
            expect(optionLabels('idea-select')).toEqual([
                'No Idea',
                'Directory of AI evals',
                'Changelog aggregator',
            ]),
        );
    });

    it('keeps an id outside the fetched page selectable (a dismissed Idea still shows)', async () => {
        render(
            <IdeaSelect
                value="feedface-0000-0000-0000-000000000000"
                onValueChange={vi.fn()}
                noneLabel="No Idea"
                testId="idea-select"
            />,
        );

        await waitFor(() => expect(optionLabels('idea-select')).toContain('feedface…'));
    });

    it('surfaces a load failure instead of rendering an empty picker', async () => {
        listIdeas.mockRejectedValue(new Error('ideas are down'));
        render(
            <IdeaSelect
                value=""
                onValueChange={vi.fn()}
                noneLabel="No Idea"
                testId="idea-select"
            />,
        );

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('ideas are down'));
    });
});
