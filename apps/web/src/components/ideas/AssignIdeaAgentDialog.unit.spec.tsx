import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

const routerRefreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: routerRefreshMock }),
    // The shared Button primitive reads `Link` at module scope.
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock('@/app/actions/agents', () => ({
    listAssignableIdeaAgentsAction: vi.fn(),
    assignAgentToIdeaAction: vi.fn(),
}));

import { AssignIdeaAgentDialog } from './AssignIdeaAgentDialog';
import { assignAgentToIdeaAction, listAssignableIdeaAgentsAction } from '@/app/actions/agents';

const T = 'dashboard.ideasPage.detail.agents';

const CANDIDATES = [
    {
        id: 'agent-1',
        name: 'Release Manager',
        slug: 'release-manager',
        title: 'Ships',
        status: 'active' as const,
    },
    {
        id: 'agent-2',
        name: 'SEO Writer',
        slug: 'seo-writer',
        title: null,
        status: 'draft' as const,
    },
];

describe('AssignIdeaAgentDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listAssignableIdeaAgentsAction).mockResolvedValue(CANDIDATES);
        vi.mocked(assignAgentToIdeaAction).mockResolvedValue({ id: 'agent-1' } as never);
    });

    it('suggests the existing Agents that are not already on the Idea', async () => {
        render(<AssignIdeaAgentDialog ideaId="i1" open onOpenChange={vi.fn()} />);

        await waitFor(() => expect(screen.getByText('Release Manager')).toBeTruthy());
        expect(screen.getByText('SEO Writer')).toBeTruthy();
        expect(listAssignableIdeaAgentsAction).toHaveBeenCalledWith('i1', '');
    });

    it('assigns the picked Agent, then closes and refreshes', async () => {
        const onOpenChange = vi.fn();
        render(<AssignIdeaAgentDialog ideaId="i1" open onOpenChange={onOpenChange} />);

        await waitFor(() => expect(screen.getByText('Release Manager')).toBeTruthy());
        fireEvent.click(screen.getByText('Release Manager'));

        await waitFor(() => expect(assignAgentToIdeaAction).toHaveBeenCalledWith('agent-1', 'i1'));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(routerRefreshMock).toHaveBeenCalled();
        expect(toastSuccess).toHaveBeenCalledWith(`${T}.assignedToast`);
    });

    it('surfaces a failed assign without closing the dialog', async () => {
        vi.mocked(assignAgentToIdeaAction).mockRejectedValue(new Error('nope'));
        const onOpenChange = vi.fn();
        render(<AssignIdeaAgentDialog ideaId="i1" open onOpenChange={onOpenChange} />);

        await waitFor(() => expect(screen.getByText('SEO Writer')).toBeTruthy());
        fireEvent.click(screen.getByText('SEO Writer'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('empty state distinguishes "nothing left to assign" from "no search matches"', async () => {
        vi.mocked(listAssignableIdeaAgentsAction).mockResolvedValue([]);
        render(<AssignIdeaAgentDialog ideaId="i1" open onOpenChange={vi.fn()} />);

        await waitFor(() => expect(screen.getByText(`${T}.assignNoneAvailable`)).toBeTruthy());

        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
        await waitFor(() => expect(screen.getByText(`${T}.assignNoMatches`)).toBeTruthy());
        await waitFor(() =>
            expect(listAssignableIdeaAgentsAction).toHaveBeenLastCalledWith('i1', 'zzz'),
        );
    });
});
