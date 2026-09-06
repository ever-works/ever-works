import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Work } from '@/lib/api/types-only';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
// `Button` pulls in the locale-aware Link, which resolves `next/navigation`
// through next-intl — unavailable under jsdom.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/app/actions/dashboard', () => ({
    deleteWork: vi.fn(),
}));
// Only owners see the danger zone at all. The gate under test is the
// kind's, not the role's, so the permission is granted up front.
vi.mock('../WorkDetailContext', () => ({
    useWorkPermissions: () => ({ canDelete: true }),
}));

import { DeleteComponent } from './DeleteComponent';
import { deleteWork } from '@/app/actions/dashboard';

const REPOSITORY_CHECKBOXES = [
    'deleteDataRepository',
    'deleteMarkdownRepository',
    'deleteWebsiteRepository',
];

function makeWork(kind: string): Work {
    return { id: 'w1', name: 'Platform', kind } as unknown as Work;
}

async function openDeleteDialog() {
    fireEvent.click(screen.getByText('deleteButton'));
    // The name-confirmation block renders for every kind, so it is the
    // signal that the dialog has mounted.
    await screen.findByText('confirmWorkName');
}

describe('DeleteComponent — repository options per Work kind', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(deleteWork).mockResolvedValue({ success: true } as never);
    });

    it('offers every repository checkbox for a default (generated) Work', async () => {
        render(<DeleteComponent work={makeWork('default')} />);
        await openDeleteDialog();

        expect(screen.getByText('deleteOptions')).toBeInTheDocument();
        for (const label of REPOSITORY_CHECKBOXES) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    // Self-build slice D (EW-766): a Repository Work's "data repository" IS
    // the user's own code repository and the API refuses to delete it, so
    // the dialog must not even suggest it — nor the work/website roles the
    // kind never provisions.
    it('offers no repository checkbox at all for a Repository Work', async () => {
        render(<DeleteComponent work={makeWork('repo')} />);
        await openDeleteDialog();

        expect(screen.queryByText('deleteOptions')).not.toBeInTheDocument();
        for (const label of REPOSITORY_CHECKBOXES) {
            expect(screen.queryByText(label)).not.toBeInTheDocument();
        }
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('deletes a Repository Work without asking the API to delete any repository', async () => {
        render(<DeleteComponent work={makeWork('repo')} />);
        await openDeleteDialog();

        fireEvent.change(screen.getByPlaceholderText('Platform'), {
            target: { value: 'Platform' },
        });
        fireEvent.click(screen.getByText('deleteConfirmButton'));

        await waitFor(() =>
            expect(deleteWork).toHaveBeenCalledWith('w1', {
                delete_data_repository: false,
                delete_markdown_repository: false,
                delete_website_repository: false,
            }),
        );
    });
});
