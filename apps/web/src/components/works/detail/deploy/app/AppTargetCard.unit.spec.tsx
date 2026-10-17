import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppTargetView } from '@/lib/api/app-runtime.types';

/**
 * APW-06 T37 — the target card and the Deploy page's App branch (spec §6.1,
 * S1; R-12). Rendered with the REAL English catalogue so the asserted copy is
 * what a member reads; the server actions are mocked at their module boundary.
 */

const { saveAppTargetActionMock } = vi.hoisted(() => ({ saveAppTargetActionMock: vi.fn() }));

vi.mock('@/app/actions/dashboard/app-runtime', () => ({
    saveAppTargetAction: saveAppTargetActionMock,
    checkAppTargetAction: vi.fn(),
    getAppTargetAction: vi.fn(),
    requestAppDeployAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppTargetCard } from './AppTargetCard';
import { AppDeployPage } from './AppDeployPage';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';

function view(over: Partial<AppTargetView> = {}): AppTargetView {
    return {
        target: 'none',
        settings: null,
        namespace: null,
        clusterCheck: null,
        clusterCheckedAt: null,
        eligibility: null,
        routeAvailable: true,
        ...over,
    };
}

function wrap(node: ReactNode) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );
}

describe('AppTargetCard', () => {
    beforeEach(() => {
        saveAppTargetActionMock.mockReset();
    });
    afterEach(() => cleanup());

    it('renders None as the current target with its R-12 label and one line per target', () => {
        wrap(
            <AppTargetCard
                workId={WORK_ID}
                target={view()}
                canEdit
                onConnectCluster={vi.fn()}
                onSaved={vi.fn()}
            />,
        );

        expect(screen.getByText("None — don't deploy yet")).toBeTruthy();
        expect(screen.getByText('Builds still run.')).toBeTruthy();
        expect(screen.getByText('Runs on a Kubernetes cluster you control.')).toBeTruthy();
        expect(screen.getByText('We run it for you on our cluster.')).toBeTruthy();
        expect((screen.getByTestId('app-target-none') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText('(current)')).toBeTruthy();
        // S1 — Connect your cluster is the primary action.
        expect(screen.getByTestId('app-target-connect').textContent).toContain(
            'Connect your cluster',
        );
    });

    it('disables Ever Works Apps and announces why (ACC-06-38)', () => {
        wrap(
            <AppTargetCard
                workId={WORK_ID}
                target={view()}
                canEdit
                onConnectCluster={vi.fn()}
                onSaved={vi.fn()}
            />,
        );

        const managed = screen.getByTestId('app-target-ever-works-apps') as HTMLInputElement;
        expect(managed.disabled).toBe(true);
        const reason = screen.getByTestId('app-target-managed-reason');
        expect(reason.textContent).toBe("Coming soon — managed hosting for apps isn't open yet.");
        expect(managed.getAttribute('aria-describedby')).toBe(reason.id);
    });

    it('saves a changed target and reports it', async () => {
        const saved = view({ target: 'your-cluster' });
        saveAppTargetActionMock.mockResolvedValue({ success: true, data: saved });
        const onSaved = vi.fn();
        wrap(
            <AppTargetCard
                workId={WORK_ID}
                target={view()}
                canEdit
                onConnectCluster={vi.fn()}
                onSaved={onSaved}
            />,
        );

        fireEvent.click(screen.getByTestId('app-target-your-cluster'));
        expect(
            screen.getByText("Changing the target doesn't remove anything already running."),
        ).toBeTruthy();
        fireEvent.click(screen.getByTestId('app-target-save'));

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
        expect(saveAppTargetActionMock).toHaveBeenCalledWith(WORK_ID, { target: 'your-cluster' });
    });

    it('says so when the target route is not on this instance', async () => {
        saveAppTargetActionMock.mockResolvedValue({ success: false, code: 'route_unavailable' });
        wrap(
            <AppTargetCard
                workId={WORK_ID}
                target={view()}
                canEdit
                onConnectCluster={vi.fn()}
                onSaved={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByTestId('app-target-your-cluster'));
        fireEvent.click(screen.getByTestId('app-target-save'));

        await waitFor(() =>
            expect(screen.getByTestId('app-target-error').textContent).toBe(
                "Changing the target isn't available on this instance yet.",
            ),
        );
    });

    it('opens the connect dialog from Your cluster', () => {
        const onConnectCluster = vi.fn();
        wrap(
            <AppTargetCard
                workId={WORK_ID}
                target={view()}
                canEdit
                onConnectCluster={onConnectCluster}
                onSaved={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByTestId('app-target-connect'));
        expect(onConnectCluster).toHaveBeenCalledTimes(1);
    });
});

describe('AppDeployPage', () => {
    afterEach(() => cleanup());

    it('reads "This app isn\'t running anywhere yet." with no Deploy now for target None (S1, ACC-06-01)', () => {
        wrap(
            <AppDeployPage
                work={{ id: WORK_ID, slug: 'tasks-app', name: 'Tasks App' }}
                initialTarget={view()}
                status={null}
                canEdit
            />,
        );

        expect(screen.getByTestId('app-deploy-state').textContent).toBe(
            "This app isn't running anywhere yet.",
        );
        expect(screen.queryByTestId('app-deploy-now-button')).toBeNull();
        expect(screen.getByText('See Builds').getAttribute('href')).toBe(
            `/works/${WORK_ID}/builds`,
        );
    });

    it('offers Deploy now once a target is chosen', () => {
        wrap(
            <AppDeployPage
                work={{ id: WORK_ID, slug: 'tasks-app', name: 'Tasks App' }}
                initialTarget={view({ target: 'your-cluster' })}
                status={null}
                canEdit
            />,
        );
        expect(screen.getByTestId('app-deploy-now-button').textContent).toContain('Deploy now');
    });
});
