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

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
    const el = container.querySelector('textarea[data-testid="new-prompt"]');
    if (!el) throw new Error('prompt textarea not found');
    return el as HTMLTextAreaElement;
}

function getSubmit(container: HTMLElement): HTMLButtonElement {
    const el = container.querySelector('button[data-testid="new-prompt-submit"]');
    if (!el) throw new Error('submit button not found');
    return el as HTMLButtonElement;
}

describe('NewPageClient (Phase 6.5 PR CC2 + UI polish)', () => {
    it('renders all 7 chips in the spec order: Mission, Idea, Website, Landing Page, Blog, Directory, Awesome Repo', () => {
        const { container } = render(<NewPageClient />);
        const chipButtons = Array.from(
            container.querySelectorAll('button[aria-pressed]'),
        ) as HTMLButtonElement[];
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
        const mission = Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) =>
            b.textContent?.includes('mission'),
        ) as HTMLButtonElement;
        expect(mission.getAttribute('aria-pressed')).toBe('true');
    });

    it('defaults to Mission when no initialType is supplied', () => {
        const { container } = render(<NewPageClient />);
        const mission = Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) =>
            b.textContent?.includes('mission'),
        ) as HTMLButtonElement;
        expect(mission.getAttribute('aria-pressed')).toBe('true');
    });

    it('Submit (arrow) is disabled until the prompt is >= 10 chars', () => {
        const { container } = render(<NewPageClient initialType="idea" />);
        const submit = getSubmit(container);
        expect(submit.disabled).toBe(true);
        const textarea = getTextarea(container);
        fireEvent.change(textarea, { target: { value: 'short' } });
        expect(submit.disabled).toBe(true);
        fireEvent.change(textarea, {
            target: { value: 'A long enough idea description here' },
        });
        expect(submit.disabled).toBe(false);
    });

    it('shows a one-line description for the currently selected chip', () => {
        render(<NewPageClient initialType="mission" />);
        expect(screen.getByText('dashboard.newPage.chipDescriptions.mission')).toBeTruthy();
    });

    it('Submit with chip=mission calls createMissionAction and routes to the new Mission detail page', async () => {
        createMissionMock.mockClear();
        routerPushMock.mockClear();
        createMissionMock.mockResolvedValueOnce({ id: 'm-new', title: 'x' });
        const { container } = render(<NewPageClient initialType="mission" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Build the best cat business' },
        });
        fireEvent.click(getSubmit(container));
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
        const { container } = render(<NewPageClient initialType="idea" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'A curated list of AI coding agents' },
        });
        fireEvent.click(getSubmit(container));
        await Promise.resolve();
        await Promise.resolve();
        expect(createIdeaMock).toHaveBeenCalledWith({
            description: 'A curated list of AI coding agents',
        });
        expect(routerPushMock).toHaveBeenCalledWith('/ideas');
    });

    it('Submit with chip=website routes to the Work wizard with mode + kind + prompt query params', () => {
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="website" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Landing page for my SaaS launch' },
        });
        fireEvent.click(getSubmit(container));
        expect(routerPushMock).toHaveBeenCalledTimes(1);
        const href = routerPushMock.mock.calls[0][0] as string;
        expect(href.startsWith('/works/new?')).toBe(true);
        expect(href).toContain('mode=ai');
        expect(href).toContain('kind=website');
        expect(href).toContain('prompt=Landing+page+for+my+SaaS+launch');
    });

    describe('Phase 8 PR Y — template prefill', () => {
        it('renders initialPrompt verbatim in the prompt textarea', () => {
            const prefill = `Starter Business\n\nA blank-slate Mission for cats.`;
            const { container } = render(
                <NewPageClient initialType="mission" initialPrompt={prefill} />,
            );
            const textarea = getTextarea(container);
            expect(textarea.value).toBe(prefill);
        });

        it('Submit forwards initialTemplateId as missionTemplateRepo for mission chip', async () => {
            createMissionMock.mockClear();
            createMissionMock.mockResolvedValueOnce({ id: 'm-new', title: 'x' });
            const { container } = render(
                <NewPageClient
                    initialType="mission"
                    initialPrompt="Starter Business"
                    initialTemplateId="starter-business"
                />,
            );
            const textarea = getTextarea(container);
            fireEvent.change(textarea, {
                target: { value: 'Starter Business — long enough to enable Submit' },
            });
            fireEvent.click(getSubmit(container));
            await Promise.resolve();
            await Promise.resolve();
            expect(createMissionMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    description: 'Starter Business — long enough to enable Submit',
                    type: 'one-shot',
                    missionTemplateRepo: 'starter-business',
                }),
            );
        });

        it('Submit does NOT include missionTemplateRepo when no initialTemplateId', async () => {
            createMissionMock.mockClear();
            createMissionMock.mockResolvedValueOnce({ id: 'm-direct', title: 'x' });
            const { container } = render(<NewPageClient initialType="mission" />);
            fireEvent.change(getTextarea(container), {
                target: { value: 'No template, just a typed mission goal' },
            });
            fireEvent.click(getSubmit(container));
            await Promise.resolve();
            await Promise.resolve();
            const call = createMissionMock.mock.calls[0][0];
            expect(call.missionTemplateRepo).toBeUndefined();
        });
    });

    it('renders compact manual/import shortcuts instead of a second Work card chooser', () => {
        render(<NewPageClient />);
        expect(screen.queryByText('dashboard.newPage.cards.ai.title')).toBeNull();
        expect(screen.getByText('dashboard.newPage.cards.manual.title')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.import.title')).toBeTruthy();
    });
});
