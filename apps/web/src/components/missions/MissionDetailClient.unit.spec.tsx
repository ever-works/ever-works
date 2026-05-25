import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPushMock }),
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

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const pauseMock = vi.fn();
const resumeMock = vi.fn();
const completeMock = vi.fn();
const deleteMock = vi.fn();
const runNowMock = vi.fn();
const updateMock = vi.fn();
const cloneMock = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    pauseMissionAction: (...args: unknown[]) => pauseMock(...args),
    resumeMissionAction: (...args: unknown[]) => resumeMock(...args),
    completeMissionAction: (...args: unknown[]) => completeMock(...args),
    deleteMissionAction: (...args: unknown[]) => deleteMock(...args),
    runMissionNowAction: (...args: unknown[]) => runNowMock(...args),
    updateMissionAction: (...args: unknown[]) => updateMock(...args),
    cloneMissionAction: (...args: unknown[]) => cloneMock(...args),
}));

// The IdeaCard inside the Ideas section pulls its own action mocks
// from work-proposals; stub those too so they don't try to hit the
// real server in jsdom.
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    dismissProposalAction: vi.fn(),
}));

import { MissionDetailClient } from './MissionDetailClient';
import type { Mission } from '@/lib/api/missions';
import type { WorkProposal } from '@/lib/api/work-proposals';

function mkMission(overrides: Partial<Mission> = {}): Mission {
    return {
        id: 'm1',
        title: 'Cats Business',
        description: 'd',
        type: 'scheduled',
        status: 'active',
        schedule: '0 9 * * MON',
        autoBuildWorks: false,
        outstandingIdeasCap: null,
        guardrailsOverride: null,
        missionTemplateRepo: null,
        missionRepo: null,
        sourceMissionId: null,
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        ...overrides,
    };
}

function mkIdea(id: string, overrides: Partial<WorkProposal> = {}): WorkProposal {
    return {
        id,
        userId: 'u1',
        title: `Idea ${id}`,
        description: 'Some Idea description longer than the minimum length',
        slugSuggestion: id,
        suggestedCategories: [],
        suggestedFields: [],
        recommendedPlugins: [],
        generatedPrompt: 'p',
        reasoning: '',
        source: 'mission',
        status: 'pending',
        generatedAt: '2026-05-24T00:00:00Z',
        ...overrides,
    } as unknown as WorkProposal;
}

