import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetActionsRunnerView } from '@ever-works/contracts';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

const control = vi.fn();
const remove = vi.fn();
const reinstall = vi.fn();
vi.mock('@/app/actions/fleet/runners', () => ({
    reinstallFleetActionsRunnerAction: (...args: unknown[]) => reinstall(...args),
    listFleetActionsRunnersAction: vi.fn(),
    fleetActionsRunnerOptionsAction: vi.fn(),
    installFleetActionsRunnersAction: vi.fn(),
    fleetActionsRunnerControlAction: (...args: unknown[]) => control(...args),
    removeFleetActionsRunnerAction: (...args: unknown[]) => remove(...args),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { RunnerActionsMenu } from './RunnerActionsMenu';

/** Actions runners on computers (FL-18 P1, spec §5.3, T-16) — one runner's Start / Stop / Restart / Remove runner…. */

const ACCEPTED = { ok: true, data: { runnerId: 'r1', operationId: 'j1', jobId: 'j1' } };

function runner(overrides: Partial<FleetActionsRunnerView> = {}): FleetActionsRunnerView {
    return {
        id: 'r1',
        nodeId: 'n1',
        name: 'build-01-1',
        scope: 'repo',
        target: 'acme/api',
        labels: [],
        defaultLabels: ['self-hosted'],
        mode: 'service',
        state: 'idle',
        stateSource: 'github',
        stoppedByOwner: false,
        phase: null,
        lastError: null,
        githubRunnerId: 7,
        runnerVersion: null,
        currentJob: null,
        lastSeenAt: null,
        lastCheckAt: null,
        installedAt: null,
        githubUrl: 'https://github.com/acme/api/settings/actions/runners',
        logSource: 'runner:build-01-1',
        ...overrides,
    };
}

function menu(row: FleetActionsRunnerView, onChanged = vi.fn()) {
    render(
        <RunnerActionsMenu
            runner={row}
            nodeId="n1"
            computer="build-01"
            allowed
            paused={false}
            onChanged={onChanged}
        />,
    );
    return onChanged;
}

beforeEach(() => {
    reinstall.mockReset();
    control.mockReset();
    remove.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
});

describe('RunnerActionsMenu', () => {
    it('asks before Stop with the contracts’ sentence, then sends confirm: true', async () => {
        control.mockResolvedValue(ACCEPTED);
        const onChanged = menu(runner());
        fireEvent.click(screen.getByTestId('fleet-runner-stop'));
        expect(await screen.findByText('Stop build-01-1?')).toBeInTheDocument();
        expect(
            screen.getByText(
                'It stops taking jobs until you start it. A job in progress finishes first.',
            ),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('fleet-machine-confirm'));
        await waitFor(() => expect(control).toHaveBeenCalledWith('n1', 'r1', 'stop', true));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        expect(toast.success).toHaveBeenCalledWith('Stopping build-01-1…');
    });

    it('starts a stopped runner at once (plain)', async () => {
        control.mockResolvedValue(ACCEPTED);
        menu(runner({ state: 'stopped', stoppedByOwner: true }));
        expect(screen.queryByTestId('fleet-runner-stop')).toBeNull();
        fireEvent.click(screen.getByTestId('fleet-runner-start'));
        await waitFor(() => expect(control).toHaveBeenCalledWith('n1', 'r1', 'start', false));
    });

    it('shows a refusal’s hint (busy mid-job)', async () => {
        control.mockResolvedValue({
            ok: false,
            error: { code: 'busy', hint: 'build-01-1 is still being installed' },
        });
        menu(runner({ state: 'offline' }));
        fireEvent.click(screen.getByTestId('fleet-runner-start'));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('build-01-1 is still being installed'),
        );
    });

    it('reopens the dialog the server describes when it still wants a confirmation', async () => {
        control
            .mockResolvedValueOnce({
                ok: false,
                error: {
                    code: 'confirmation_required',
                    hint: 'send confirm: true to confirm',
                    details: { class: 'confirm', summary: 'Start build-01-1?' },
                },
            })
            .mockResolvedValueOnce(ACCEPTED);
        menu(runner({ state: 'offline' }));
        fireEvent.click(screen.getByTestId('fleet-runner-start'));
        expect(await screen.findByText('Start build-01-1?')).toBeInTheDocument();
        // The first call's transition settles before the dialog's button can be pressed.
        await waitFor(() => expect(screen.getByTestId('fleet-machine-confirm')).toBeEnabled());
        fireEvent.click(screen.getByTestId('fleet-machine-confirm'));
        await waitFor(() => expect(control).toHaveBeenLastCalledWith('n1', 'r1', 'start', true));
    });

    it('disables every act but Remove while installing', () => {
        menu(runner({ state: 'installing', phase: 'downloading' }));
        expect(screen.getByTestId('fleet-runner-stop')).toBeDisabled();
        expect(screen.getByTestId('fleet-runner-restart')).toBeDisabled();
        expect(screen.queryByTestId('fleet-runner-start')).toBeNull();
        expect(screen.getByRole('button', { name: 'More for build-01-1' })).toBeInTheDocument();
    });

    it('removes only after the runner’s name is typed', async () => {
        remove.mockResolvedValue(ACCEPTED);
        menu(runner());
        fireEvent.click(screen.getByRole('button', { name: 'More for build-01-1' }));
        fireEvent.click(await screen.findByText('Remove runner…'));
        expect(await screen.findByText('Remove build-01-1?')).toBeInTheDocument();
        const confirm = screen.getByTestId('fleet-machine-confirm');
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByTestId('fleet-machine-confirm-name'), {
            target: { value: 'build-01-1' },
        });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(remove).toHaveBeenCalledWith('n1', 'r1', 'build-01-1'));
        expect(toast.success).toHaveBeenCalledWith('Removing build-01-1…');
    });

    it('is disabled with the reason outside the machines audience', () => {
        render(
            <RunnerActionsMenu
                runner={runner()}
                nodeId="n1"
                computer="build-01"
                allowed={false}
                paused={false}
                onChanged={vi.fn()}
            />,
        );
        expect(screen.getByTestId('fleet-runner-stop')).toBeDisabled();
        expect(screen.getByTestId('fleet-runner-stop')).toHaveAttribute(
            'title',
            'Only the people allowed to change computers on build-01 can control its runners',
        );
    });

    // ─── P3 (FR-28): Reinstall ──────────────────────────────────────────────

    it('retries a failed install as a Reinstall, confirmed, with confirm: true', async () => {
        reinstall.mockResolvedValue(ACCEPTED);
        const onChanged = menu(runner({ state: 'failed', lastError: 'checksum mismatch' }));
        const retry = screen.getByTestId('fleet-runner-reinstall');
        expect(retry).toHaveTextContent('Retry');
        fireEvent.click(retry);
        expect(await screen.findByText('Reinstall build-01-1?')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('fleet-machine-confirm'));
        await waitFor(() => expect(reinstall).toHaveBeenCalledWith('n1', 'r1', true));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        expect(toast.success).toHaveBeenCalledWith('Reinstalling build-01-1…');
    });

    it('offers Reinstall… in the row when GitHub has a newer build, naming it', async () => {
        reinstall.mockResolvedValue(ACCEPTED);
        menu(runner({ state: 'idle', runnerVersion: '2.321.0', updateAvailable: '2.322.0' }));
        const button = screen.getByTestId('fleet-runner-reinstall');
        expect(button).toHaveTextContent('Reinstall…');
        fireEvent.click(button);
        expect(
            await screen.findByText('Reinstall build-01-1 with runner 2.322.0?'),
        ).toBeInTheDocument();
    });

    it('keeps Reinstall… in the ⋯ menu otherwise, and never offers it mid-job', async () => {
        menu(runner({ state: 'idle' }));
        expect(screen.queryByTestId('fleet-runner-reinstall')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'More for build-01-1' }));
        expect(await screen.findByTestId('fleet-runner-reinstall-menu')).toHaveTextContent(
            'Reinstall…',
        );
    });

    it('does not offer Reinstall while a job runs', async () => {
        menu(runner({ state: 'working', runnerVersion: '2.321.0', updateAvailable: '2.322.0' }));
        expect(screen.queryByTestId('fleet-runner-reinstall')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'More for build-01-1' }));
        await screen.findByText('Remove runner…');
        expect(screen.queryByTestId('fleet-runner-reinstall-menu')).toBeNull();
    });

    it('shows the server’s hint when a reinstall is refused', async () => {
        reinstall.mockResolvedValue({
            ok: false,
            error: { code: 'busy', hint: 'build-01-1 is still being installed' },
        });
        menu(runner({ state: 'failed' }));
        fireEvent.click(screen.getByTestId('fleet-runner-reinstall'));
        fireEvent.click(await screen.findByTestId('fleet-machine-confirm'));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('build-01-1 is still being installed'),
        );
    });
});
