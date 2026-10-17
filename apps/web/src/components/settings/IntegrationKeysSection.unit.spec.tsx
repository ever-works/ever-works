import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EVER_GAUZY_PRESET_SCOPES, type IntegrationKeySummary } from '@ever-works/contracts';

const createIntegrationKey = vi.fn();
const rotateApiKey = vi.fn();
const revokeApiKey = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/settings/api-keys',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/app/actions/api-keys', () => ({
    createIntegrationKey: (...args: unknown[]) => createIntegrationKey(...args),
    rotateApiKey: (...args: unknown[]) => rotateApiKey(...args),
    revokeApiKey: (...args: unknown[]) => revokeApiKey(...args),
}));

import { IntegrationKeysSection } from './IntegrationKeysSection';
import { EverGauzyIntegrationCard, EVER_GAUZY_NEW_KEY_HREF } from './EverGauzyIntegrationCard';
import type { WebhookSubscription } from '@/lib/api/webhooks';

/**
 * EW-P1-7 — Settings → API keys → Integration keys, and the Ever Gauzy card.
 */
const ORGS = [
    { id: 'o-1', slug: 'acme', displayName: 'Acme' },
    { id: 'o-2', slug: 'beta', displayName: 'Beta' },
];

const KEY: IntegrationKeySummary = {
    id: 'k-1',
    name: 'Ever Gauzy — Acme',
    description: null,
    prefix: 'ew_int_ab12',
    kind: 'integration',
    integrationKind: 'ever-gauzy',
    scopes: ['tasks:read', 'tasks:write'],
    organizationIds: ['o-1'],
    organizations: [ORGS[0]],
    createdByUserId: 'u-1',
    createdAt: '2026-10-15T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    rotatedAt: null,
    previousKeyGraceUntil: null,
};

