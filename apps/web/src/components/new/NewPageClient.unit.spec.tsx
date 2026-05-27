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
    it('renders all 9 chips in the spec order: Mission, Idea, Agent, Task, Website, Landing Page, Blog, Directory, Awesome Repo', () => {
        const { container } = render(<NewPageClient />);
        const chipButtons = Array.from(
            container.querySelectorAll('button[role="option"][aria-selected]'),
        ) as HTMLButtonElement[];
        expect(chipButtons).toHaveLength(9);
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
        ]);
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
