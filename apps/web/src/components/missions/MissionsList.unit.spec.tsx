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
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/app/actions/dashboard/missions', () => ({
    createMissionAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

describe('MissionsList (Phase 6 PR Q + quick-add)', () => {
    it('renders header title + subtitle', () => {
        render(<MissionsList missions={[]} />);
        expect(screen.getByText('title')).toBeTruthy();
        expect(screen.getByText('subtitle')).toBeTruthy();
    });

    it('renders the inline quick-add composer on the /missions page', () => {
        const { container } = render(<MissionsList missions={[]} />);
        const textarea = container.querySelector('textarea');
        expect(textarea).not.toBeNull();
        // Label points at the quick-add input.
        const label = container.querySelector('label[for="missions-quick-add"]');
        expect(label).not.toBeNull();
    });

    it('renders the empty-state surface when no Missions exist', () => {
        render(<MissionsList missions={[]} />);
        expect(screen.getByText('empty.title')).toBeTruthy();
        expect(screen.getByText('empty.subtitle')).toBeTruthy();
        // The empty state no longer carries a secondary "open the
        // unified creator" button — the inline composer above is the
        // single entry point.
    });

    it('renders one MissionCard per Mission and no empty-state when missions present', () => {
        const missions = ['a', 'b', 'c'].map((id) => mkMission(id));
        render(<MissionsList missions={missions} />);
        expect(screen.getByText('Mission a')).toBeTruthy();
        expect(screen.getByText('Mission b')).toBeTruthy();
        expect(screen.getByText('Mission c')).toBeTruthy();
        expect(screen.queryByText('empty.title')).toBeNull();
    });

    it('keeps the quick-add composer visible after Missions exist (single entry point)', () => {
        const missions = ['a'].map((id) => mkMission(id));
        const { container } = render(<MissionsList missions={missions} />);
        expect(container.querySelector('textarea')).not.toBeNull();
    });
});