describe('IntegrationKeysSection', () => {
    beforeEach(() => {
        createIntegrationKey.mockReset();
        rotateApiKey.mockReset();
        revokeApiKey.mockReset();
    });

    it('lists integration keys with kind, prefix, pins and scope count', () => {
        render(<IntegrationKeysSection initialKeys={[KEY]} organizations={ORGS} />);
        const table = screen.getByTestId('integration-keys-table');
        expect(table.textContent).toContain('Ever Gauzy — Acme');
        expect(table.textContent).toContain('kinds.ever-gauzy');
        expect(table.textContent).toContain('ew_int_ab12...');
        expect(table.textContent).toContain('Acme');
        expect(table.textContent).toContain('scopeCount:{"count":2}');
    });

    it('the deep link opens the dialog with the Ever Gauzy preset (all but the opt-in scopes)', () => {
        render(
            <IntegrationKeysSection
                initialKeys={[]}
                organizations={ORGS}
                openOnArrival
                initialPreset="ever-gauzy"
            />,
        );
        const scopes = screen.getByTestId('integration-scopes');
        const checked = [...scopes.querySelectorAll('input[type="checkbox"]')].filter(
            (input) => (input as HTMLInputElement).checked,
        );
        expect(checked).toHaveLength(EVER_GAUZY_PRESET_SCOPES.length);
        const orgWrite = screen.getByLabelText('org:write') as HTMLInputElement;
        const emailWrite = screen.getByLabelText('email:write') as HTMLInputElement;
        expect(orgWrite.checked).toBe(false);
        expect(emailWrite.checked).toBe(false);
    });

    it('creates an Ever Gauzy key with the picked pins and shows the secret once', async () => {
        createIntegrationKey.mockResolvedValue({
            success: true,
            data: { ...KEY, id: 'k-2', key: 'ew_int_' + 'f'.repeat(64) },
            error: null,
        });
        render(
            <IntegrationKeysSection
                initialKeys={[]}
                organizations={ORGS}
                openOnArrival
                initialPreset="ever-gauzy"
            />,
        );
        fireEvent.change(screen.getByPlaceholderText('dialog.namePlaceholder'), {
            target: { value: 'Ever Gauzy — Acme' },
        });
        fireEvent.click(screen.getByLabelText('Acme'));
        fireEvent.click(screen.getByText('dialog.createButton'));

        await waitFor(() => expect(createIntegrationKey).toHaveBeenCalled());
        expect(createIntegrationKey.mock.calls[0][0]).toMatchObject({
            name: 'Ever Gauzy — Acme',
            integrationKind: 'ever-gauzy',
            organizationIds: ['o-1'],
            scopes: [...EVER_GAUZY_PRESET_SCOPES],
        });
        await waitFor(() =>
            expect(screen.getByTestId('integration-key-secret').textContent).toBe(
                'ew_int_' + 'f'.repeat(64),
            ),
        );
    });

    it('refuses to submit without an organization', async () => {
        render(
            <IntegrationKeysSection
                initialKeys={[]}
                organizations={ORGS}
                openOnArrival
                initialPreset="ever-gauzy"
            />,
        );
        fireEvent.change(screen.getByPlaceholderText('dialog.namePlaceholder'), {
            target: { value: 'x' },
        });
        fireEvent.click(screen.getByText('dialog.createButton'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createIntegrationKey).not.toHaveBeenCalled();
    });

    it('rotates with the chosen grace period and shows the new secret', async () => {
        rotateApiKey.mockResolvedValue({
            success: true,
            data: {
                id: 'k-1',
                name: KEY.name,
                key: 'ew_int_' + 'a'.repeat(64),
                prefix: 'ew_int_aaaa',
                rotatedAt: '2026-10-16T00:00:00.000Z',
                previousKeyGraceUntil: '2099-01-01T00:00:00.000Z',
            },
            error: null,
        });
        render(<IntegrationKeysSection initialKeys={[KEY]} organizations={ORGS} />);
        fireEvent.click(screen.getByLabelText(`rotate.action ${KEY.name}`));
        fireEvent.click(screen.getByText('rotate.confirm'));
        await waitFor(() => expect(rotateApiKey).toHaveBeenCalledWith('k-1', 24));
        await waitFor(() =>
            expect(screen.getByTestId('integration-key-secret').textContent).toBe(
                'ew_int_' + 'a'.repeat(64),
            ),
        );
    });
});

describe('EverGauzyIntegrationCard', () => {
    it('explains the manual connection, links to the preset dialog and lists Ever Gauzy keys', () => {
        render(
            <EverGauzyIntegrationCard initialKeys={[KEY]} apiUrl="https://api.ever.works/api" />,
        );
        expect(EVER_GAUZY_NEW_KEY_HREF).toBe(
            '/settings/api-keys?new=integration&preset=ever-gauzy',
        );
        const link = [...document.querySelectorAll('a')].find(
            (a) => a.getAttribute('href') === EVER_GAUZY_NEW_KEY_HREF,
        );
        expect(link).toBeTruthy();
        const card = screen.getByTestId('ever-gauzy-integration');
        expect(card.textContent).toContain('https://api.ever.works/api');
        expect(card.textContent).toContain('Ever Gauzy — Acme');
    });

    it('shows the empty state when Ever Gauzy is not connected', () => {
        render(<EverGauzyIntegrationCard initialKeys={[]} apiUrl="https://api.ever.works/api" />);
        expect(screen.getByText('noKeys')).toBeInTheDocument();
    });

    const webhook = (extra: Partial<WebhookSubscription>): WebhookSubscription => ({
        id: 'w-1',
        accountId: 'u-1',
        workId: null,
        url: 'https://gauzy.test/hooks/ever-works',
        status: 'active',
        consecutiveFailures: 0,
        lastDeliveryAt: null,
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
        version: 2,
        ownerType: 'integration_key',
        ownerId: 'k-1',
        events: ['task.*', 'team.*'],
        organizationIds: ['o-1'],
        excludeOriginTags: ['gauzy:conn-1'],
        description: null,
        ...extra,
    });

    it("lists each key's own webhook subscriptions; revoking says it disables them too", () => {
        revokeApiKey.mockReset();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(
            <EverGauzyIntegrationCard
                initialKeys={[KEY]}
                apiUrl="https://api.ever.works/api"
                webhooks={[
                    webhook({}),
                    webhook({ id: 'w-2', status: 'disabled', url: 'https://gauzy.test/old' }),
                    webhook({ id: 'w-3', ownerId: 'k-other', url: 'https://other.test/hook' }),
                ]}
            />,
        );
        const list = screen.getByTestId('ever-gauzy-key-webhooks-k-1');
        expect(list.textContent).toContain('https://gauzy.test/hooks/ever-works');
        expect(list.textContent).toContain('webhookStatus.disabled');
        expect(list.textContent).not.toContain('https://other.test/hook');
        fireEvent.click(screen.getByText('revoke'));
        // Only the subscriptions that still deliver are counted.
        expect(confirm).toHaveBeenCalledWith('revokeHintWithWebhooks:{"count":1}');
        expect(revokeApiKey).not.toHaveBeenCalled();
        confirm.mockRestore();
    });

    it('says so when the webhook subscriptions could not be loaded', () => {
        render(<EverGauzyIntegrationCard initialKeys={[KEY]} apiUrl={null} webhooks={null} />);
        expect(screen.getByText('webhooksUnavailable')).toBeInTheDocument();
    });
});
