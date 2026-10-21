import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppStatusView } from '@/lib/api/app-runtime.types';

/**
 * Lane aw-deploy-3 — the Deploy tab's Roll back / Pause / Resume / Remove: each calls its route
 * once, the rollback lists only earlier live Deployments, and deleting stored data needs the
 * typed slug before the button enables.
 */

const { rollbackMock, lifecycleMock, toastSuccess, toastError } = vi.hoisted(() => ({
    rollbackMock: vi.fn(),
    lifecycleMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-runtime', () => ({
    rollbackAppAction: rollbackMock,
    appLifecycleAction: lifecycleMock,
    requestAppDeployAction: vi.fn(),
    saveAppTargetAction: vi.fn(),
    checkAppTargetAction: vi.fn(),
    getAppTargetAction: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { AppLifecycleActions } from './AppLifecycleActions';

const WORK = { id: '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10', slug: 'acme-app' };
const CURRENT = '11111111-1111-4111-8111-111111111111';
const EARLIER = '22222222-2222-4222-8222-222222222222';

function status(over: Partial<AppStatusView> = {}): AppStatusView {
    return {
        state: 'live',
        target: 'your-cluster',
        stale: false,
        observedAt: null,
        url: null,
        sourceOffer: null,
        currentDeployment: { id: CURRENT, state: 'READY' },
        ops: [
            { kind: 'deploy', state: 'done', at: '2026-10-17T10:00:00Z', deploymentId: CURRENT },
            { kind: 'deploy', state: 'failed', at: '2026-10-16T12:00:00Z', deploymentId: 'x' },
            { kind: 'deploy', state: 'done', at: '2026-10-16T10:00:00Z', deploymentId: EARLIER },
        ],
        ...over,
    };
}

function renderActions(view: AppStatusView = status(), extra: { isOwner?: boolean } = {}) {
    const onChanged = vi.fn();
    render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppLifecycleActions
                work={WORK}
                status={view}
                onChanged={onChanged}
                isOwner={extra.isOwner}
            />
        </NextIntlClientProvider>,
    );
    return { onChanged };
}

describe('AppLifecycleActions', () => {
    beforeEach(() => {
        rollbackMock.mockReset();
        lifecycleMock.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
    });
    afterEach(() => cleanup());

    it('rolls back to the earlier live Deployment only', async () => {
        rollbackMock.mockResolvedValue({ success: true, data: { unmet: [] } });
        const { onChanged } = renderActions();

        fireEvent.click(screen.getByTestId('app-rollback-open'));
        expect(screen.getAllByTestId('app-rollback-candidate')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('app-rollback-confirm'));

        await waitFor(() =>
            expect(rollbackMock).toHaveBeenCalledWith(WORK.id, { deploymentId: EARLIER }),
        );
        expect(onChanged).toHaveBeenCalled();
    });

    it('pauses a live app and resumes a paused one', async () => {
        lifecycleMock.mockResolvedValue({ success: true, data: {} });
        renderActions();
        fireEvent.click(screen.getByTestId('app-lifecycle-pause'));
        await waitFor(() =>
            expect(lifecycleMock).toHaveBeenCalledWith(WORK.id, { action: 'pause' }),
        );
        cleanup();

        renderActions(status({ state: 'paused' }));
        expect(screen.queryByTestId('app-lifecycle-pause')).toBeNull();
        fireEvent.click(screen.getByTestId('app-lifecycle-resume'));
        await waitFor(() =>
            expect(lifecycleMock).toHaveBeenLastCalledWith(WORK.id, { action: 'resume' }),
        );
    });

    it('needs the typed slug before removing stored data too', async () => {
        lifecycleMock.mockResolvedValue({ success: true, data: {} });
        renderActions();
        fireEvent.click(screen.getByTestId('app-lifecycle-remove-open'));
        fireEvent.click(screen.getByTestId('app-remove-delete-data'));

        const confirm = screen.getByTestId('app-remove-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('app-remove-confirm-slug'), {
            target: { value: 'acme-app' },
        });
        expect(confirm.disabled).toBe(false);
        fireEvent.click(confirm);

        await waitFor(() =>
            expect(lifecycleMock).toHaveBeenCalledWith(WORK.id, {
                action: 'remove',
                deleteData: true,
                confirmSlug: 'acme-app',
            }),
        );
    });

    describe("works-security — Remove with stored data is the owner's", () => {
        const OWNER_ONLY = 'Only the Work owner can do this.';

        it('an ownerRequired refusal of Remove with data reads the owner-only sentence, in the dialog too', async () => {
            lifecycleMock.mockResolvedValue({
                success: false,
                code: 'ownerRequired',
                httpStatus: 403,
                error: "Only the Work owner can delete the App's stored data.",
            });
            const { onChanged } = renderActions();
            fireEvent.click(screen.getByTestId('app-lifecycle-remove-open'));
            fireEvent.click(screen.getByTestId('app-remove-delete-data'));
            fireEvent.change(screen.getByTestId('app-remove-confirm-slug'), {
                target: { value: 'acme-app' },
            });
            fireEvent.click(screen.getByTestId('app-remove-confirm'));

            await waitFor(() =>
                expect(screen.getByTestId('app-remove-message').textContent).toBe(OWNER_ONLY),
            );
            expect(toastError).toHaveBeenCalledWith(OWNER_ONLY);
            // The dialog stays open, and nothing was reported as changed.
            expect(screen.getByTestId('app-remove-dialog')).toBeTruthy();
            expect(onChanged).not.toHaveBeenCalled();
        });

        it('a non-owner keeps Remove but the delete-data option is disabled with the reason', async () => {
            lifecycleMock.mockResolvedValue({ success: true, data: {} });
            renderActions(status(), { isOwner: false });
            fireEvent.click(screen.getByTestId('app-lifecycle-remove-open'));

            const deleteData = screen.getByTestId('app-remove-delete-data') as HTMLInputElement;
            expect(deleteData.disabled).toBe(true);
            const hint = screen.getByTestId('app-remove-delete-data-owner-only');
            expect(hint.textContent).toBe('Only the Work owner can delete stored data.');
            expect(deleteData.getAttribute('aria-describedby')).toBe(hint.id);

            // Remove without data is still an editor's.
            const confirm = screen.getByTestId('app-remove-confirm') as HTMLButtonElement;
            expect(confirm.disabled).toBe(false);
            fireEvent.click(confirm);
            await waitFor(() =>
                expect(lifecycleMock).toHaveBeenCalledWith(WORK.id, {
                    action: 'remove',
                    deleteData: false,
                }),
            );
        });

        it('an owner (or an unknown role) can tick delete-data', () => {
            renderActions(status(), { isOwner: true });
            fireEvent.click(screen.getByTestId('app-lifecycle-remove-open'));
            expect(
                (screen.getByTestId('app-remove-delete-data') as HTMLInputElement).disabled,
            ).toBe(false);
            expect(screen.queryByTestId('app-remove-delete-data-owner-only')).toBeNull();
        });

        it('an ownerRequired refusal of Roll back says the owner must confirm the cluster', async () => {
            rollbackMock.mockResolvedValue({
                success: false,
                code: 'ownerRequired',
                httpStatus: 403,
                error: 'Only the Work owner can confirm a cluster credential another member saved.',
            });
            renderActions();
            fireEvent.click(screen.getByTestId('app-rollback-open'));
            fireEvent.click(screen.getByTestId('app-rollback-confirm'));
            await waitFor(() =>
                expect(screen.getByTestId('app-rollback-message').textContent).toBe(
                    'Only the Work owner can do this. Another member saved this cluster connection, so the Work owner has to deploy once to confirm it.',
                ),
            );
        });
    });
});
