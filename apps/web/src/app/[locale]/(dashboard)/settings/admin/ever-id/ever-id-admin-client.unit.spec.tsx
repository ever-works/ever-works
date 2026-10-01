import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EverIdAdminHealth, EverIdAdminStatus } from '@/lib/api/ever-id';

const mocks = vi.hoisted(() => ({
    testEverIdConnection: vi.fn(),
    enableEverId: vi.fn(),
    disableEverId: vi.fn(),
    saveEverIdSettings: vi.fn(),
    toastSuccess: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return {
        useTranslations: enUseTranslations,
        useFormatter: () => ({
            dateTime: () => '1 Oct 2026, 09:00',
            relativeTime: () => '3 minutes ago',
        }),
    };
});
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('@/app/actions/ever-id', () => ({
    testEverIdConnection: mocks.testEverIdConnection,
    enableEverId: mocks.enableEverId,
    disableEverId: mocks.disableEverId,
    saveEverIdSettings: mocks.saveEverIdSettings,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { EverIdAdminClient } from './ever-id-admin-client';

/**
 * APW-12 T51 — the Ever ID administrator surface (S10, spec §6.7).
 *
 * One row per FR-3 check with its ✓/✗ copy, the Health labels, the secret never
 * rendered (only `•••••• (set)`), Turn on reporting a failed required check with
 * its rows, and the settings form for the administrator-managed values (its own
 * behaviour is covered beside it) feeding the new status back into the page.
 */

const SECRET = 'super-secret-client-secret';

const STATUS: EverIdAdminStatus = {
    enabled: false,
    configured: false,
    missing: ['clientId'],
    issuer: 'https://id.example',
    clientIdSet: false,
    clientSecretSet: true,
    displayName: 'Ever ID',
    signUpAllowed: true,
    localClients: 2,
    unavailableSince: null,
    settingSources: { issuer: 'env', clientSecret: 'admin', displayName: 'default' },
};

const HEALTH: EverIdAdminHealth = {
    discoveryRefreshedAt: '2026-10-01T08:57:00.000Z',
    jwksRefreshedAt: null,
    lastLogoutNoticeAt: '2026-10-01T08:00:00.000Z',
};

function renderAdmin(
    status: Partial<EverIdAdminStatus> = {},
    health: EverIdAdminHealth | null = HEALTH,
) {
    return render(
        <EverIdAdminClient initialStatus={{ ...STATUS, ...status }} initialHealth={health} />,
    );
}

describe('EverIdAdminClient — status', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('shows the state, the configuration, the issuer and what is missing', () => {
        renderAdmin();

        expect(screen.getByRole('heading', { name: 'Ever ID' })).toBeInTheDocument();
        const status = screen.getByTestId('ever-id-admin-status');
        expect(within(status).getByTestId('ever-id-admin-state')).toHaveTextContent('Off');
        expect(within(status).getByText('Incomplete')).toBeInTheDocument();
        expect(within(status).getByTestId('ever-id-admin-missing')).toHaveTextContent('Client ID');
        expect(within(status).getByText('https://id.example')).toBeInTheDocument();
        expect(within(status).getByText('Can be created with Ever ID')).toBeInTheDocument();
    });

    it('never renders the secret — only "•••••• (set)"', () => {
        const { container } = renderAdmin();

        expect(screen.getByTestId('ever-id-admin-secret')).toHaveTextContent('•••••• (set)');
        expect(container.innerHTML).not.toContain(SECRET);
    });

    it('says "Not set" for a secret that is not configured', () => {
        renderAdmin({ clientSecretSet: false });

        expect(screen.getByTestId('ever-id-admin-secret')).toHaveTextContent('Not set');
    });

    it('names where each value comes from', () => {
        renderAdmin();

        const sources = screen.getByTestId('ever-id-admin-sources');
        expect(sources).toHaveTextContent('Issuer address');
        expect(sources).toHaveTextContent('Environment');
        expect(sources).toHaveTextContent('Plugin settings');
        expect(sources).toHaveTextContent('Default');
    });

    it('labels the setting names the status reports, in both spellings', () => {
        renderAdmin({
            missing: ['issuerUrl'],
            settingSources: {
                issuerUrl: 'env',
                localClients: 'admin',
                delegatedClientNames: 'unset',
                accountManagementUrl: 'default',
            },
        });

        expect(screen.getByTestId('ever-id-admin-missing')).toHaveTextContent('Issuer address');
        const sources = screen.getByTestId('ever-id-admin-sources');
        expect(sources).toHaveTextContent('Issuer address');
        expect(sources).toHaveTextContent('Terminal clients');
        expect(sources).toHaveTextContent('App names');
        expect(sources).toHaveTextContent('Account management address');
        expect(sources).not.toHaveTextContent('issuerUrl');
        expect(sources).not.toHaveTextContent('delegatedClientNames');
    });

    it('shows no settings form when the API sends no settings (nothing to type into)', () => {
        renderAdmin();

        expect(screen.queryByTestId('ever-id-admin-settings-form')).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('reports a provider that stopped responding', () => {
        renderAdmin({ unavailableSince: '2026-10-01T09:00:00.000Z' });

        expect(screen.getByTestId('ever-id-admin-unavailable')).toHaveTextContent(
            "Ever ID hasn't responded since 1 Oct 2026, 09:00.",
        );
    });
});

describe('EverIdAdminClient — settings', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    const SETTINGS = {
        displayName: 'Ever ID',
        accountManagementUrl: null,
        localClients: [
            { kind: 'cli' as const, clientId: 'ever-works-cli' },
            { kind: 'node' as const, clientId: 'ever-works-node' },
        ],
        delegatedClientNames: [],
    };

    it('shows the form when the status carries the administrator-managed values', () => {
        renderAdmin({ settings: SETTINGS });

        const form = screen.getByTestId('ever-id-admin-settings-form');
        expect(within(form).getByLabelText('Display name')).toHaveValue('Ever ID');
        expect(screen.getByTestId('ever-id-admin-local-client-1')).toBeInTheDocument();
    });

    it('re-renders the status block from the status a save answers', async () => {
        mocks.saveEverIdSettings.mockResolvedValue({
            success: true,
            status: {
                ...STATUS,
                displayName: 'Ever ID Staging',
                localClients: 1,
                settings: {
                    ...SETTINGS,
                    displayName: 'Ever ID Staging',
                    localClients: [SETTINGS.localClients[0]],
                },
            },
        });
        renderAdmin({ settings: SETTINGS });

        fireEvent.change(screen.getByLabelText('Display name'), {
            target: { value: 'Ever ID Staging' },
        });
        fireEvent.click(screen.getByTestId('ever-id-admin-settings-save'));

        const status = screen.getByTestId('ever-id-admin-status');
        await waitFor(() =>
            expect(within(status).getByText('Ever ID Staging')).toBeInTheDocument(),
        );
        expect(mocks.saveEverIdSettings).toHaveBeenCalledWith({ displayName: 'Ever ID Staging' });
        expect(screen.queryByTestId('ever-id-admin-local-client-1')).not.toBeInTheDocument();
    });
});

describe('EverIdAdminClient — Test connection (FR-3)', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('renders one row per check id, in order, with ✓/✗ and its copy', async () => {
        mocks.testEverIdConnection.mockResolvedValue({
            success: true,
            checks: [
                { id: 'deviceAuthorization', ok: false },
                { id: 'discovery', ok: true },
                { id: 'issuerMatch', ok: true },
                { id: 'endpoints', ok: true },
                { id: 'pkceS256', ok: false },
                { id: 'signingAlg', ok: true },
                { id: 'backchannelLogout', ok: true },
            ],
        });
        renderAdmin();

        fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

        const checks = await screen.findByTestId('ever-id-admin-checks');
        const rows = within(checks).getAllByRole('listitem');
        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
            'ever-id-admin-check-discovery',
            'ever-id-admin-check-issuerMatch',
            'ever-id-admin-check-endpoints',
            'ever-id-admin-check-pkceS256',
            'ever-id-admin-check-signingAlg',
            'ever-id-admin-check-backchannelLogout',
            'ever-id-admin-check-deviceAuthorization',
        ]);
        expect(screen.getByTestId('ever-id-admin-check-issuerMatch')).toHaveTextContent(
            '✓Issuer matchesWorks',
        );
        expect(screen.getByTestId('ever-id-admin-check-pkceS256')).toHaveTextContent(
            '✗S256 code challenge supportedNot supported',
        );
    });

    it('announces a test that could not run', async () => {
        mocks.testEverIdConnection.mockResolvedValue({
            success: false,
            error: "The connection test didn't run. Try again.",
        });
        renderAdmin();

        fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

        expect(await screen.findByTestId('ever-id-admin-test-error')).toHaveAttribute(
            'role',
            'alert',
        );
    });
});

describe('EverIdAdminClient — Health', () => {
    afterEach(() => cleanup());

    it('shows the three Health labels, with "not yet" wording where nothing happened', () => {
        renderAdmin();

        const health = screen.getByTestId('ever-id-admin-health');
        expect(health).toHaveTextContent('Last discovery refresh 3 minutes ago');
        expect(health).toHaveTextContent('Signing keys not read yet');
        expect(health).toHaveTextContent('Last sign-out notice 3 minutes ago');
    });

    it('says health information is unavailable when it could not be read', () => {
        renderAdmin({}, null);

        expect(
            screen.getByText("Health information isn't available right now."),
        ).toBeInTheDocument();
    });
});

describe('EverIdAdminClient — Turn on / Turn off', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('a failed required check keeps Ever ID off and shows its rows', async () => {
        mocks.enableEverId.mockResolvedValue({
            success: false,
            error: 'Ever ID stays off: a required check failed.',
            checks: [{ id: 'issuerMatch', ok: false }],
        });
        renderAdmin();

        fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

        expect(await screen.findByTestId('ever-id-admin-toggle-error')).toHaveTextContent(
            'Ever ID stays off: a required check failed.',
        );
        expect(screen.getByTestId('ever-id-admin-check-issuerMatch')).toHaveTextContent(
            'Not supported',
        );
        expect(screen.getByTestId('ever-id-admin-state')).toHaveTextContent('Off');
    });

    it('turning on reflects the new status and says so; the button then turns it off', async () => {
        mocks.enableEverId.mockResolvedValue({
            success: true,
            status: { ...STATUS, enabled: true, configured: true, missing: [] },
        });
        mocks.disableEverId.mockResolvedValue({
            success: true,
            status: { ...STATUS, enabled: false },
        });
        renderAdmin();

        fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

        await waitFor(() =>
            expect(screen.getByTestId('ever-id-admin-state')).toHaveTextContent('On'),
        );
        expect(mocks.toastSuccess).toHaveBeenCalledWith('Ever ID is on.');

        // The button is busy until the first action has fully settled.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
        await waitFor(() => expect(mocks.disableEverId).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenLastCalledWith('Ever ID is off.'));
    });
});
