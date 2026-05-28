import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const startFromPromptMock = vi.fn();
vi.mock('@/lib/hooks/use-start-from-prompt', () => ({
    useStartFromPrompt: () => startFromPromptMock,
}));

vi.mock('@/lib/hooks/use-chat-panel', () => ({
    useChatPanel: () => ({ open: false, setOpen: vi.fn() }),
}));

const createMissionMock = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    createMissionAction: (...args: unknown[]) => createMissionMock(...args),
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

describe('NewPageClient (chat-open + canvas-route on submit)', () => {
    it('renders all 10 live chips in the spec order: Mission, Idea, Agent, Task, Website, Landing Page, Blog, Directory, Awesome Repo, Company (with `works-store` disabled so the catalog matches its production state)', () => {
        // `store` is now flag-controlled via `works-store` like every
        // other kind. We pass `disabledKinds={['store']}` here to mirror
        // its current PostHog state (`active: false`), which keeps `store`
        // as the inert "Soon" span — i.e. the same 10 live chips this
        // test has always asserted. With every other flag fail-open, the
        // resulting button-option list is exactly the live chip order.
        const { container } = render(<NewPageClient disabledKinds={['store']} />);
        const chipButtons = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ) as HTMLButtonElement[];
        // EW-662 Phase 10 — `company` joined the live chip set so the
        // total is now 10. `store` renders as an inert "Soon" chip
        // (a `span[aria-disabled="true"]` — filtered out by the selector
        // above).
        expect(chipButtons).toHaveLength(10);
        const labels = chipButtons.map((b) => b.textContent?.trim());
        expect(labels).toEqual([
            'dashboard.newPage.chips.mission',
            'dashboard.newPage.chips.idea',
            'dashboard.newPage.chips.agent',
            'dashboard.newPage.chips.task',
            'dashboard.newPage.chips.website',
            'dashboard.newPage.chips.landing-page',
            'dashboard.newPage.chips.blog',
            'dashboard.newPage.chips.directory',
            'dashboard.newPage.chips.awesome-repo',
            'dashboard.newPage.chips.company',
        ]);
    });

    it('renders a chip as the inert "Soon" span when its kind is in disabledKinds', () => {
        // PromptChipsRow renders coming-soon chips as a <span
        // aria-disabled="true"> instead of a <button role="option"
        // aria-selected>. `disabledKinds={['blog']}` mirrors a
        // server-evaluated `works-blog` flag resolving to false.
        const { container } = render(<NewPageClient disabledKinds={['blog']} />);

        // Blog is no longer an interactive button…
        const blogButton = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ).find((b) => b.textContent?.includes('chips.blog'));
        expect(blogButton).toBeUndefined();

        // …it's the inert coming-soon span instead.
        const blogChip = container.querySelector('span[data-testid="new-chip-blog"]');
        expect(blogChip).not.toBeNull();
        expect(blogChip?.getAttribute('aria-disabled')).toBe('true');

        // A normally-live sibling (website) stays an interactive button.
        const websiteButton = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ).find((b) => b.textContent?.includes('chips.website'));
        expect(websiteButton).toBeTruthy();
    });

    it('keeps a chip live (interactive button) when disabledKinds is omitted', () => {
        const { container } = render(<NewPageClient />);
        const blogButton = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ).find((b) => b.textContent?.includes('chips.blog'));
        expect(blogButton).toBeTruthy();
        // And it's NOT rendered as the inert coming-soon span.
        const blogSpan = container.querySelector('span[data-testid="new-chip-blog"]');
        expect(blogSpan).toBeNull();
    });

    describe('store chip is flag-controlled like every other kind', () => {
        // store graduated from a hardcoded `comingSoon: true` baseline to
        // being driven by the `works-store` PostHog flag like every other
        // kind. With the flag resolving to `false` (its current PostHog
        // state) it renders as the inert "Soon" span — same as before, so
        // no user-facing change today. With the flag resolving to `true`
        // (hypothetical — the flag does not currently activate it) it
        // would render as a clickable button.
        it('renders store as the inert "Soon" span when `works-store` is disabled (current PostHog state)', () => {
            const { container } = render(<NewPageClient disabledKinds={['store']} />);
            const storeSpan = container.querySelector('span[data-testid="new-chip-store"]');
            expect(storeSpan).not.toBeNull();
            expect(storeSpan?.getAttribute('aria-disabled')).toBe('true');
            // And it's NOT a clickable button-option.
            const storeButton = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected]'),
            ).find((b) => b.textContent?.includes('Store'));
            expect(storeButton).toBeUndefined();
        });

        it('renders store as a clickable button when `works-store` is enabled (flag flipped on)', () => {
            // disabledKinds=[] mirrors every flag resolving to true (or
            // missing — fail-open). For store specifically this means the
            // hypothetical post-flip state where the flag is `active: true`.
            const { container } = render(<NewPageClient disabledKinds={[]} />);
            const storeSpan = container.querySelector('span[data-testid="new-chip-store"]');
            expect(storeSpan).toBeNull();
            const storeButton = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected]'),
            ).find((b) => b.textContent?.includes('Store'));
            expect(storeButton).toBeTruthy();
        });
    });

    it('pre-selects the chip from initialType prop', () => {
        const { container } = render(<NewPageClient initialType="mission" />);
        const mission = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ).find((b) => b.textContent?.includes('mission')) as HTMLButtonElement;
        expect(mission.getAttribute('aria-selected')).toBe('true');
    });

    it('defaults to Mission when no initialType is supplied', () => {
        const { container } = render(<NewPageClient />);
        const mission = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ).find((b) => b.textContent?.includes('mission')) as HTMLButtonElement;
        expect(mission.getAttribute('aria-selected')).toBe('true');
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

    it('Submit with chip=mission opens chat with intent and routes to /missions', () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="mission" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Build the best cat business' },
        });
        fireEvent.click(getSubmit(container));
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'Build the best cat business',
            expect.objectContaining({ intent: 'Mission' }),
        );
        expect(routerPushMock).toHaveBeenCalledWith('/missions');
    });

    it('Submit with chip=idea opens chat with intent and routes to /ideas', () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="idea" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'A curated list of AI coding agents' },
        });
        fireEvent.click(getSubmit(container));
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'A curated list of AI coding agents',
            expect.objectContaining({ intent: 'Idea' }),
        );
        expect(routerPushMock).toHaveBeenCalledWith('/ideas');
    });

    it('Submit with chip=agent opens chat with intent and routes to /agents/new (no prompt prefill)', () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="agent" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Research assistant for AI safety papers' },
        });
        fireEvent.click(getSubmit(container));
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'Research assistant for AI safety papers',
            expect.objectContaining({ intent: 'Agent' }),
        );
        // Canvas route — chat carries the prompt, no `?prompt=` here.
        expect(routerPushMock).toHaveBeenCalledWith('/agents/new');
    });

    it('Submit with chip=task opens chat with intent and routes to /tasks/new (no prompt prefill)', () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="task" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Audit the Mission backlog for stale items' },
        });
        fireEvent.click(getSubmit(container));
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'Audit the Mission backlog for stale items',
            expect.objectContaining({ intent: 'Task' }),
        );
        expect(routerPushMock).toHaveBeenCalledWith('/tasks/new');
    });

    it('Submit with chip=website routes to /works/new with mode+kind (no prompt prefill)', () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<NewPageClient initialType="website" />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'Landing page for my SaaS launch' },
        });
        fireEvent.click(getSubmit(container));
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'Landing page for my SaaS launch',
            expect.objectContaining({ intent: 'website' }),
        );
        expect(routerPushMock).toHaveBeenCalledTimes(1);
        const href = routerPushMock.mock.calls[0][0] as string;
        expect(href.startsWith('/works/new?')).toBe(true);
        expect(href).toContain('mode=ai');
        expect(href).toContain('kind=website');
        // Critically, the prompt is NOT in the URL — the chat carries it.
        expect(href).not.toContain('prompt=');
    });

    it('renders initialPrompt verbatim in the prompt textarea', () => {
        const prefill = `Starter Business\n\nA blank-slate Mission for cats.`;
        const { container } = render(
            <NewPageClient initialType="mission" initialPrompt={prefill} />,
        );
        const textarea = getTextarea(container);
        expect(textarea.value).toBe(prefill);
    });

    describe('disabled kinds cannot be selected or submitted', () => {
        it('does NOT select a kind that is both URL-preselected (initialType) and in disabledKinds; it never becomes the active selection or renders as a live chip', () => {
            // A disabled chip is rendered inert and must not be the
            // active selection — server-side sanitisation already drops a
            // disabled `?type=` handoff, and the client guard backstops it
            // by clearing any disabled selection to the safe default.
            const { container } = render(
                <NewPageClient initialType="blog" disabledKinds={['blog']} />,
            );

            // Blog is the inert "Soon" span — not an interactive option,
            // so it can never be aria-selected.
            const blogSpan = container.querySelector('span[data-testid="new-chip-blog"]');
            expect(blogSpan).not.toBeNull();
            expect(blogSpan?.getAttribute('aria-disabled')).toBe('true');

            // No interactive chip is selected as `blog`.
            const selectedBlog = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected="true"]'),
            ).find((b) => b.textContent?.includes('chips.blog'));
            expect(selectedBlog).toBeUndefined();

            // Selection falls back to the safe default (mission).
            const selectedMission = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected="true"]'),
            ).find((b) => b.textContent?.includes('chips.mission'));
            expect(selectedMission).toBeTruthy();
        });

        it('clears a previously-selected kind when it becomes disabled, falling back to the safe default', () => {
            // Start with `blog` live + selected…
            const { container, rerender } = render(<NewPageClient initialType="blog" />);
            const selectedBlog = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected="true"]'),
            ).find((b) => b.textContent?.includes('chips.blog'));
            expect(selectedBlog).toBeTruthy();

            // …then a flag flip disables `blog`. The reset effect must
            // move the active selection off `blog` so it can't be
            // submitted.
            act(() => {
                rerender(<NewPageClient initialType="blog" disabledKinds={['blog']} />);
            });

            const stillSelectedBlog = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected="true"]'),
            ).find((b) => b.textContent?.includes('chips.blog'));
            expect(stillSelectedBlog).toBeUndefined();

            const selectedMission = Array.from(
                container.querySelectorAll('button[role="option"][aria-selected="true"]'),
            ).find((b) => b.textContent?.includes('chips.mission'));
            expect(selectedMission).toBeTruthy();
        });
    });

    describe('Mission template path (initialTemplateId set)', () => {
        it('Submit with chip=mission + template inline-creates with missionTemplateRepo, opens chat WITHOUT a message, routes to the new Mission detail page', async () => {
            createMissionMock.mockClear();
            startFromPromptMock.mockClear();
            routerPushMock.mockClear();
            createMissionMock.mockResolvedValueOnce({ id: 'm-tpl-new', title: 'x' });
            const { container } = render(
                <NewPageClient
                    initialType="mission"
                    initialPrompt="Starter Business"
                    initialTemplateId="starter-business"
                />,
            );
            fireEvent.change(getTextarea(container), {
                target: { value: 'Starter Business — long enough to enable Submit' },
            });
            await act(async () => {
                fireEvent.click(getSubmit(container));
            });
            // The template path must persist the template id on the
            // new Mission — Greptile P1 on PR #1038 caught the
            // regression where this was silently dropped.
            await waitFor(() =>
                expect(createMissionMock).toHaveBeenCalledWith({
                    description: 'Starter Business — long enough to enable Submit',
                    type: 'one-shot',
                    missionTemplateRepo: 'starter-business',
                }),
            );
            // Codex P2: must NOT send the prompt into chat after the
            // inline create — the chat AI's `createMission` tool would
            // re-create the Mission as a second non-template row.
            expect(startFromPromptMock).not.toHaveBeenCalled();
            // Canvas is the new Mission's detail page.
            await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/missions/m-tpl-new'));
        });

        it('Submit with chip=mission WITHOUT a template falls through to the chat-only path (no inline create)', () => {
            createMissionMock.mockClear();
            startFromPromptMock.mockClear();
            routerPushMock.mockClear();
            const { container } = render(<NewPageClient initialType="mission" />);
            fireEvent.change(getTextarea(container), {
                target: { value: 'No template, just a typed mission goal' },
            });
            fireEvent.click(getSubmit(container));
            expect(createMissionMock).not.toHaveBeenCalled();
            expect(startFromPromptMock).toHaveBeenCalledWith(
                'No template, just a typed mission goal',
                expect.objectContaining({ intent: 'Mission' }),
            );
            expect(routerPushMock).toHaveBeenCalledWith('/missions');
        });
    });
});
