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

function mkIdea(overrides: Partial<WorkProposal> & { id: string; status: WorkProposalStatus }): WorkProposal {
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
    it('hides ACCEPTED + DISMISSED Ideas by default', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'a', status: 'pending' }),
            mkIdea({ id: 'b', status: 'accepted' }),
            mkIdea({ id: 'c', status: 'dismissed' }),
        ];
        render(<IdeasPageClient initialIdeas={ideas} />);
        expect(screen.getByText('Idea a')).toBeTruthy();
        expect(screen.queryByText('Idea b')).toBeNull();
        expect(screen.queryByText('Idea c')).toBeNull();
    });

    it('shows ACCEPTED rows when "Show accepted" toggle is ticked', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'a', status: 'pending' }),
            mkIdea({ id: 'b', status: 'accepted' }),
        ];
        render(<IdeasPageClient initialIdeas={ideas} />);
        // getByText('toggles.showAccepted') returns the <label> itself
        // (the label has the text node as a direct child). The input
        // checkbox is also a direct child of that label, so query
        // INSIDE the label, not in its parent (the parent contains
        // both toggles' inputs and would match the wrong one).
        const label = screen.getByText('toggles.showAccepted').closest('label');
        const checkbox = label?.querySelector('input[type="checkbox"]');
        if (!checkbox) throw new Error('toggle checkbox missing');
        fireEvent.click(checkbox);
        expect(screen.getByText('Idea b')).toBeTruthy();
    });

    it('shows DISMISSED rows when "Show dismissed" toggle is ticked', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'a', status: 'pending' }),
            mkIdea({ id: 'c', status: 'dismissed' }),
        ];
        render(<IdeasPageClient initialIdeas={ideas} />);
        const label = screen.getByText('toggles.showDismissed').closest('label');
        const checkbox = label?.querySelector('input[type="checkbox"]');
        if (!checkbox) throw new Error('toggle checkbox missing');
        fireEvent.click(checkbox);
        expect(screen.getByText('Idea c')).toBeTruthy();
    });

    it('renders one filter chip per status + an "all" chip, showing counts from the full set', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'p1', status: 'pending' }),
            mkIdea({ id: 'p2', status: 'pending' }),
            mkIdea({ id: 'q1', status: 'queued' }),
            mkIdea({ id: 'b1', status: 'building' }),
            mkIdea({ id: 'a1', status: 'accepted' }),
        ];
        const { container } = render(<IdeasPageClient initialIdeas={ideas} />);
        // 7 chips total ('all' + 6 statuses).
        expect(container.querySelectorAll('button.rounded-full')).toHaveLength(7);
        // 'all' badge shows total count (5), pending shows (2).
        expect(screen.getByText('filters.all').parentElement?.textContent).toMatch(/5/);
        expect(screen.getByText('filters.pending').parentElement?.textContent).toMatch(/2/);
    });

    it('filter chip narrows the list to a single status', () => {
        const ideas: WorkProposal[] = [
            mkIdea({ id: 'p1', status: 'pending' }),
            mkIdea({ id: 'b1', status: 'building' }),
        ];
        render(<IdeasPageClient initialIdeas={ideas} />);
        fireEvent.click(screen.getByText('filters.building'));
        expect(screen.getByText('Idea b1')).toBeTruthy();
        expect(screen.queryByText('Idea p1')).toBeNull();
    });

    it('quick-add disabled until description >= 10 chars', () => {
        render(<IdeasPageClient initialIdeas={[]} />);
        const addBtn = screen.getByText('quickAdd.submit').closest('button')!;
        expect(addBtn.disabled).toBe(true);
        const textarea = screen.getByPlaceholderText('quickAdd.placeholder');
        fireEvent.change(textarea, { target: { value: 'too short' } });
        expect(addBtn.disabled).toBe(true);
        fireEvent.change(textarea, { target: { value: 'A long enough idea description' } });
        expect(addBtn.disabled).toBe(false);
    });

    it('quick-add calls createIdeaAction + prepends the new Idea on success', async () => {
        createIdeaMock.mockClear();
        const newIdea = mkIdea({ id: 'new-1', status: 'pending' });
        createIdeaMock.mockResolvedValueOnce(newIdea);
        render(<IdeasPageClient initialIdeas={[mkIdea({ id: 'old', status: 'pending' })]} />);
        const textarea = screen.getByPlaceholderText('quickAdd.placeholder');
        fireEvent.change(textarea, {
            target: { value: 'My freshly typed Idea, longer than ten chars' },
        });
        fireEvent.click(screen.getByText('quickAdd.submit'));
        expect(createIdeaMock).toHaveBeenCalledWith({
            description: 'My freshly typed Idea, longer than ten chars',
        });
        // useTransition schedules the setState async; findByText auto-
        // waits for the next render that contains the new card.
        expect(await screen.findByText('Idea new-1')).toBeTruthy();
        expect(screen.getByText('Idea old')).toBeTruthy();
    });

    it('exposes ACTIONABLE_STATUSES = [pending, queued, building, failed]', () => {
        // Lock the contract so a future tick can't silently shift
        // what "actionable" means without updating this spec.
        expect(ACTIONABLE_STATUSES).toEqual(['pending', 'queued', 'building', 'failed']);
    });

    it('renders an empty state when no Ideas match the current filters', () => {
        render(
            <IdeasPageClient
                initialIdeas={[mkIdea({ id: 'a', status: 'accepted' })]}
            />,
        );
        // ACCEPTED hidden by default → empty state.
        expect(screen.getByText('empty.title')).toBeTruthy();
        expect(screen.getByText('empty.subtitle')).toBeTruthy();
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
});
