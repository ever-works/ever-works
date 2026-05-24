import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => {
        const fn = (key: string, vars?: Record<string, unknown>) =>
            vars ? `${key}:${JSON.stringify(vars)}` : key;
        // Minimal `t.rich` shim: invoke each tag function with a
        // textual placeholder and inline the result alongside the
        // key. Enough fidelity for the empty-state markup test —
        // we don't need to match the exact rendered tree, just
        // verify the tag function was called with content.
        (fn as unknown as { rich: (k: string, tags: Record<string, (chunks: string) => React.ReactNode>) => React.ReactNode }).rich = (
            k,
            tags,
        ) => {
            const lines: React.ReactNode[] = [k];
            for (const [name, render] of Object.entries(tags)) {
                lines.push(render(`<${name}>`));
            }
            return lines;
        };
        return fn;
    },
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

import { MissionsPreviewSection } from './MissionsPreviewSection';
import type { Mission } from '@/lib/api/missions';
import type { WorkProposal } from '@/lib/api/work-proposals';

function mkMission(id: string, overrides: Partial<Mission> = {}): Mission {
    return {
        id,
        title: `Mission ${id}`,
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

function mkIdea(id: string, missionId: string | null, overrides: Partial<WorkProposal> = {}): WorkProposal {
    return {
        id,
        userId: 'u1',
        title: `Idea ${id}`,
        description: 'd',
        slugSuggestion: id,
        suggestedCategories: [],
        suggestedFields: [],
        recommendedPlugins: [],
        generatedPrompt: 'p',
        reasoning: '',
        source: 'mission',
        status: 'pending',
        missionId,
        generatedAt: '2026-05-24T00:00:00Z',
        ...overrides,
    } as unknown as WorkProposal;
}

describe('MissionsPreviewSection (Phase 6 PR S)', () => {
    it('renders an empty-state card with a "Start one" link when no Missions exist', () => {
        const { container } = render(<MissionsPreviewSection missions={[]} allIdeas={[]} />);
        expect(screen.getByText('empty.title')).toBeTruthy();
        // The rich-shim renders `<link>` as a child of the Link
        // component (so the href is rendered too). Verify the link
        // points at /new?type=mission.
        const newLink = container.querySelector('a[href="/new?type=mission"]');
        expect(newLink).toBeTruthy();
    });

    it('does NOT render the "View all" link when there are no Missions', () => {
        render(<MissionsPreviewSection missions={[]} allIdeas={[]} />);
        expect(screen.queryByText(/viewAll:/)).toBeNull();
    });

    it('renders up to 3 MissionPreviewCards even when more Missions exist', () => {
        const missions = ['a', 'b', 'c', 'd', 'e'].map((id) => mkMission(id));
        render(<MissionsPreviewSection missions={missions} allIdeas={[]} />);
        expect(screen.getByText('Mission a')).toBeTruthy();
        expect(screen.getByText('Mission b')).toBeTruthy();
        expect(screen.getByText('Mission c')).toBeTruthy();
        expect(screen.queryByText('Mission d')).toBeNull();
        expect(screen.queryByText('Mission e')).toBeNull();
    });

    it('"View all (N)" link counts the FULL Mission set (not just the visible 3)', () => {
        const missions = ['a', 'b', 'c', 'd', 'e'].map((id) => mkMission(id));
        render(<MissionsPreviewSection missions={missions} allIdeas={[]} />);
        const link = screen.getByText('viewAll:{"n":5}').closest('a');
        expect(link?.getAttribute('href')).toBe('/missions');
    });

    it('per-card counters derive Ideas + Works from the missionId-tagged Idea list', () => {
        const missions = [mkMission('m1'), mkMission('m2')];
        const allIdeas: WorkProposal[] = [
            // Mission m1: 3 Ideas, 1 of them ACCEPTED with workId.
            mkIdea('i1', 'm1'),
            mkIdea('i2', 'm1', { status: 'accepted', acceptedWorkId: 'work-a' }),
            mkIdea('i3', 'm1'),
            // Mission m2: 1 Idea, ACCEPTED with workId.
            mkIdea('i4', 'm2', { status: 'accepted', acceptedWorkId: 'work-b' }),
            // No mission — should not count anywhere.
            mkIdea('orph', null),
        ];
        const { container } = render(
            <MissionsPreviewSection missions={missions} allIdeas={allIdeas} />,
        );

        // Locate each card by its title and read its counter chip values.
        const findCard = (title: string): HTMLElement => {
            return screen.getByText(title).closest('a') as HTMLElement;
        };
        const m1Card = findCard('Mission m1');
        const m2Card = findCard('Mission m2');

        // Ideas / Works / Sites counter chips render their values as
        // the second line in each `.text-sm.font-semibold` block.
        const m1Counters = within(m1Card)
            .getAllByText(/^\d+$/)
            .map((n) => n.textContent);
        const m2Counters = within(m2Card)
            .getAllByText(/^\d+$/)
            .map((n) => n.textContent);

        // Mission m1: 3 Ideas, 1 Work, 0 Sites.
        expect(m1Counters).toEqual(['3', '1', '0']);
        // Mission m2: 1 Idea, 1 Work, 0 Sites.
        expect(m2Counters).toEqual(['1', '1', '0']);
        void container;
    });

    it('Sites counter is always 0 in v1 (placeholder until Phase 7 wires it)', () => {
        const missions = [mkMission('m1')];
        const allIdeas: WorkProposal[] = [
            mkIdea('a', 'm1', { status: 'accepted', acceptedWorkId: 'work-a' }),
        ];
        const { container } = render(
            <MissionsPreviewSection missions={missions} allIdeas={allIdeas} />,
        );
        // Find the counter chip labeled "counters.sites".
        const sitesChip = screen.getByText('counters.sites').closest('div')!;
        // The value is the next-sibling div.
        const valueEl = sitesChip.parentElement?.querySelector(
            '.text-sm.font-semibold',
        );
        expect(valueEl?.textContent).toBe('0');
        void container;
    });

    it('each card wraps in a Link to /missions/<id>', () => {
        const missions = [mkMission('mission-42')];
        const { container } = render(
            <MissionsPreviewSection missions={missions} allIdeas={[]} />,
        );
        const link = container.querySelector('a[href="/missions/mission-42"]');
        expect(link).toBeTruthy();
    });

    it('renders the Scheduled badge for type=scheduled Missions only', () => {
        const missions = [
            mkMission('s1', { type: 'scheduled' }),
            mkMission('o1', { type: 'one-shot', schedule: null }),
        ];
        const { container } = render(
            <MissionsPreviewSection missions={missions} allIdeas={[]} />,
        );
        // Scheduled badge present somewhere on the section.
        expect(screen.getAllByText('badges.scheduled').length).toBe(1);
        void container;
    });
});
