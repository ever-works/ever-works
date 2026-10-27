import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetActionsRunnerOptionsView } from '@ever-works/contracts';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

const options = vi.fn();
const install = vi.fn();
vi.mock('@/app/actions/fleet/runners', () => ({
    listFleetActionsRunnersAction: vi.fn(),
    fleetActionsRunnerOptionsAction: (...args: unknown[]) => options(...args),
    installFleetActionsRunnersAction: (...args: unknown[]) => install(...args),
    fleetActionsRunnerControlAction: vi.fn(),
    removeFleetActionsRunnerAction: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        children,
        href,
        className,
    }: {
        children: React.ReactNode;
        href: string;
        className?: string;
    }) => (
        <a href={href} className={className}>
            {children}
        </a>
    ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { InstallRunnersDialog } from './InstallRunnersDialog';

/** Actions runners on computers (FL-18 P1, spec §5.1, T-16) — "Install Actions runners on <computer>". */

function opts(
    overrides: Partial<FleetActionsRunnerOptionsView> = {},
): FleetActionsRunnerOptionsView {
    return {
        nodeId: 'n1',
        nodeName: 'build-01',
        canHost: true,
        reason: null,
        hint: null,
        os: 'linux',
        arch: 'x64',
        targets: [
            {
                scope: 'repo',
                target: 'acme/api',
                accountLogin: 'acme',
                permission: 'ok',
                grantUrl: null,
            },
            {
                scope: 'org',
                target: 'acme',
                accountLogin: 'acme',
                permission: 'ok',
                grantUrl: null,
            },
        ],
        modes: ['service', 'docker'],
        defaultLabels: ['self-hosted', 'Linux', 'X64'],
        maxPerNode: 16,
        existing: 14,
        suggestedNames: ['build-01-1', 'build-01-2'],
        appInstalled: true,
        ...overrides,
    };
}

function open(onInstalled = vi.fn(), onClose = vi.fn()) {
    render(
        <InstallRunnersDialog
            open
            nodeId="n1"
            computer="build-01"
            existingNames={[]}
            onClose={onClose}
            onInstalled={onInstalled}
        />,
    );
    return { onInstalled, onClose };
}

beforeEach(() => {
    options.mockReset();
    install.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
});

describe('InstallRunnersDialog', () => {
    it('states target, count, mode, computer and that no credits are spent', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        open();
        expect(await screen.findByText('Install Actions runners on build-01')).toBeInTheDocument();
        expect(await screen.findByTestId('fleet-runners-install-summary')).toHaveTextContent(
            'Installs 1 Actions runner for acme/api on build-01 as a service. They run CI jobs on that computer; no credits are spent.',
        );
        expect(screen.getByText(/Runners cost nothing in Ever Works/)).toBeInTheDocument();
        // GitHub's own labels are shown as fixed chips.
        expect(screen.getByText('self-hosted')).toBeInTheDocument();
    });

    it('clamps the count to what still fits and names every runner', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        open();
        const count = await screen.findByTestId('fleet-runners-install-count');
        expect(screen.getByText('up to 2')).toBeInTheDocument();
        fireEvent.change(count, { target: { value: '9' } });
        expect(count).toHaveValue(2);
        expect(screen.getByTestId('fleet-runners-install-name-0')).toHaveValue('build-01-1');
        expect(screen.getByTestId('fleet-runners-install-name-1')).toHaveValue('build-01-2');
        expect(screen.getByTestId('fleet-runners-install-submit')).toHaveTextContent(
            'Install 2 runners',
        );
    });

    it('offers Service only (never the container mode in P1), and only the Windows service on Windows', async () => {
        options.mockResolvedValue({ ok: true, data: opts({ os: 'win32' }) });
        open();
        expect(await screen.findByTestId('fleet-runners-install-mode-service')).toBeChecked();
        expect(screen.queryByTestId('fleet-runners-install-mode-docker')).toBeNull();
        expect(screen.getByText('Windows service — the only mode on Windows')).toBeInTheDocument();
    });

    it('sends confirm: true with the target, names and cleaned labels, then closes', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        install.mockResolvedValue({
            ok: true,
            data: { runnerIds: ['r1'], operationId: 'j1', jobId: 'j1' },
        });
        const { onInstalled, onClose } = open();
        fireEvent.change(await screen.findByTestId('fleet-runners-install-labels'), {
            target: { value: 'gpu, self-hosted, gpu' },
        });
        fireEvent.click(screen.getByTestId('fleet-runners-install-submit'));
        await waitFor(() =>
            expect(install).toHaveBeenCalledWith('n1', {
                target: { scope: 'repo', target: 'acme/api' },
                count: 1,
                names: ['build-01-1'],
                labels: ['gpu'],
                mode: 'service',
                confirm: true,
            }),
        );
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onInstalled).toHaveBeenCalledWith({
            runnerIds: ['r1'],
            operationId: 'j1',
            jobId: 'j1',
        });
        expect(toast.success).toHaveBeenCalledWith('Installing 1 runner…');
    });

    it('refuses a label with a space before anything is sent', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        open();
        fireEvent.change(await screen.findByTestId('fleet-runners-install-labels'), {
            target: { value: 'big box' },
        });
        expect(screen.getByText(/“big box” is not a label/)).toBeInTheDocument();
        expect(screen.getByTestId('fleet-runners-install-submit')).toBeDisabled();
    });

    it('shows the exact command, copyable, when the computer needs elevated rights (root_required)', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        install.mockResolvedValue({
            ok: false,
            error: {
                code: 'root_required',
                hint: 'run this once on build-01',
                details: {
                    command:
                        'echo "node ALL=(root) NOPASSWD: /bin/systemctl" | sudo tee /etc/sudoers.d/node',
                },
            },
        });
        open();
        fireEvent.click(await screen.findByTestId('fleet-runners-install-submit'));
        expect(await screen.findByTestId('fleet-runners-install-command')).toHaveTextContent(
            'sudo tee /etc/sudoers.d/node',
        );
        expect(screen.getByText(/needs elevated rights for the node’s user/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy the command' })).toBeInTheDocument();
    });

    it('shows a refusal’s hint', async () => {
        options.mockResolvedValue({ ok: true, data: opts() });
        install.mockResolvedValue({
            ok: false,
            error: { code: 'invalid', hint: 'GitHub already has a runner named build-01-1' },
        });
        open();
        fireEvent.click(await screen.findByTestId('fleet-runners-install-submit'));
        expect(await screen.findByTestId('fleet-runners-install-error')).toHaveTextContent(
            'GitHub already has a runner named build-01-1',
        );
    });

    it('asks for the GitHub App first when none covers anything', async () => {
        options.mockResolvedValue({ ok: true, data: opts({ appInstalled: false, targets: [] }) });
        open();
        expect(
            await screen.findByText(
                'Install the Ever Works GitHub App on a repository or organisation first.',
            ),
        ).toBeInTheDocument();
        expect(screen.getByText('Open GitHub App settings')).toHaveAttribute(
            'href',
            '/settings/github-app',
        );
        expect(screen.queryByTestId('fleet-runners-install-submit')).toBeNull();
    });

    it('names why the computer cannot host runners', async () => {
        options.mockResolvedValue({
            ok: true,
            data: opts({
                canHost: false,
                reason: 'consent-missing',
                hint: 'start the node with --work on build-01',
            }),
        });
        open();
        expect(await screen.findByTestId('fleet-runners-install-cannot')).toHaveTextContent(
            'start the node with --work on build-01',
        );
        expect(screen.queryByTestId('fleet-runners-install-submit')).toBeNull();
    });

    it('offers Grant access for an organisation the App lacks the permission on', async () => {
        options.mockResolvedValue({
            ok: true,
            data: opts({
                targets: [
                    {
                        scope: 'org',
                        target: 'acme',
                        accountLogin: 'acme',
                        permission: 'missing',
                        grantUrl: 'https://github.com/organizations/acme/settings/installations/1',
                    },
                ],
            }),
        });
        open();
        expect(await screen.findByTestId('fleet-runners-install-permission')).toBeInTheDocument();
        expect(screen.getByText('Grant access').closest('a')).toHaveAttribute(
            'href',
            'https://github.com/organizations/acme/settings/installations/1',
        );
        expect(screen.getByTestId('fleet-runners-install-submit')).toBeDisabled();
    });
});
