import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppClusterCheckView, AppTargetView } from '@/lib/api/app-runtime.types';

/**
 * APW-06 T37 (spec §6.2, S2) — **Connect your cluster**.
 *
 * The load-bearing property: the kubeconfig leaves the page through the check
 * action ONLY (APW06-G01, ACC-06-56). The generic work-plugin-settings action
 * is mocked so the spec can prove it is never touched, and the Save payload is
 * checked for the pasted text.
 */

const { checkMock, getTargetMock, saveMock, updateWorkPluginSettingsMock } = vi.hoisted(() => ({
    checkMock: vi.fn(),
    getTargetMock: vi.fn(),
    saveMock: vi.fn(),
    updateWorkPluginSettingsMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-runtime', () => ({
    checkAppTargetAction: checkMock,
    getAppTargetAction: getTargetMock,
    saveAppTargetAction: saveMock,
    requestAppDeployAction: vi.fn(),
}));
vi.mock('@/app/actions/plugins', () => ({
    updateWorkPluginSettings: updateWorkPluginSettingsMock,
    updatePluginSettings: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
    // The shared Button primitive reads `Link` at module scope.
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ConnectClusterDialog } from './ConnectClusterDialog';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';
const KUBECONFIG =
    'apiVersion: v1\nkind: Config\nusers:\n- name: sa\n  user:\n    token: s3cr3t-token-value\n';

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

function check(over: Partial<AppClusterCheckView> = {}): AppClusterCheckView {
    return {
        ok: true,
        serverVersion: 'v1.31.2',
        fingerprint: 'fp-1',
        missingPermissions: [],
        optionalMissing: [],
        ingressClasses: [
            { name: 'traefik', isDefault: false },
            { name: 'nginx', isDefault: true },
        ],
        controllerNamespace: 'ingress-nginx',
        clusterIssuers: ['letsencrypt'],
        storageClasses: [{ name: 'standard', isDefault: true }],
        ...over,
    };
}

function renderDialog(target: AppTargetView = view(), onSaved = vi.fn()) {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <ConnectClusterDialog
                open
                onOpenChange={vi.fn()}
                workId={WORK_ID}
                target={target}
                onSaved={onSaved}
                pollIntervalMs={0}
                pollMax={3}
            />
        </NextIntlClientProvider>,
    );
    return { onSaved };
}

function paste(text: string) {
    fireEvent.change(screen.getByTestId('connect-cluster-kubeconfig'), { target: { value: text } });
}

describe('ConnectClusterDialog', () => {
    beforeEach(() => {
        checkMock.mockReset();
        getTargetMock.mockReset();
        saveMock.mockReset();
        updateWorkPluginSettingsMock.mockReset();
    });
    afterEach(() => cleanup());

    it('keeps Save disabled until a check passed', () => {
        renderDialog();
        expect((screen.getByTestId('connect-cluster-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('keeps Save disabled while a required permission is missing (ACC-06-05)', async () => {
        checkMock.mockResolvedValue({ success: true });
        getTargetMock.mockResolvedValue({
            success: true,
            data: view({
                clusterCheck: check({
                    ok: false,
                    missingPermissions: [{ verb: 'create', resource: 'networkpolicies' }],
                }),
                clusterCheckedAt: '2026-10-17T10:00:00.000Z',
            }),
        });
        renderDialog();

        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));

        await waitFor(() =>
            expect(screen.getByTestId('cluster-check-missing').textContent).toContain(
                'Missing: create networkpolicies',
            ),
        );
        expect((screen.getByTestId('connect-cluster-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('sends the kubeconfig only through the check action, then saves the target without it (ACC-06-56)', async () => {
        checkMock.mockResolvedValue({ success: true });
        getTargetMock.mockResolvedValue({
            success: true,
            data: view({
                clusterCheck: check(),
                clusterCheckedAt: '2026-10-17T10:00:00.000Z',
                namespace: 'ew-tasks-app',
            }),
        });
        const saved = view({ target: 'your-cluster', clusterCheck: check() });
        saveMock.mockResolvedValue({ success: true, data: saved });
        const { onSaved } = renderDialog();

        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));

        await waitFor(() => expect(screen.getByTestId('cluster-check-result')).toBeTruthy());
        expect(checkMock).toHaveBeenCalledWith(WORK_ID, { kubeconfig: KUBECONFIG.trim() });
        // The textarea is cleared once the API holds the credential.
        expect(
            (screen.getByTestId('connect-cluster-kubeconfig') as HTMLTextAreaElement).value,
        ).toBe('');
        expect(screen.getByText('ew-tasks-app')).toBeTruthy();

        const saveButton = screen.getByTestId('connect-cluster-save') as HTMLButtonElement;
        await waitFor(() => expect(saveButton.disabled).toBe(false));
        fireEvent.click(saveButton);

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
        expect(saveMock).toHaveBeenCalledWith(WORK_ID, {
            target: 'your-cluster',
            settings: {
                ingressClass: 'nginx',
                tls: 'cert-manager',
                issuer: 'letsencrypt',
                networkIsolation: true,
            },
        });
        expect(JSON.stringify(saveMock.mock.calls)).not.toContain('s3cr3t-token-value');
        expect(updateWorkPluginSettingsMock).not.toHaveBeenCalled();
    });

    it('renders the refusal reason of a kubeconfig the worker refused (ACC-06-02)', async () => {
        checkMock.mockResolvedValue({ success: true });
        getTargetMock.mockResolvedValue({
            success: true,
            data: view({
                clusterCheck: check({
                    ok: false,
                    error: {
                        code: 'KUBECONFIG_UNSUPPORTED',
                        message: 'runs an exec credential plugin',
                    },
                }),
                clusterCheckedAt: '2026-10-17T10:00:00.000Z',
            }),
        });
        renderDialog();

        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));

        await waitFor(() =>
            expect(screen.getByTestId('cluster-check-error').textContent).toBe(
                'This kubeconfig runs an exec credential plugin. Use a service account token instead.',
            ),
        );
        expect((screen.getByTestId('connect-cluster-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('renders the not-public refusal', async () => {
        checkMock.mockResolvedValue({ success: true });
        getTargetMock.mockResolvedValue({
            success: true,
            data: view({
                clusterCheck: check({
                    ok: false,
                    error: { code: 'CLUSTER_ADDRESS_NOT_PUBLIC', message: '10.0.0.1' },
                }),
                clusterCheckedAt: '2026-10-17T10:00:00.000Z',
            }),
        });
        renderDialog();
        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));
        await waitFor(() =>
            expect(screen.getByTestId('cluster-check-error').textContent).toBe(
                'Ever Works can only reach clusters at a public address.',
            ),
        );
    });

    it('says the feature is not available when the check route is missing', async () => {
        checkMock.mockResolvedValue({ success: false, code: 'route_unavailable' });
        renderDialog();
        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));
        await waitFor(() =>
            expect(screen.getByTestId('connect-cluster-unavailable').textContent).toContain(
                "Connecting a cluster isn't available on this instance yet.",
            ),
        );
        expect(getTargetMock).not.toHaveBeenCalled();
    });

    it('reports a check that never finishes', async () => {
        checkMock.mockResolvedValue({ success: true });
        getTargetMock.mockResolvedValue({ success: true, data: view() });
        renderDialog();
        paste(KUBECONFIG);
        fireEvent.click(screen.getByTestId('connect-cluster-check'));
        await waitFor(() =>
            expect(screen.getByTestId('connect-cluster-notice').textContent).toBe(
                "The check didn't finish within 30 seconds. Try again.",
            ),
        );
        expect(getTargetMock).toHaveBeenCalledTimes(3);
    });

    it('warns when network isolation is switched off (ACC-06-17)', () => {
        renderDialog(view({ clusterCheck: check(), clusterCheckedAt: '2026-10-17T10:00:00.000Z' }));
        expect(screen.queryByTestId('connect-cluster-isolation-warning')).toBeNull();
        fireEvent.click(screen.getByTestId('connect-cluster-isolation-off'));
        expect(screen.getByTestId('connect-cluster-isolation-warning').textContent).toContain(
            'Without network isolation',
        );
    });
});