describe('MissionDetailClient (Phase 6 PR R)', () => {
    it('renders the header with title, status pill, scheduled badge, and back link', () => {
        const { container } = render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
        expect(screen.getByText('Cats Business')).toBeTruthy();
        // StatusPill ('active' status).
        expect(container.textContent).toContain('active');
        // Scheduled badge for type=scheduled.
        expect(screen.getByText('badges.scheduled')).toBeTruthy();
        // Back link.
        const backLink = screen.getByText('backToMissions').closest('a');
        expect(backLink?.getAttribute('href')).toBe('/missions');
    });

    it('lifecycle buttons reflect the current status (ACTIVE shows pause+complete+runNow)', () => {
        render(<MissionDetailClient mission={mkMission({ status: 'active' })} ideas={[]} />);
        expect(screen.getByText('actions.pause')).toBeTruthy();
        expect(screen.getByText('actions.complete')).toBeTruthy();
        expect(screen.getByText('actions.runNow')).toBeTruthy();
        expect(screen.queryByText('actions.resume')).toBeNull();
    });

    it('lifecycle buttons reflect PAUSED status (resume+complete+runNow, no pause)', () => {
        render(<MissionDetailClient mission={mkMission({ status: 'paused' })} ideas={[]} />);
        expect(screen.getByText('actions.resume')).toBeTruthy();
        expect(screen.getByText('actions.complete')).toBeTruthy();
        expect(screen.getByText('actions.runNow')).toBeTruthy();
        expect(screen.queryByText('actions.pause')).toBeNull();
    });

    it('COMPLETED Mission hides pause/resume/complete/runNow (only Delete left)', () => {
        render(<MissionDetailClient mission={mkMission({ status: 'completed' })} ideas={[]} />);
        expect(screen.queryByText('actions.pause')).toBeNull();
        expect(screen.queryByText('actions.resume')).toBeNull();
        expect(screen.queryByText('actions.complete')).toBeNull();
        expect(screen.queryByText('actions.runNow')).toBeNull();
        // Delete remains.
        expect(screen.getByText('actions.delete')).toBeTruthy();
    });

    it('pause action wires to pauseMissionAction with the mission id', () => {
        pauseMock.mockClear();
        pauseMock.mockResolvedValueOnce(mkMission({ status: 'paused' }));
        render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
        fireEvent.click(screen.getByText('actions.pause'));
        expect(pauseMock).toHaveBeenCalledWith('m1');
    });

    it('run-now action wires to runMissionNowAction', () => {
        runNowMock.mockClear();
        runNowMock.mockResolvedValueOnce({ status: 'spawned', missionId: 'm1' });
        render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
        fireEvent.click(screen.getByText('actions.runNow'));
        expect(runNowMock).toHaveBeenCalledWith('m1');
    });

    it('delete confirms via window.confirm and skips on cancel', () => {
        deleteMock.mockClear();
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
        fireEvent.click(screen.getByText('actions.delete'));
        expect(confirmSpy).toHaveBeenCalled();
        expect(deleteMock).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it('delete confirms via window.confirm and proceeds on confirm', async () => {
        deleteMock.mockClear();
        deleteMock.mockResolvedValueOnce({ deleted: true });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
        fireEvent.click(screen.getByText('actions.delete'));
        await Promise.resolve();
        expect(deleteMock).toHaveBeenCalledWith('m1');
        confirmSpy.mockRestore();
    });

    it('saving settings PATCHes the schedule + auto-build + cap (with -1/inherit handling)', () => {
        updateMock.mockClear();
        updateMock.mockResolvedValueOnce(
            mkMission({ schedule: '*/30 * * * *', autoBuildWorks: true, outstandingIdeasCap: 7 }),
        );
        render(
            <MissionDetailClient mission={mkMission({ outstandingIdeasCap: null })} ideas={[]} />,
        );
        // Toggle autoBuild ON.
        const abLabel = screen.getByText('fields.autoBuildWorks').closest('label');
        const abBox = abLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement;
        fireEvent.click(abBox);
        // Untick "Inherit" toggle so the NumberField appears and capValue (default 20) saves.
        const inhLabel = screen.getByText('fields.capInherit').closest('label');
        const inhBox = inhLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement;
        fireEvent.click(inhBox);
        fireEvent.click(screen.getByText('actions.saveSettings'));
        expect(updateMock).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({
                autoBuildWorks: true,
                outstandingIdeasCap: 20,
            }),
        );
    });

    it('Ideas list renders one IdeaCard per child Idea + the per-section count', () => {
        const ideas = [mkIdea('p1'), mkIdea('p2'), mkIdea('p3')];
        render(<MissionDetailClient mission={mkMission()} ideas={ideas} />);
        // Count in the section header.
        expect(screen.getByText(/sections\.ideas/).textContent).toMatch(/3/);
        expect(screen.getByText('Idea p1')).toBeTruthy();
        expect(screen.getByText('Idea p2')).toBeTruthy();
        expect(screen.getByText('Idea p3')).toBeTruthy();
    });

    it('Related Works section lists only ACCEPTED Ideas with acceptedWorkId, linking to /works/<id>', () => {
        const ideas = [
            mkIdea('a', { status: 'accepted', acceptedWorkId: 'work-A' }),
            mkIdea('b', { status: 'accepted', acceptedWorkId: 'work-B' }),
            mkIdea('c', { status: 'accepted', acceptedWorkId: null }), // no Work id → not in panel
            mkIdea('d', { status: 'pending' }), // wrong status → not in panel
        ];
        const { container } = render(<MissionDetailClient mission={mkMission()} ideas={ideas} />);
        const worksSection = screen
            .getByText(/sections\.relatedWorks/)
            .closest('section') as HTMLElement;
        expect(worksSection).toBeTruthy();
        // Only 2 link entries (a, b).
        const links = within(worksSection).getAllByRole('link');
        expect(links).toHaveLength(2);
        const hrefs = links.map((l) => l.getAttribute('href'));
        expect(hrefs).toEqual(expect.arrayContaining(['/works/work-A', '/works/work-B']));
        // count badge says 2.
        expect(worksSection.textContent).toMatch(/\(2\)/);
        void container;
    });

    it('Related Works empty state when no accepted Ideas have a Work id', () => {
        render(
            <MissionDetailClient
                mission={mkMission()}
                ideas={[mkIdea('a', { status: 'pending' })]}
            />,
        );
        expect(screen.getByText('works.empty')).toBeTruthy();
    });

    it('Clone badge surfaces when sourceMissionId is set', () => {
        render(
            <MissionDetailClient mission={mkMission({ sourceMissionId: 'src-1' })} ideas={[]} />,
        );
        expect(screen.getByText('badges.cloned')).toBeTruthy();
    });

    describe('PR GG extras', () => {
        it('Activity + Spend sections render with v1 placeholder copy', () => {
            render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
            expect(screen.getByText('sections.activity')).toBeTruthy();
            expect(screen.getByText('activity.empty')).toBeTruthy();
            expect(screen.getByText('sections.spend')).toBeTruthy();
            expect(screen.getByText('spend.empty')).toBeTruthy();
        });

        it('Clone button opens the confirmation modal and wires a Cancel button', () => {
            render(<MissionDetailClient mission={mkMission()} ideas={[]} />);
            // Modal title not rendered before opening.
            expect(screen.queryByText('clone.title')).toBeNull();
            fireEvent.click(screen.getByText('actions.clone'));
            // Now visible.
            expect(screen.getByText('clone.title')).toBeTruthy();
            expect(screen.getByText('clone.description')).toBeTruthy();
            // Cancel button is present + wired (Headless UI dismount is
            // animated, so we don't synchronously assert the modal
            // disappears — just that the Cancel button rendered).
            const cancel = screen.getByText('clone.cancel');
            expect(cancel.closest('button')?.disabled).toBe(false);
        });

        it('Clone modal Confirm calls cloneMissionAction with the title override', async () => {
            cloneMock.mockClear();
            routerPushMock.mockClear();
            cloneMock.mockResolvedValueOnce({
                mission: mkMission({ id: 'clone-1' }),
                ideasCloned: 2,
                ideasSkipped: 1,
            });
            render(<MissionDetailClient mission={mkMission({ id: 'src' })} ideas={[]} />);
            fireEvent.click(screen.getByText('actions.clone'));
            // Type a custom title.
            const input = screen.getByPlaceholderText(/Copy of/);
            fireEvent.change(input, { target: { value: 'My Forked Mission' } });
            fireEvent.click(screen.getByText('clone.confirm'));
            // Wait for action + transition.
            await Promise.resolve();
            await Promise.resolve();
            expect(cloneMock).toHaveBeenCalledWith('src', 'My Forked Mission');
            // Navigation kicks to the new clone's detail page.
            expect(routerPushMock).toHaveBeenCalledWith('/missions/clone-1');
        });

        it('Clone modal Confirm with empty title omits the title arg (server uses "Copy of ..." default)', async () => {
            cloneMock.mockClear();
            cloneMock.mockResolvedValueOnce({
                mission: mkMission({ id: 'clone-2' }),
                ideasCloned: 0,
                ideasSkipped: 0,
            });
            render(<MissionDetailClient mission={mkMission({ id: 'src' })} ideas={[]} />);
            fireEvent.click(screen.getByText('actions.clone'));
            fireEvent.click(screen.getByText('clone.confirm'));
            await Promise.resolve();
            await Promise.resolve();
            expect(cloneMock).toHaveBeenCalledWith('src', undefined);
        });

        it('Inherited Works panel hidden for direct-created Missions (sourceMissionId null)', () => {
            render(
                <MissionDetailClient mission={mkMission({ sourceMissionId: null })} ideas={[]} />,
            );
            expect(screen.queryByText('sections.inheritedWorks')).toBeNull();
        });

        it('Inherited Works panel shows when sourceMissionId is set, with from-source link + Work list', () => {
            const source = mkMission({ id: 'src', title: 'Source Mission' });
            const cloned = mkMission({ id: 'clone', sourceMissionId: 'src' });
            const inheritedIdeas = [
                mkIdea('i1', {
                    status: 'accepted',
                    acceptedWorkId: 'work-A',
                    title: 'Inherited Idea A',
                }),
                mkIdea('i2', {
                    status: 'accepted',
                    acceptedWorkId: 'work-B',
                    title: 'Inherited Idea B',
                }),
                // Pending Idea should NOT appear (no acceptedWorkId).
                mkIdea('i3', { status: 'pending' }),
            ];
            render(
                <MissionDetailClient
                    mission={cloned}
                    ideas={[]}
                    sourceMission={source}
                    inheritedIdeas={inheritedIdeas}
                />,
            );
            // Section heading + count badge.
            const heading = screen.getByText(/sections\.inheritedWorks/);
            expect(heading.textContent).toMatch(/2/);
            // From-source link points at the source Mission detail page.
            const sourceLink = screen.getByText('Source Mission').closest('a');
            expect(sourceLink?.getAttribute('href')).toBe('/missions/src');
            // Work links use the inherited IdeaCard's title text.
            const workALink = screen.getByText('Inherited Idea A').closest('a');
            expect(workALink?.getAttribute('href')).toBe('/works/work-A');
        });

        it('IdeaCard inline failure error renders for FAILED Ideas with failureMessage + kind', () => {
            const failed = mkIdea('f1', {
                status: 'failed',
                failureMessage: 'Upstream returned 503 after 3 retries.',
                failureKind: 'transient-upstream-5xx',
            });
            render(<MissionDetailClient mission={mkMission()} ideas={[failed]} />);
            // Failure-kind label (i18n key returned as the key under the mock).
            expect(screen.getByText('failureKinds.transient-upstream-5xx')).toBeTruthy();
            // Failure message body.
            expect(screen.getByText(/Upstream returned 503/)).toBeTruthy();
        });

        it('IdeaCard inline failure error is NOT rendered for non-FAILED Ideas', () => {
            const ok = mkIdea('a', { status: 'pending' });
            render(<MissionDetailClient mission={mkMission()} ideas={[ok]} />);
            // No failure-kind text anywhere.
            expect(screen.queryByText(/failureKinds\./)).toBeNull();
        });
    });
});
