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
    listAssignableWorkAgentsAction: vi.fn(),
    assignAgentToWorkAction: vi.fn(),
}));

import { AssignWorkAgentDialog } from './AssignWorkAgentDialog';
import { assignAgentToWorkAction, listAssignableWorkAgentsAction } from '@/app/actions/agents';

const T = 'dashboard.workDetail.agentsDropdown';

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

describe('AssignWorkAgentDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listAssignableWorkAgentsAction).mockResolvedValue(CANDIDATES);
        vi.mocked(assignAgentToWorkAction).mockResolvedValue({ id: 'agent-1' } as never);
    });

    it('suggests the existing Agents that are not already on the Work', async () => {
        render(<AssignWorkAgentDialog workId="w1" open onOpenChange={vi.fn()} />);

        await waitFor(() => expect(screen.getByText('Release Manager')).toBeTruthy());
        expect(screen.getByText('SEO Writer')).toBeTruthy();
        expect(listAssignableWorkAgentsAction).toHaveBeenCalledWith('w1', '');
    });

    it('assigns the picked Agent, then closes and refreshes', async () => {
        const onOpenChange = vi.fn();
        render(<AssignWorkAgentDialog workId="w1" open onOpenChange={onOpenChange} />);

        await waitFor(() => expect(screen.getByText('Release Manager')).toBeTruthy());
        fireEvent.click(screen.getByText('Release Manager'));

        await waitFor(() => expect(assignAgentToWorkAction).toHaveBeenCalledWith('agent-1', 'w1'));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(routerRefreshMock).toHaveBeenCalled();
        expect(toastSuccess).toHaveBeenCalledWith(`${T}.assignedToast`);
    });

    it('surfaces a failed assign without closing the dialog', async () => {
        vi.mocked(assignAgentToWorkAction).mockRejectedValue(new Error('nope'));
        const onOpenChange = vi.fn();
        render(<AssignWorkAgentDialog workId="w1" open onOpenChange={onOpenChange} />);

        await waitFor(() => expect(screen.getByText('SEO Writer')).toBeTruthy());
        fireEvent.click(screen.getByText('SEO Writer'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('empty state distinguishes "nothing left to assign" from "no search matches"', async () => {
        vi.mocked(listAssignableWorkAgentsAction).mockResolvedValue([]);
        render(<AssignWorkAgentDialog workId="w1" open onOpenChange={vi.fn()} />);

        await waitFor(() => expect(screen.getByText(`${T}.assignNoneAvailable`)).toBeTruthy());

        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
        await waitFor(() => expect(screen.getByText(`${T}.assignNoMatches`)).toBeTruthy());
        await waitFor(() =>
            expect(listAssignableWorkAgentsAction).toHaveBeenLastCalledWith('w1', 'zzz'),
        );
    });
});
