import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import { MissionsList } from './MissionsList';
import type { Mission } from '@/lib/api/missions';

function mkMission(id: string, overrides: Partial<Mission> = {}): Mission {
    return {
        id,
        title: `Mission ${id}`,
        description: 'd',
        type: 'scheduled',
        status: 'active',
        schedule: '* * * * *',
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

describe('MissionsList (Phase 6 PR Q)', () => {
    it('renders header title + subtitle', () => {
        render(<MissionsList missions={[]} />);
        expect(screen.getByText('title')).toBeTruthy();
        expect(screen.getByText('subtitle')).toBeTruthy();
    });

    it('renders the top-right "+ New Mission" button linking to /new?type=mission', () => {
        const { container } = render(<MissionsList missions={[]} />);
        const newMissionLinks = Array.from(container.querySelectorAll('a[href]')).filter(
            (a) => (a as HTMLAnchorElement).textContent?.includes('newMission'),
        );
        expect(newMissionLinks.length).toBeGreaterThan(0);
        // All "+ New Mission" links point at /new?type=mission so Phase
        // 6.5 PR CC2's `/new` page can read the type query param to
        // pre-fill the chip selection.
        for (const a of newMissionLinks) {
            expect((a as HTMLAnchorElement).getAttribute('href')).toBe('/new?type=mission');
        }
    });

    it('renders the empty-state surface when no Missions exist', () => {
        render(<MissionsList missions={[]} />);
        expect(screen.getByText('empty.title')).toBeTruthy();
        expect(screen.getByText('empty.subtitle')).toBeTruthy();
    });

    it('renders one MissionCard per Mission and no empty-state when missions present', () => {
        const missions = ['a', 'b', 'c'].map((id) => mkMission(id));
        render(<MissionsList missions={missions} />);
        expect(screen.getByText('Mission a')).toBeTruthy();
        expect(screen.getByText('Mission b')).toBeTruthy();
        expect(screen.getByText('Mission c')).toBeTruthy();
        expect(screen.queryByText('empty.title')).toBeNull();
    });

    it('NO large quick-add form is rendered (Phase 6.5 PR CC2 owns /new)', () => {
        const { container } = render(<MissionsList missions={[]} />);
        // Quick-add would be a textarea — the catalog page must not
        // ship one per spec §5.5 PR Q. The /missions page is browse-
        // and-detail; creation goes through /new.
        expect(container.querySelector('textarea')).toBeNull();
    });
});
