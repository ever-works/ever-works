import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
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

const createMissionMock = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    createMissionAction: (...args: unknown[]) => createMissionMock(...args),
}));

const createIdeaMock = vi.fn();
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    createIdeaAction: (...args: unknown[]) => createIdeaMock(...args),
}));

import { NewPageClient } from './NewPageClient';

describe('NewPageClient (Phase 6.5 PR CC2)', () => {
    it('renders all 7 chips in the spec order: Mission, Idea, Website, Landing Page, Blog, Directory, Awesome Repo', () => {
        const { container } = render(<NewPageClient />);
        const chipButtons = Array.from(
            container.querySelectorAll('button[aria-pressed]'),
        ) as HTMLButtonElement[];
        // 7 chips with aria-pressed (the chip strip uses aria-pressed
        // for active state; CTA + trio buttons don't).
        expect(chipButtons).toHaveLength(7);
        const labels = chipButtons.map((b) => b.textContent?.trim());
        expect(labels).toEqual([
            'dashboard.newPage.chips.mission',
            'dashboard.newPage.chips.idea',
            'dashboard.newPage.chips.website',
            'dashboard.newPage.chips.landing-page',
            'dashboard.newPage.chips.blog',
            'dashboard.newPage.chips.directory',
            'dashboard.newPage.chips.awesome-repo',
        ]);
    });

    it('pre-selects the chip from initialType prop', () => {
        const { container } = render(<NewPageClient initialType="mission" />);
        const mission = Array.from(
            container.querySelectorAll('button[aria-pressed]'),
        ).find((b) => b.textContent?.includes('mission')) as HTMLButtonElement;
        expect(mission.getAttribute('aria-pressed')).toBe('true');
    });

    it('Submit button is disabled until BOTH a chip is selected AND the prompt is >= 10 chars', () => {
        render(<NewPageClient />);
        const submit = screen.getByText('dashboard.newPage.submit').closest('button')!;
        expect(submit.disabled).toBe(true);
        // Pick a chip — still disabled because prompt is empty.
        fireEvent.click(screen.getByText('dashboard.newPage.chips.idea'));
        expect(submit.disabled).toBe(true);
        // Type something short — still disabled.
        const textarea = screen.getByPlaceholderText(
            'dashboard.newPage.promptPlaceholder',
        );
        fireEvent.change(textarea, { target: { value: 'short' } });
        expect(submit.disabled).toBe(true);
        // Type something long enough — enabled.
        fireEvent.change(textarea, {
            target: { value: 'A long enough idea description here' },
        });
        expect(submit.disabled).toBe(false);
    });

    it('Submit with chip=mission calls createMissionAction and routes to the new Mission detail page', async () => {
        createMissionMock.mockClear();
        routerPushMock.mockClear();
        createMissionMock.mockResolvedValueOnce({ id: 'm-new', title: 'x' });
        render(<NewPageClient initialType="mission" />);
        fireEvent.change(
            screen.getByPlaceholderText('dashboard.newPage.promptPlaceholder'),
            { target: { value: 'Build the best cat business' } },
        );
        fireEvent.click(screen.getByText('dashboard.newPage.submit'));
        await Promise.resolve();
        await Promise.resolve();
        expect(createMissionMock).toHaveBeenCalledWith({
            description: 'Build the best cat business',
            type: 'one-shot',
        });
        expect(routerPushMock).toHaveBeenCalledWith('/missions/m-new');
    });

    it('Submit with chip=idea calls createIdeaAction and routes to /ideas', async () => {
        createIdeaMock.mockClear();
        routerPushMock.mockClear();
        createIdeaMock.mockResolvedValueOnce({ id: 'i-new' });
        render(<NewPageClient initialType="idea" />);
        fireEvent.change(
            screen.getByPlaceholderText('dashboard.newPage.promptPlaceholder'),
            { target: { value: 'A curated list of AI coding agents' } },
        );
        fireEvent.click(screen.getByText('dashboard.newPage.submit'));
        await Promise.resolve();
        await Promise.resolve();
        expect(createIdeaMock).toHaveBeenCalledWith({
            description: 'A curated list of AI coding agents',
        });
        expect(routerPushMock).toHaveBeenCalledWith('/ideas');
    });

    it('Submit with chip=website routes to /works/new with kind + prompt query params', () => {
        routerPushMock.mockClear();
        render(<NewPageClient initialType="website" />);
        fireEvent.change(
            screen.getByPlaceholderText('dashboard.newPage.promptPlaceholder'),
            { target: { value: 'Landing page for my SaaS launch' } },
        );
        fireEvent.click(screen.getByText('dashboard.newPage.submit'));
        expect(routerPushMock).toHaveBeenCalledTimes(1);
        const href = routerPushMock.mock.calls[0][0] as string;
        expect(href.startsWith('/works/new?')).toBe(true);
        expect(href).toContain('kind=website');
        // URLSearchParams encodes spaces as `+`, not `%20`.
        expect(href).toContain('prompt=Landing+page+for+my+SaaS+launch');
    });

    it('CreationBlockTrio renders below the chip strip with labelSet="unified"', () => {
        const { container } = render(<NewPageClient />);
        // Unified label set: title key is "dashboard.newPage.cards.ai.title"
        // (vs. legacy "dashboard.workCreation.ai.title").
        expect(screen.getByText('dashboard.newPage.cards.ai.title')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.manual.title')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.import.title')).toBeTruthy();
        // Three mode-card buttons (no aria-pressed on these).
        const modeButtons = Array.from(container.querySelectorAll('button:not([aria-pressed])'));
        // At least 3 (Submit + 3 mode buttons). The Submit also lacks
        // aria-pressed but is the only non-trio button.
        expect(modeButtons.length).toBeGreaterThanOrEqual(4);
    });
});
