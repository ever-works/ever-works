import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EverIdAdminSettings, EverIdAdminStatus } from '@/lib/api/ever-id';

const mocks = vi.hoisted(() => ({
    saveEverIdSettings: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/app/actions/ever-id', () => ({ saveEverIdSettings: mocks.saveEverIdSettings }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { EverIdAdminSettingsForm } from './ever-id-admin-settings-form';

/**
 * APW-12 — the administrator-managed Ever ID values (`PATCH /admin/settings`):
 * labelled inputs, terminal-client and app-name rows with Add/Remove inside the
 * API's limits (5 and 10), one Save that sends only what changed, one
 * `role="alert"` line for a refusal, a polite status line for a success, and the
 * values the API answered shown afterwards (FR-52).
 */

const SETTINGS: EverIdAdminSettings = {
    displayName: 'Ever ID',
    accountManagementUrl: 'https://id.example/account',
    localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
    delegatedClientNames: [{ clientId: 'reports-app', displayName: 'Reports' }],
};

function statusWith(settings: EverIdAdminSettings): EverIdAdminStatus {
    return {
        enabled: true,
        configured: true,
        missing: [],
        issuer: 'https://id.example',
        clientIdSet: true,
        clientSecretSet: true,
        displayName: settings.displayName,
        signUpAllowed: true,
        localClients: settings.localClients.length,
        unavailableSince: null,
        settingSources: {},
        settings,
    };
}

function renderForm(settings: Partial<EverIdAdminSettings> = {}) {
    const onSaved = vi.fn();
    render(<EverIdAdminSettingsForm settings={{ ...SETTINGS, ...settings }} onSaved={onSaved} />);
    return { onSaved };
}

function localClient(kind: 'cli' | 'node', index: number) {
    return { kind, clientId: `client-${index}` };
}

function save() {
    fireEvent.click(screen.getByTestId('ever-id-admin-settings-save'));
}

describe('EverIdAdminSettingsForm — what it shows', () => {
    afterEach(() => cleanup());

    it('labels every input and starts from the values the API answered', () => {
        renderForm();

        expect(screen.getByTestId('ever-id-admin-settings-form')).toBeInTheDocument();
        expect(screen.getByLabelText('Display name')).toHaveValue('Ever ID');
        expect(screen.getByLabelText('Display name')).toHaveAccessibleDescription(
            'The name Ever Works uses for this sign-in option. Up to 40 characters.',
        );
        expect(screen.getByLabelText('Account management address')).toHaveValue(
            'https://id.example/account',
        );

        const client = screen.getByTestId('ever-id-admin-local-client-0');
        expect(
            within(client).getByRole('group', { name: 'Terminal client 1' }),
        ).toBeInTheDocument();
        expect(within(client).getByLabelText('Type')).toHaveValue('cli');
        expect(within(client).getByLabelText('Client ID')).toHaveValue('ever-works-cli');

        const name = screen.getByTestId('ever-id-admin-delegated-name-0');
        expect(within(name).getByRole('group', { name: 'App name 1' })).toBeInTheDocument();
        expect(within(name).getByLabelText('Client ID')).toHaveValue('reports-app');
        expect(within(name).getByLabelText('Name')).toHaveValue('Reports');
    });

    it('offers both kinds of terminal client by name', () => {
        renderForm();

        const select = within(screen.getByTestId('ever-id-admin-local-client-0')).getByLabelText(
            'Type',
        );
        expect(
            within(select)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['Ever Works CLI', 'Ever Works Node']);
    });

    it('says so when a list is empty', () => {
        renderForm({ localClients: [], delegatedClientNames: [] });

        expect(screen.getByText('No terminal clients yet.')).toBeInTheDocument();
        expect(screen.getByText('No app names yet.')).toBeInTheDocument();
        expect(screen.queryByTestId('ever-id-admin-local-client-0')).not.toBeInTheDocument();
    });
});

describe('EverIdAdminSettingsForm — rows within the limits', () => {
    afterEach(() => cleanup());

    it('adds terminal clients up to five, then explains why Add is off', () => {
        renderForm({ localClients: [0, 1, 2, 3].map((i) => localClient('cli', i)) });
        const add = screen.getByRole('button', { name: 'Add a terminal client' });

        fireEvent.click(add);

        expect(screen.getByTestId('ever-id-admin-local-client-4')).toBeInTheDocument();
        expect(add).toBeDisabled();
        expect(add).toHaveAccessibleDescription(
            'Ever Works CLI and Ever Works Node clients that may sign in with Ever ID. Up to 5.',
        );
    });

    it('moves focus into a new row, and back to Add after a removal', async () => {
        renderForm({ localClients: [0, 1, 2, 3, 4].map((i) => localClient('cli', i)) });
        const add = screen.getByRole('button', { name: 'Add a terminal client' });
        expect(add).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Remove terminal client 2' }));

        expect(screen.queryByTestId('ever-id-admin-local-client-4')).not.toBeInTheDocument();
        expect(
            within(screen.getByTestId('ever-id-admin-local-client-1')).getByLabelText('Client ID'),
        ).toHaveValue('client-2');
        await waitFor(() => expect(add).toHaveFocus());

        fireEvent.click(add);

        await waitFor(() =>
            expect(
                within(screen.getByTestId('ever-id-admin-local-client-4')).getByLabelText('Type'),
            ).toHaveFocus(),
        );
    });

    it('adds app names up to ten', () => {
        renderForm({
            delegatedClientNames: Array.from({ length: 9 }, (_, i) => ({
                clientId: `app-${i}`,
                displayName: `App ${i}`,
            })),
        });
        const add = screen.getByRole('button', { name: 'Add an app name' });

        fireEvent.click(add);

        expect(screen.getByTestId('ever-id-admin-delegated-name-9')).toBeInTheDocument();
        expect(add).toBeDisabled();
    });

    it('names the row each Remove button removes', () => {
        renderForm();

        expect(screen.getByRole('button', { name: 'Remove terminal client 1' })).toHaveTextContent(
            'Remove',
        );
        expect(screen.getByRole('button', { name: 'Remove app name 1' })).toHaveTextContent(
            'Remove',
        );
    });
});

describe('EverIdAdminSettingsForm — saving', () => {
    beforeEach(() => {
        mocks.saveEverIdSettings.mockReset();
    });

    afterEach(() => cleanup());

    it('sends only what changed, trimmed, and an emptied address as null', async () => {
        mocks.saveEverIdSettings.mockResolvedValue({
            success: true,
            status: statusWith({
                ...SETTINGS,
                displayName: 'Ever ID Staging',
                accountManagementUrl: null,
            }),
        });
        renderForm();

        fireEvent.change(screen.getByLabelText('Display name'), {
            target: { value: '  Ever ID Staging  ' },
        });
        fireEvent.change(screen.getByLabelText('Account management address'), {
            target: { value: '' },
        });
        save();

        await waitFor(() => expect(mocks.saveEverIdSettings).toHaveBeenCalledTimes(1));
        expect(mocks.saveEverIdSettings).toHaveBeenCalledWith({
            displayName: 'Ever ID Staging',
            accountManagementUrl: null,
        });
    });

    it('sends the whole list when a row is added, changed or removed', async () => {
        mocks.saveEverIdSettings.mockResolvedValue({ success: true, status: statusWith(SETTINGS) });
        renderForm();

        fireEvent.click(screen.getByRole('button', { name: 'Add a terminal client' }));
        const added = screen.getByTestId('ever-id-admin-local-client-1');
        fireEvent.change(within(added).getByLabelText('Type'), { target: { value: 'node' } });
        fireEvent.change(within(added).getByLabelText('Client ID'), {
            target: { value: ' ever-works-node ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Remove app name 1' }));
        save();

        await waitFor(() => expect(mocks.saveEverIdSettings).toHaveBeenCalledTimes(1));
        expect(mocks.saveEverIdSettings).toHaveBeenCalledWith({
            localClients: [
                { kind: 'cli', clientId: 'ever-works-cli' },
                { kind: 'node', clientId: 'ever-works-node' },
            ],
            delegatedClientNames: [],
        });
    });

    it('does not call the API when nothing changed, and says so politely', async () => {
        renderForm();

        save();

        expect(await screen.findByTestId('ever-id-admin-settings-notice')).toHaveTextContent(
            'Nothing has changed.',
        );
        expect(screen.getByTestId('ever-id-admin-settings-notice')).toHaveAttribute(
            'role',
            'status',
        );
        expect(mocks.saveEverIdSettings).not.toHaveBeenCalled();
    });

    it('on success reports it politely, hands the new status up and shows what the API stored', async () => {
        const stored: EverIdAdminSettings = {
            ...SETTINGS,
            displayName: 'Ever ID Staging',
            localClients: [{ kind: 'node', clientId: 'node-from-api' }],
        };
        const status = statusWith(stored);
        mocks.saveEverIdSettings.mockResolvedValue({ success: true, status });
        const { onSaved } = renderForm();

        fireEvent.change(screen.getByLabelText('Display name'), {
            target: { value: 'Ever ID Staging' },
        });
        save();

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(status));
        expect(screen.getByTestId('ever-id-admin-settings-notice')).toHaveTextContent(
            'Ever ID settings saved.',
        );
        expect(screen.queryByTestId('ever-id-admin-settings-error')).not.toBeInTheDocument();
        const row = screen.getByTestId('ever-id-admin-local-client-0');
        expect(within(row).getByLabelText('Client ID')).toHaveValue('node-from-api');
        expect(within(row).getByLabelText('Type')).toHaveValue('node');
    });

    it('a refusal is one plain alert line, and nothing is handed up', async () => {
        mocks.saveEverIdSettings.mockResolvedValue({
            success: false,
            error: "Some values weren't accepted. Check them and try again.",
        });
        const { onSaved } = renderForm();

        fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
        save();

        const error = await screen.findByTestId('ever-id-admin-settings-error');
        expect(error).toHaveAttribute('role', 'alert');
        expect(error).toHaveTextContent("Some values weren't accepted. Check them and try again.");
        expect(onSaved).not.toHaveBeenCalled();
        // The draft is kept, so the value can be corrected.
        expect(screen.getByLabelText('Display name')).toHaveValue('Renamed');
    });

    it('shows "Saving…" and refuses a second press while a save is in flight', async () => {
        let finish: (value: unknown) => void = () => {};
        mocks.saveEverIdSettings.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        renderForm();

        fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
        save();

        await waitFor(() =>
            expect(screen.getByTestId('ever-id-admin-settings-save')).toHaveTextContent('Saving…'),
        );
        expect(screen.getByTestId('ever-id-admin-settings-save')).toBeDisabled();

        finish({ success: true, status: statusWith({ ...SETTINGS, displayName: 'Renamed' }) });
        await waitFor(() =>
            expect(screen.getByTestId('ever-id-admin-settings-save')).toHaveTextContent(
                'Save settings',
            ),
        );
        expect(mocks.saveEverIdSettings).toHaveBeenCalledTimes(1);
    });
});
