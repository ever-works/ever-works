import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
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

const getRosterBlueprints = vi.fn();
const getRosterState = vi.fn();
const provisionRoster = vi.fn();
vi.mock('@/app/actions/onboarding/roster', () => ({
    getRosterBlueprints: (...args: unknown[]) => getRosterBlueprints(...args),
    getRosterState: (...args: unknown[]) => getRosterState(...args),
    provisionRoster: (...args: unknown[]) => provisionRoster(...args),
    acknowledgeRoster: vi.fn(),
}));

// The progress panel polls and owns a dialog; the step under test only
// has to hand over to it. Its own behaviour has its own spec.
vi.mock('@/components/get-started/RosterProvisionProgress', () => ({
    RosterProvisionProgress: ({ runId }: { runId: string }) => (
        <div data-testid="stub-progress">progress:{runId}</div>
    ),
}));

import { RosterStep } from './RosterStep';
import type { RosterBlueprintsResponse } from '@/lib/api/onboarding';

function blueprints(overrides: Partial<RosterBlueprintsResponse> = {}): RosterBlueprintsResponse {
    return {
        blueprintSlug: 'general',
        derivedFromRoles: true,
        laneCap: 5,
        maxLanes: 8,
        nameMax: 60,
        proposal: [
            {
                laneKey: 'coordination',
                labelKey: 'coordination',
                templateSlug: 'workspace-coordinator',
                defaultName: 'Ada',
                isCoordinator: true,
            },
            {
                laneKey: 'research',
                labelKey: 'research',
                templateSlug: 'lead-researcher',
                defaultName: 'Research',
                isCoordinator: false,
            },
        ],
        catalog: [
            {
                laneKey: 'coordination',
                labelKey: 'coordination',
                templateSlug: 'workspace-coordinator',
                defaultName: 'Ada',
                isCoordinator: true,
            },
            {
                laneKey: 'research',
                labelKey: 'research',
                templateSlug: 'lead-researcher',
                defaultName: 'Research',
                isCoordinator: false,
            },
            {
                laneKey: 'content',
                labelKey: 'content',
                templateSlug: 'content-marketer',
                defaultName: 'Content',
                isCoordinator: false,
            },
        ],
        canCreateAgents: true,
        ...overrides,
    };
}

describe('RosterStep', () => {
    beforeEach(() => {
        getRosterBlueprints.mockReset();
        getRosterState.mockReset();
        provisionRoster.mockReset();
        provisionRoster.mockResolvedValue({
            success: true,
            data: { runId: 'run-1', state: 'queued' },
        });
    });

    it('renders one card per proposed lane, with the coordinator first and un-removable', () => {
        render(<RosterStep initialBlueprints={blueprints()} />);

        expect(screen.getByTestId('onboarding-roster-lane-coordination')).toBeInTheDocument();
        expect(screen.getByTestId('onboarding-roster-lane-research')).toBeInTheDocument();
        // The coordinator is the one lane a roster cannot be without, so
        // it ships no Remove control at all — not a disabled one.
        expect(screen.queryByTestId('onboarding-roster-remove-coordination')).toBeNull();
        expect(screen.getByTestId('onboarding-roster-remove-research')).toBeInTheDocument();
    });

    it('blocks the primary action and explains itself when a name is emptied', async () => {
        const user = userEvent.setup();
        render(<RosterStep initialBlueprints={blueprints()} />);

        await user.clear(screen.getByTestId('onboarding-roster-name-research'));

        expect(screen.getByTestId('onboarding-roster-submit')).toBeDisabled();
        expect(screen.getByText('onboarding.rosterStep.nameRequired')).toBeInTheDocument();
    });

    it('blocks the primary action when a name runs past the ceiling', async () => {
        const user = userEvent.setup();
        render(<RosterStep initialBlueprints={blueprints({ nameMax: 5 })} />);

        const field = screen.getByTestId('onboarding-roster-name-research');
        await user.clear(field);
        await user.type(field, 'Research');

        expect(screen.getByTestId('onboarding-roster-submit')).toBeDisabled();
        expect(screen.getByText('onboarding.rosterStep.nameTooLong')).toBeInTheDocument();
    });

    it('removes a lane and stops offering it in the add menu once it is back', async () => {
        const user = userEvent.setup();
        render(<RosterStep initialBlueprints={blueprints()} />);

        await user.click(screen.getByTestId('onboarding-roster-remove-research'));
        expect(screen.queryByTestId('onboarding-roster-lane-research')).toBeNull();

        await user.click(screen.getByTestId('onboarding-roster-add'));
        await user.click(screen.getByTestId('onboarding-roster-add-research'));
        expect(screen.getByTestId('onboarding-roster-lane-research')).toBeInTheDocument();
    });

    it('stops adding lanes at the cap and says why', async () => {
        const user = userEvent.setup();
        render(<RosterStep initialBlueprints={blueprints({ maxLanes: 2 })} />);

        expect(screen.getByTestId('onboarding-roster-add')).toBeDisabled();
        expect(screen.getByTestId('onboarding-roster-add-full')).toHaveTextContent(
            'onboarding.rosterStep.addLaneFull',
        );
        await user.click(screen.getByTestId('onboarding-roster-add'));
        expect(screen.queryByTestId('onboarding-roster-add-menu')).toBeNull();
    });

    it('renders read-only with an explanation when the caller cannot add agents', () => {
        render(<RosterStep initialBlueprints={blueprints({ canCreateAgents: false })} />);

        expect(screen.getByTestId('onboarding-roster-readonly')).toHaveTextContent(
            'onboarding.rosterStep.readOnlyNotice',
        );
        expect(screen.getByTestId('onboarding-roster-submit')).toBeDisabled();
        expect(screen.getByTestId('onboarding-roster-name-research')).toBeDisabled();
    });

    it('sends every lane with its edited name and hands over to the progress panel', async () => {
        const user = userEvent.setup();
        render(<RosterStep initialBlueprints={blueprints()} />);

        const field = screen.getByTestId('onboarding-roster-name-coordination');
        await user.clear(field);
        await user.type(field, 'Nova');
        await user.click(screen.getByTestId('onboarding-roster-submit'));

        expect(provisionRoster).toHaveBeenCalledWith({
            blueprintSlug: 'general',
            lanes: [
                { laneKey: 'coordination', name: 'Nova' },
                { laneKey: 'research', name: 'Research' },
            ],
        });
        expect(await screen.findByTestId('stub-progress')).toHaveTextContent('progress:run-1');
    });

    it('keeps the user on the step and surfaces the reason when provisioning is refused', async () => {
        const user = userEvent.setup();
        provisionRoster.mockResolvedValue({
            success: false,
            error: 'A roster is already being set up.',
        });
        render(<RosterStep initialBlueprints={blueprints()} />);

        await user.click(screen.getByTestId('onboarding-roster-submit'));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'A roster is already being set up.',
        );
        expect(screen.queryByTestId('stub-progress')).toBeNull();
    });

    it('says a starting point was picked when no roles were answered', () => {
        render(<RosterStep initialBlueprints={blueprints({ derivedFromRoles: false })} />);

        expect(screen.getByText('onboarding.rosterStep.noRolesNotice')).toBeInTheDocument();
    });
});
