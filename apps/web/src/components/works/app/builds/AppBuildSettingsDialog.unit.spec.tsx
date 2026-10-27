import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../../messages/en.json';

/**
 * APW-05 T28 / T46 (lane aw-builds-bindings, 2026-10-27) — the Build settings dialog, rendered
 * with the REAL English catalogue and the server actions mocked at their module boundary.
 */

const { getMock, saveMock, toastMock } = vi.hoisted(() => ({
    getMock: vi.fn(),
    saveMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/app/actions/dashboard/app-builds', () => ({
    getAppBuildSettingsAction: getMock,
    saveAppBuildSettingsAction: saveMock,
}));

vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { AppBuildSettingsDialog } from './AppBuildSettingsDialog';

const DEFAULTS = {
    largerRunnerLabel: '',
    largerRunnerMemoryGiB: null,
    largerRunnerVcpu: null,
    reclaimDisk: true,
    attestations: false,
    allowBuildValuesOnPullRequests: false,
    verificationPromptedValuesRequireApproval: true,
};

function renderDialog(
    props: Partial<{
        publicRepository: boolean;
        canEdit: boolean;
        onOpenChange: (open: boolean) => void;
    }> = {},
) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppBuildSettingsDialog
                workId="w1"
                pluginId="build-plugin"
                open
                onOpenChange={props.onOpenChange ?? (() => undefined)}
                publicRepository={props.publicRepository ?? false}
                canEdit={props.canEdit ?? true}
            />
        </NextIntlClientProvider>,
    );
}

beforeEach(() => {
    getMock.mockReset();
    saveMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
});

afterEach(() => cleanup());

describe('AppBuildSettingsDialog', () => {
    it('reads the settings for the plugin the Builds list named', async () => {
        getMock.mockResolvedValue({ success: true, data: { settings: DEFAULTS } });
        renderDialog();

        await screen.findByTestId('app-build-settings-form');
        expect(getMock).toHaveBeenCalledWith('w1', 'build-plugin');
        // Attestations are for public repositories only.
        expect(screen.queryByTestId('app-build-settings-attestations')).toBeNull();
    });

    it('shows the attestations switch for a public repository', async () => {
        getMock.mockResolvedValue({ success: true, data: { settings: DEFAULTS } });
        renderDialog({ publicRepository: true });
        expect(await screen.findByTestId('app-build-settings-attestations')).toBeTruthy();
    });

    it('warns when stored build values are sent to pull requests', async () => {
        getMock.mockResolvedValue({ success: true, data: { settings: DEFAULTS } });
        renderDialog();
        await screen.findByTestId('app-build-settings-form');

        expect(screen.queryByTestId('app-build-settings-pr-values-warning')).toBeNull();
        fireEvent.click(screen.getByTestId('app-build-settings-pr-values'));
        expect(screen.getByTestId('app-build-settings-pr-values-warning').textContent).toContain(
            'Any code in a pull request can read these values',
        );
    });

    it('refuses a label without a memory before any request, then saves the cleared runner keys', async () => {
        getMock.mockResolvedValue({ success: true, data: { settings: DEFAULTS } });
        saveMock.mockResolvedValue({ success: true, data: { saved: true } });
        const onOpenChange = vi.fn();
        renderDialog({ onOpenChange });
        await screen.findByTestId('app-build-settings-form');

        fireEvent.change(screen.getByTestId('app-build-settings-runner-label'), {
            target: { value: 'ubuntu-16core' },
        });
        fireEvent.click(screen.getByTestId('app-build-settings-save'));
        expect(
            await screen.findByText(
                'Enter the runner memory. The memory check needs it when a label is set.',
            ),
        ).toBeTruthy();
        expect(saveMock).not.toHaveBeenCalled();

        fireEvent.change(screen.getByTestId('app-build-settings-runner-label'), {
            target: { value: '' },
        });
        fireEvent.click(screen.getByTestId('app-build-settings-save'));
        await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
        expect(saveMock).toHaveBeenCalledWith('w1', 'build-plugin', {
            reclaimDisk: true,
            allowBuildValuesOnPullRequests: false,
            verificationPromptedValuesRequireApproval: true,
            largerRunnerLabel: null,
            largerRunnerMemoryGiB: null,
            largerRunnerVcpu: null,
        });
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(toastMock.success).toHaveBeenCalled();
    });

    it('disables saving for a viewer', async () => {
        getMock.mockResolvedValue({ success: true, data: { settings: DEFAULTS } });
        renderDialog({ canEdit: false });
        await screen.findByTestId('app-build-settings-form');
        expect((screen.getByTestId('app-build-settings-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('says so when the settings cannot be read', async () => {
        getMock.mockResolvedValue({ success: false, statusCode: 500 });
        renderDialog();
        expect(
            await screen.findByText(
                'The Build settings could not be loaded. Close this dialog and try again.',
            ),
        ).toBeTruthy();
    });
});
