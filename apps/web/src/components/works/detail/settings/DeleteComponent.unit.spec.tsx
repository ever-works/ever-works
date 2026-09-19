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
    // APW-01 T39 — the App Work deploy target (APW-06's route, `404` today).
    getAppDeleteTarget: vi.fn(),
}));
// Only owners see the danger zone at all. The gate under test is the
// kind's, not the role's, so the permission is granted up front.
vi.mock('../WorkDetailContext', () => ({
    useWorkPermissions: () => ({ canDelete: true }),
}));

import { DeleteComponent } from './DeleteComponent';
import { deleteWork, getAppDeleteTarget } from '@/app/actions/dashboard';

const REPOSITORY_CHECKBOXES = [
    'deleteDataRepository',
    'deleteMarkdownRepository',
    'deleteWebsiteRepository',
];

/** APW-01 T39 — the App Work's own labels, which replace the three above. */
const APP_CHECKBOXES = ['deleteAppStoredData', 'deleteAppFork'];

function makeWork(kind: string): Work {
    return { id: 'w1', name: 'Platform', kind } as unknown as Work;
}

/**
 * An App Work as the API answers it: the Work Repository is recorded under the
 * `website` role ONLY, and `createdByThisWork` says whether THIS Work asked for the
 * fork (`AppWorkCreateService.buildWorkData`, `:1175-1191`).
 */
function makeAppWork(
    overrides: {
        relation?: 'fork' | 'private-copy' | 'link';
        createdByThisWork?: boolean;
    } = {},
): Work {
    const relation = overrides.relation ?? 'fork';
    const createdByThisWork = overrides.createdByThisWork ?? relation !== 'link';
    return {
        id: 'w-app',
        name: 'Cal.diy',
        slug: 'cal-diy',
        kind: 'app',
        owner: 'apw-e2e-user',
        sourceRepository: {
            type:
                relation === 'link'
                    ? 'app_link'
                    : relation === 'private-copy'
                      ? 'app_private_copy'
                      : 'app_fork',
            owner: 'apw-e2e-user',
            repo: 'cal-diy',
            relatedRepositories: { website: { owner: 'apw-e2e-user', repo: 'cal-diy' } },
            createdByThisWork,
        },
    } as unknown as Work;
}

