import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { addMemberMock, removeMemberMock, refreshMock } = vi.hoisted(() => ({
    addMemberMock: vi.fn(),
    removeMemberMock: vi.fn(),
    refreshMock: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: refreshMock }),
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/dashboard/teams', () => ({
    addTeamMemberAction: addMemberMock,
    removeTeamMemberAction: removeMemberMock,
}));
vi.mock('@/components/teams/TeamResourcesSection', () => ({
    TeamResourcesSection: () => <div data-testid="resources-section" />,
}));

import { TeamDetailClient } from './TeamDetailClient';

/**
 * The Teams add-member picker could not add a human.
 *
 * The `Type` select shipped `<option value="user" disabled>`, so `Member` was
 * visible but unselectable, and `handleAdd` hardcoded `memberType: 'agent'` —
 * two independent defects, either of which alone would have kept humans off
 * every team. Neither was reachable by any existing test: nothing in the E2E
 * suite touched `team-member-type`, `team-member-select` or `team-member-add`.
 *
 * These render the real component and drive the real controls, because both
 * defects lived in the markup and the submit handler rather than in any
 * function a unit test could have called directly.
 */

const ORG = { id: 'org-1', slug: 'acme', displayName: 'Acme' } as any;

const AGENTS = [
    { id: 'ag-1', name: 'Scout', title: 'Researcher' },
    { id: 'ag-2', name: 'Scribe', title: null },
];

const USERS = [
    { id: 'u-1', username: 'ruslan', email: 'ruslan@ever.co', avatar: null },
    { id: 'u-2', username: 'dana', email: null, avatar: null },
];

function makeTeam(members: any[] = []) {
    return {
        id: 'team-1',
        name: 'Engineering',
        slug: 'engineering',
        description: null,
        parentTeamId: null,
        managerAgentId: null,
        avatarIcon: null,
        organizationId: 'org-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        members,
        childTeamIds: [],
    } as any;
}

function renderDetail(team = makeTeam()) {
    return render(
        <TeamDetailClient
            org={ORG}
            team={team}
            teams={[team]}
            agents={AGENTS}
            users={USERS as any}
            resources={{ work: [], task: [], agent: [], mission: [], idea: [] } as any}
            works={[]}
        />,
    );
}

const typeSelect = () => document.getElementById('team-member-type') as HTMLSelectElement;
const whoSelect = () => document.getElementById('team-member-select') as HTMLSelectElement;
const whoValues = () => [...whoSelect().options].map((o) => o.value).filter((v) => v !== '');

describe('TeamDetailClient — adding a human member', () => {
    beforeEach(() => {
        addMemberMock.mockReset().mockResolvedValue(undefined);
        removeMemberMock.mockReset();
        refreshMock.mockReset();
    });

    it('control: both controls render and Agent is the default type', () => {
        // If this failed, every "the Member option is selectable" assertion
        // below would be vacuously true against a component that never
        // rendered its picker at all.
        renderDetail();
        expect(typeSelect()).toBeTruthy();
        expect(whoSelect()).toBeTruthy();
        expect(typeSelect().value).toBe('agent');
        expect(whoValues()).toEqual(['ag-1', 'ag-2']);
    });

    it('the Member option is SELECTABLE — the reported bug', () => {
        renderDetail();
        const memberOption = [...typeSelect().options].find((o) => o.value === 'user');
        expect(memberOption).toBeTruthy();
        expect(memberOption!.disabled).toBe(false);
    });

    it('choosing Member swaps the Who list from Agents to people', async () => {
        renderDetail();
        await userEvent.selectOptions(typeSelect(), 'user');

        expect(whoValues()).toEqual(['u-1', 'u-2']);
        // And the Agents are genuinely gone, not merely appended after.
        expect(whoValues()).not.toContain('ag-1');
    });

    it('submits memberType "user" with the chosen person', async () => {
        // The second half of the defect: `handleAdd` hardcoded 'agent', so even
        // an enabled option would have posted an Agent membership carrying a
        // user's id.
        renderDetail();
        await userEvent.selectOptions(typeSelect(), 'user');
        await userEvent.selectOptions(whoSelect(), 'u-1');
        await userEvent.click(screen.getByTestId('team-member-add'));

        expect(addMemberMock).toHaveBeenCalledTimes(1);
        expect(addMemberMock).toHaveBeenCalledWith('org-1', 'team-1', {
            memberType: 'user',
            memberId: 'u-1',
            role: 'member',
        });
    });

    it('still submits memberType "agent" for an Agent (the path that worked)', async () => {
        renderDetail();
        await userEvent.selectOptions(whoSelect(), 'ag-2');
        await userEvent.click(screen.getByTestId('team-member-add'));

        expect(addMemberMock).toHaveBeenCalledWith('org-1', 'team-1', {
            memberType: 'agent',
            memberId: 'ag-2',
            role: 'member',
        });
    });

    it('clears a pending selection when the type changes', async () => {
        // Agent ids and user ids are separate id spaces. Carrying a selection
        // across the switch would post an Agent's id as a user — a 404 with
        // nothing on screen to explain it.
        renderDetail();
        await userEvent.selectOptions(whoSelect(), 'ag-1');
        expect(whoSelect().value).toBe('ag-1');

        await userEvent.selectOptions(typeSelect(), 'user');
        expect(whoSelect().value).toBe('');
        // Submit is inert until something is picked again.
        expect(screen.getByTestId('team-member-add')).toBeDisabled();
    });

    it('does not offer someone already on the roster', async () => {
        // `team_members` carries UNIQUE(teamId, memberType, memberId), so
        // offering them again could only ever 409.
        renderDetail(
            makeTeam([
                {
                    id: 'tm-1',
                    memberType: 'user',
                    memberId: 'u-1',
                    role: 'member',
                    name: 'ruslan',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ]),
        );
        await userEvent.selectOptions(typeSelect(), 'user');

        expect(whoValues()).toEqual(['u-2']);
    });

    it('filters the roster per type, so an Agent does not hide a person', async () => {
        // A single shared id set would be wrong the moment the two spaces
        // collide; this pins that the exclusion is keyed by memberType.
        renderDetail(
            makeTeam([
                {
                    id: 'tm-1',
                    memberType: 'agent',
                    memberId: 'u-1', // deliberately an id from the USER space
                    role: 'member',
                    name: 'Scout',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ]),
        );
        await userEvent.selectOptions(typeSelect(), 'user');

        expect(whoValues()).toEqual(['u-1', 'u-2']);
    });
});
