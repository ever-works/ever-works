import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
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

const createIdeaMock = vi.fn();
const buildIdeaMock = vi.fn();
const dismissProposalMock = vi.fn();
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    createIdeaAction: (...args: unknown[]) => createIdeaMock(...args),
    buildIdeaAction: (...args: unknown[]) => buildIdeaMock(...args),
    dismissProposalAction: (...args: unknown[]) => dismissProposalMock(...args),
}));

import { IdeasPageClient, ACTIONABLE_STATUSES } from './IdeasPageClient';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';

function mkIdea(
    overrides: Partial<WorkProposal> & { id: string; status: WorkProposalStatus },
): WorkProposal {
    const { id, status, ...rest } = overrides;
    return {
        id,
        userId: 'u1',
        title: `Idea ${id}`,
        description: 'Some description that is longer than the 10-char minimum',
        slugSuggestion: id,
        suggestedCategories: [],
        suggestedFields: [],
        recommendedPlugins: [],
        generatedPrompt: 'p',
        reasoning: '',
        source: 'auto-signup',
        status,
        generatedAt: '2026-05-24T00:00:00Z',
        ...rest,
    } as unknown as WorkProposal;
}

describe('IdeasPageClient (Phase 5 PR N)', () => {
    it('renders the server-provided Ideas without hiding terminal statuses locally', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'a', status: 'pending' }),
            mkIdea({ id: 'b', status: 'accepted' }),
            mkIdea({ id: 'c', status: 'dismissed' }),
        ];
        render(<IdeasPageClient initialIdeas={ideas} />);
        expect(screen.getByText('Idea a')).toBeTruthy();
        expect(screen.getByText('Idea b')).toBeTruthy();
        expect(screen.getByText('Idea c')).toBeTruthy();
    });

    it('renders URL-backed search and status filters', () => {
        const { container } = render(
            <IdeasPageClient
                initialIdeas={[]}
                filters={{ status: 'failed', search: 'benchmarks' }}
            />,
        );
        const search = container.querySelector('input[name="search"]') as HTMLInputElement;
        // Status is carried by a hidden input synced to the custom <Select>
        // (a styled button + portal list, not a native <select>).
        const status = container.querySelector('input[name="status"]') as HTMLInputElement;
        expect(search.value).toBe('benchmarks');
        expect(status.value).toBe('failed');

        // Options ('Actionable', the 'done' filter) live in a portal that is
        // only mounted once the trigger opens the dropdown.
        const trigger = container.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement;
        fireEvent.click(trigger);
        expect(screen.getByText('Actionable')).toBeTruthy();
        expect(screen.getByText('filters.done')).toBeTruthy();
    });

    it('quick-add submit disabled until description >= 10 chars', () => {
        const { container } = render(<IdeasPageClient initialIdeas={[]} />);
        const textarea = container.querySelector(
            'textarea[data-testid="ideas-quick-add"]',
        ) as HTMLTextAreaElement;
        const addBtn = container.querySelector(
            'button[data-testid="ideas-quick-add-submit"]',
        ) as HTMLButtonElement;
        expect(addBtn).toBeTruthy();
        expect(addBtn.disabled).toBe(true);
        fireEvent.change(textarea, { target: { value: 'too short' } });
        expect(addBtn.disabled).toBe(true);
        fireEvent.change(textarea, { target: { value: 'A long enough idea description' } });
        expect(addBtn.disabled).toBe(false);
    });

    it('quick-add hands the prompt to the chat AI (no inline create)', () => {
        startFromPromptMock.mockClear();
        createIdeaMock.mockClear();
        const { container } = render(
            <IdeasPageClient initialIdeas={[mkIdea({ id: 'old', status: 'pending' })]} />,
        );
        const textarea = container.querySelector(
            'textarea[data-testid="ideas-quick-add"]',
        ) as HTMLTextAreaElement;
        fireEvent.change(textarea, {
            target: { value: 'My freshly typed Idea, longer than ten chars' },
        });
        const addBtn = container.querySelector(
            'button[data-testid="ideas-quick-add-submit"]',
        ) as HTMLButtonElement;
        fireEvent.click(addBtn);
        expect(startFromPromptMock).toHaveBeenCalledWith(
            'My freshly typed Idea, longer than ten chars',
            expect.objectContaining({ intent: 'Idea' }),
        );
        expect(createIdeaMock).not.toHaveBeenCalled();
        expect(screen.getByText('Idea old')).toBeTruthy();
    });

    it('renders a load error instead of masking it as an empty state', () => {
        render(<IdeasPageClient initialIdeas={[]} loadError="API unavailable" />);
        expect(screen.getByRole('alert').textContent).toContain('Could not load Ideas.');
        expect(screen.getByRole('alert').textContent).toContain('API unavailable');
        expect(screen.queryByText('empty.title')).toBeNull();
    });

    it('renders pagination links when the server page has adjacent pages', () => {
        render(
            <IdeasPageClient
                initialIdeas={[mkIdea({ id: 'a', status: 'pending' })]}
                pagination={{
                    offset: 24,
                    hasPrevious: true,
                    hasNext: true,
                    previousHref: '/ideas?offset=0',
                    nextHref: '/ideas?offset=48',
                }}
            />,
        );
        const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
        expect(screen.getByText('Showing 25-25')).toBeTruthy();
        expect(links).toContain('/ideas?offset=0');
        expect(links).toContain('/ideas?offset=48');
    });

    it('gears menu deep-links to the Phase 4 settings anchors', () => {
        render(<IdeasPageClient initialIdeas={[]} />);
        fireEvent.click(screen.getByLabelText('gears.menuLabel'));
        const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
        for (const expected of [
            '/settings/work-agent#auto-generate-ideas',
            '/settings/work-agent#auto-build-works',
            '/settings/work-agent#auto-retry',
            '/settings/work-agent#account-budgets',
        ]) {
            expect(links).toContain(expected);
        }
    });

    it('exposes ACTIONABLE_STATUSES = [pending, queued, building, failed]', () => {
        expect(ACTIONABLE_STATUSES).toEqual(['pending', 'queued', 'building', 'failed']);
    });

    it('renders an empty state when the server page has no Ideas', () => {
        render(<IdeasPageClient initialIdeas={[]} />);
        expect(screen.getByText('empty.title')).toBeTruthy();
        expect(screen.getByText('empty.subtitle')).toBeTruthy();
    });
});