/** The dialog's own delete button, after the Work-name confirmation is typed. */
function confirmWorkName(name: string): void {
    fireEvent.change(screen.getByPlaceholderText(name), { target: { value: name } });
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
        // APW-01 T39: APW-06's `GET /api/works/:id/app-target` is not mounted, and
        // `getAppDeleteTarget` reports that `404` as `none`.
        vi.mocked(getAppDeleteTarget).mockResolvedValue({ success: true, target: 'none' });
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

/**
 * APW-01 T39 — the App Work dialog (plan §5.2 `:747-750`, ACC-NEG-07).
 *
 * The two boxes the acceptance case names, unticked by default, and the rule that
 * neither field is sent until its own typed confirmation matches.
 */
describe('DeleteComponent — an App Work (APW-01 T39)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(deleteWork).mockResolvedValue({ success: true } as never);
        vi.mocked(getAppDeleteTarget).mockResolvedValue({ success: true, target: 'your-cluster' });
    });

    /** Open the dialog and wait for the app-target read to settle. */
    async function openAppDialog(work: Work): Promise<void> {
        render(<DeleteComponent work={work} />);
        await openDeleteDialog();
        await waitFor(() => expect(getAppDeleteTarget).toHaveBeenCalledWith('w-app'));
    }

    it('offers **Also delete stored data** and the fork box, and no generated-repository box', async () => {
        await openAppDialog(makeAppWork());

        await screen.findByText('deleteAppStoredData');
        for (const label of APP_CHECKBOXES) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
        for (const label of REPOSITORY_CHECKBOXES) {
            expect(screen.queryByText(label)).not.toBeInTheDocument();
        }
    });

    it('hides the stored-data box when the deploy target is none', async () => {
        vi.mocked(getAppDeleteTarget).mockResolvedValue({ success: true, target: 'none' });

        await openAppDialog(makeAppWork());

        await waitFor(() =>
            expect(screen.queryByText('deleteAppStoredData')).not.toBeInTheDocument(),
        );
    });

    it('hides the stored-data box when GET app-target answers 404 (APW-06 not merged)', async () => {
        // The action reports the `404` as `none`; the dialog must not offer a
        // stored-data choice for a Work that deploys nowhere.
        vi.mocked(getAppDeleteTarget).mockResolvedValue({ success: true, target: 'none' });

        await openAppDialog(makeAppWork({ relation: 'link', createdByThisWork: false }));

        await waitFor(() =>
            expect(screen.queryByText('deleteAppStoredData')).not.toBeInTheDocument(),
        );
        // ... and the link itself is announced as never deleted, with no box for it.
        expect(screen.getByText('deleteAppLinkNote')).toBeInTheDocument();
        expect(screen.queryByText('deleteAppFork')).not.toBeInTheDocument();
    });

    it('shows no fork box for a repository this Work did not create', async () => {
        await openAppDialog(makeAppWork({ relation: 'fork', createdByThisWork: false }));

        await screen.findByText('deleteAppRepositoryNotOurs');
        expect(screen.queryByText('deleteAppFork')).not.toBeInTheDocument();
        expect(screen.queryByText('deleteAppPrivateCopy')).not.toBeInTheDocument();
    });

    it('labels a private copy as a private copy', async () => {
        await openAppDialog(makeAppWork({ relation: 'private-copy' }));

        await screen.findByText('deleteAppPrivateCopy');
        expect(screen.queryByText('deleteAppFork')).not.toBeInTheDocument();
    });

    it('sends delete_stored_data + confirm_slug only once the typed slug matches, and never delete_data_repository', async () => {
        await openAppDialog(makeAppWork());
        await screen.findByText('deleteAppStoredData');

        // Tick the box, type the wrong slug, confirm the Work name, delete.
        fireEvent.click(screen.getByText('deleteAppStoredData'));
        fireEvent.change(screen.getByPlaceholderText('cal-diy'), {
            target: { value: 'not-the-slug' },
        });
        confirmWorkName('Cal.diy');
        fireEvent.click(screen.getByText('deleteConfirmButton'));

        await waitFor(() => expect(deleteWork).toHaveBeenCalledTimes(1));
        expect(deleteWork).toHaveBeenLastCalledWith('w-app', {});
        expect(vi.mocked(deleteWork).mock.calls[0][1]).not.toHaveProperty('delete_data_repository');

        // Now type it exactly: both fields go, and still no repository flag.
        fireEvent.change(screen.getByPlaceholderText('cal-diy'), {
            target: { value: 'cal-diy' },
        });
        fireEvent.click(screen.getByText('deleteConfirmButton'));

        await waitFor(() =>
            expect(deleteWork).toHaveBeenLastCalledWith('w-app', {
                delete_stored_data: true,
                confirm_slug: 'cal-diy',
            }),
        );
    });

    it('sends delete_data_repository only once the fork box is ticked and the full name typed', async () => {
        await openAppDialog(makeAppWork());
        await screen.findByText('deleteAppFork');

        fireEvent.click(screen.getByText('deleteAppFork'));
        fireEvent.change(screen.getByPlaceholderText('apw-e2e-user/cal-diy'), {
            target: { value: 'apw-e2e-user/cal-diy' },
        });
        confirmWorkName('Cal.diy');
        fireEvent.click(screen.getByText('deleteConfirmButton'));

        await waitFor(() =>
            expect(deleteWork).toHaveBeenLastCalledWith('w-app', {
                delete_data_repository: true,
            }),
        );
    });

    it('sends nothing at all when both boxes are left unticked (the default)', async () => {
        await openAppDialog(makeAppWork());
        await screen.findByText('deleteAppStoredData');

        confirmWorkName('Cal.diy');
        fireEvent.click(screen.getByText('deleteConfirmButton'));

        await waitFor(() => expect(deleteWork).toHaveBeenCalledWith('w-app', {}));
    });
});
