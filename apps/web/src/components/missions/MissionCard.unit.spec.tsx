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

import { MissionCard } from './MissionCard';
import type { Mission } from '@/lib/api/missions';

function mkMission(overrides: Partial<Mission> = {}): Mission {
    return {
        id: 'm1',
        title: 'Cats Business',
        description: "Run the world's best cat business.",
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

describe('MissionCard (Phase 6 PR Q)', () => {
    it('renders title + description + status pill', () => {
        const { container } = render(<MissionCard mission={mkMission()} />);
        expect(screen.getByText('Cats Business')).toBeTruthy();
        expect(screen.getByText(/cat business/i)).toBeTruthy();
        // StatusPill from PR K renders 'active' verbatim.
        expect(container.textContent).toContain('active');
    });

    it('wraps the card body in a Link to /missions/<id>', () => {
        const { container } = render(<MissionCard mission={mkMission({ id: 'mission-42' })} />);
        const link = container.querySelector('a[href]') as HTMLAnchorElement;
        expect(link?.getAttribute('href')).toBe('/missions/mission-42');
    });

    it('shows the Scheduled badge and cron string for type=scheduled', () => {
        const { container } = render(
            <MissionCard mission={mkMission({ type: 'scheduled', schedule: '*/15 * * * *' })} />,
        );
        expect(screen.getByText('scheduled')).toBeTruthy();
        // Cron rendered in <code>.
        expect(container.querySelector('code')?.textContent).toBe('*/15 * * * *');
        // schedulePrefix label rendered next to it.
        expect(container.textContent).toContain('schedulePrefix');
    });

    it('shows the One-shot badge and no cron line for type=one-shot', () => {
        const { container } = render(
            <MissionCard mission={mkMission({ type: 'one-shot', schedule: null })} />,
        );
        expect(screen.getByText('oneShot')).toBeTruthy();
        // No cron <code> rendered for one-shot.
        expect(container.querySelector('code')).toBeNull();
    });

    it('cap label rules (mirrors MissionTickService.resolveEffectiveCap)', () => {
        // null → Inherit user default.
        const r1 = render(<MissionCard mission={mkMission({ outstandingIdeasCap: null })} />);
        expect(r1.container.textContent).toContain('capInherit');
        r1.unmount();
        // -1 → Unlimited.
        const r2 = render(<MissionCard mission={mkMission({ outstandingIdeasCap: -1 })} />);
        expect(r2.container.textContent).toContain('capUnlimited');
        r2.unmount();
        // 7 → literal number.
        const r3 = render(<MissionCard mission={mkMission({ outstandingIdeasCap: 7 })} />);
        expect(r3.container.textContent).toContain('7');
        r3.unmount();
    });

    it('autoBuild line shows the correct on/off label', () => {
        const r1 = render(<MissionCard mission={mkMission({ autoBuildWorks: true })} />);
        expect(r1.container.textContent).toContain('autoBuildOn');
        r1.unmount();
        const r2 = render(<MissionCard mission={mkMission({ autoBuildWorks: false })} />);
        expect(r2.container.textContent).toContain('autoBuildOff');
    });

    it('renders a clone-from indicator (GitFork icon + tooltip) when sourceMissionId is set', () => {
        const { container } = render(
            <MissionCard mission={mkMission({ sourceMissionId: 'src-1' })} />,
        );
        // The clone badge has a title attribute carrying the i18n key.
        const badge = container.querySelector('span[title="clonedFromPrefix"]');
        expect(badge).toBeTruthy();
    });

    it('does NOT render the clone-from indicator for direct-created Missions', () => {
        const { container } = render(
            <MissionCard mission={mkMission({ sourceMissionId: null })} />,
        );
        expect(container.querySelector('span[title="clonedFromPrefix"]')).toBeNull();
    });
});
