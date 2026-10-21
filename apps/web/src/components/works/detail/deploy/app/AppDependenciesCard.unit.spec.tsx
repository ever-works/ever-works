import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type {
    AppDependenciesListResponse,
    AppDependencyEntry,
} from '@/lib/api/app-dependencies.types';

/**
 * Lane aw-deps-api (APW-07 T25) — the Deploy tab's **Dependencies** card and its delete-data dialog,
 * rendered with the REAL English catalogue; the three server actions are mocked at their module
 * boundary.
 */

const { listMock, retryMock, deleteMock, toastSuccess, toastError } = vi.hoisted(() => ({
    listMock: vi.fn(),
    retryMock: vi.fn(),
    deleteMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-dependencies', () => ({
    getAppDependenciesAction: listMock,
    retryAppDependencyAction: retryMock,
    deleteAppDependencyDataAction: deleteMock,
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
// The UI kit reaches `next-intl`'s navigation, which needs the Next runtime; nothing here navigates.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppDependenciesCard } from './AppDependenciesCard';

const WORK = { id: '5a07fa3f-367a-444e-9d1e-311d03cc1327', slug: 'hello-app' };

function dep(over: Partial<AppDependencyEntry>): AppDependencyEntry {
    return {
        kind: 'postgres',
        declared: true,
        provider: {
            pluginId: 'k8s',
            providerId: 'k8s-inline-postgres',
            label: 'In-cluster Postgres',
        },
        availableProviders: [],
        status: 'ready',
        statusReason: null,
        statusDetail: null,
        awaitingConfig: false,
        actualVersion: '16',
        sizeGiB: 10,
        backup: { policy: 'none', state: 'none', lastBackupAt: null, checkedAt: null },
        inSpec: true,
        keptResources: null,
        outputs: [],
        lastProvisionedAt: null,
        lastCheckedAt: null,
        label: 'In-cluster Postgres',
        names: ['dep-postgres'],
        attempts: 0,
        ...over,
    };
}

function list(
    dependencies: AppDependencyEntry[],
    over: Partial<AppDependenciesListResponse> = {},
): AppDependenciesListResponse {
    return {
        workId: WORK.id,
        deployTarget: 'your-cluster',
        dependencies,
        refreshing: false,
        canEdit: true,
        ...over,
    };
}

const FAILED_PG = dep({
    status: 'failed',
    statusReason: 'clusterUnreachable',
    statusDetail: { error: 'TypeError' },
    attempts: 3,
});
const FAILED_SMTP = dep({
    kind: 'smtp',
    provider: { pluginId: 'k8s', providerId: 'k8s-inline-mailpit', label: 'Mail sink' },
    label: 'Mail sink',
    sizeGiB: null,
    status: 'failed',
    statusReason: 'smtpAuthRefused',
    attempts: 1,
    names: [],
});

function renderCard(initial: AppDependenciesListResponse | null) {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppDependenciesCard work={WORK} initial={initial} />
        </NextIntlClientProvider>,
    );
}

function row(kind: string): HTMLElement {
    const found = screen
        .getAllByTestId('app-dependency-row')
        .find((element) => element.dataset.kind === kind);
    if (!found) throw new Error(`no row ${kind}`);
    return found;
}

describe('AppDependenciesCard', () => {
    beforeEach(() => {
        listMock.mockReset();
        retryMock.mockReset();
        deleteMock.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
        listMock.mockResolvedValue({ success: true, data: list([FAILED_PG, FAILED_SMTP]) });
    });
    afterEach(() => cleanup());

    it('shows each dependency with its status, reason and attempts', () => {
        renderCard(list([FAILED_PG, FAILED_SMTP]));

        const pg = within(row('postgres'));
        expect(pg.getByText('Postgres')).toBeTruthy();
        expect(pg.getByTestId('app-dependency-status').textContent).toBe('Failed');
        expect(pg.getByTestId('app-dependency-reason').textContent).toBe(
            "Couldn't reach your cluster.",
        );
        expect(pg.getByTestId('app-dependency-meta').textContent).toBe(
            'Provider: In-cluster Postgres · 10 GiB · 3 attempts',
        );
        // A transient failure says Deploy retries it; a definite one does not.
        expect(pg.getByTestId('app-dependency-deploy-hint')).toBeTruthy();
        expect(within(row('smtp')).queryByTestId('app-dependency-deploy-hint')).toBeNull();
        expect(within(row('smtp')).getByTestId('app-dependency-reason').textContent).toBe(
            'Sign-in was refused by the server.',
        );
    });

    it('offers Retry and Delete data to an editor only', () => {
        renderCard(list([FAILED_PG]));
        expect(within(row('postgres')).getByTestId('app-dependency-retry')).toBeTruthy();
        expect(within(row('postgres')).getByTestId('app-dependency-delete-open')).toBeTruthy();
        cleanup();

        renderCard(list([FAILED_PG], { canEdit: false }));
        expect(screen.queryByTestId('app-dependency-retry')).toBeNull();
        expect(screen.queryByTestId('app-dependency-delete-open')).toBeNull();
    });

    it('has no Retry on a healthy dependency', () => {
        renderCard(list([dep({ status: 'ready' })]));
        expect(screen.queryByTestId('app-dependency-retry')).toBeNull();
        expect(screen.getByTestId('app-dependency-delete-open')).toBeTruthy();
    });

    it('retries through the server action and re-reads the cards', async () => {
        retryMock.mockResolvedValue({
            success: true,
            data: { status: 'accepted', dispatched: true, dependency: null },
        });
        listMock.mockResolvedValue({
            success: true,
            data: list([dep({ status: 'pending', attempts: 0 })]),
        });
        renderCard(list([FAILED_PG]));

        fireEvent.click(within(row('postgres')).getByTestId('app-dependency-retry'));

        await waitFor(() => expect(retryMock).toHaveBeenCalledWith(WORK.id, 'postgres'));
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith('Postgres: a new attempt is scheduled.'),
        );
        await waitFor(() =>
            expect(screen.getByTestId('app-dependency-status').textContent).toBe('Pending'),
        );
    });

    it('says so when a worker holds the dependency (409 leaseHeld)', async () => {
        retryMock.mockResolvedValue({ success: false, code: 'leaseHeld', httpStatus: 409 });
        renderCard(list([FAILED_PG]));

        fireEvent.click(within(row('postgres')).getByTestId('app-dependency-retry'));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(
                'Postgres is being provisioned right now. Try again in a moment.',
            ),
        );
    });

    it('keeps Delete data disabled until the App Work slug is typed', async () => {
        deleteMock.mockResolvedValue({ success: true, data: { dependency: null } });
        renderCard(list([dep({ status: 'ready' })]));

        fireEvent.click(screen.getByTestId('app-dependency-delete-open'));
        const dialog = within(screen.getByTestId('app-dependency-delete-dialog'));
        expect(dialog.getByText('dep-postgres')).toBeTruthy();

        const confirm = dialog.getByTestId('app-dependency-delete-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        fireEvent.change(dialog.getByTestId('app-dependency-delete-slug'), {
            target: { value: 'hello' },
        });
        expect(confirm.disabled).toBe(true);

        fireEvent.change(dialog.getByTestId('app-dependency-delete-slug'), {
            target: { value: 'hello-app' },
        });
        expect(confirm.disabled).toBe(false);

        fireEvent.click(confirm);
        await waitFor(() =>
            expect(deleteMock).toHaveBeenCalledWith(WORK.id, 'postgres', 'hello-app'),
        );
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith('Deleting the Postgres data.'),
        );
    });

    it('shows the API refusal inside the dialog', async () => {
        deleteMock.mockResolvedValue({
            success: false,
            code: 'confirmationMismatch',
            httpStatus: 422,
        });
        renderCard(list([dep({ status: 'ready' })]));

        fireEvent.click(screen.getByTestId('app-dependency-delete-open'));
        const dialog = within(screen.getByTestId('app-dependency-delete-dialog'));
        fireEvent.change(dialog.getByTestId('app-dependency-delete-slug'), {
            target: { value: 'hello-app' },
        });
        fireEvent.click(dialog.getByTestId('app-dependency-delete-confirm'));

        await waitFor(() =>
            expect(dialog.getByTestId('app-dependency-delete-message').textContent).toBe(
                "The name you typed doesn't match.",
            ),
        );
    });

    it('reads the cards itself when the server did not, and says when the route is missing', async () => {
        listMock.mockResolvedValue({ success: false, code: 'route_unavailable', httpStatus: 404 });
        renderCard(null);

        await waitFor(() =>
            expect(screen.getByTestId('app-dependencies-card').textContent).toBe(
                "Dependencies can't be managed on this instance yet.",
            ),
        );
    });

    it('says so when the App spec declares nothing', () => {
        renderCard(list([]));
        expect(screen.getByTestId('app-dependencies-empty').textContent).toBe(
            "This app's App spec declares no dependencies.",
        );
    });
});
