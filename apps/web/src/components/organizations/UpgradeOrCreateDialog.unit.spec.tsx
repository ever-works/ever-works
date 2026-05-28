import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, args?: Record<string, string | number>) => {
        const path = `${ns}.${key}`;
        if (!args) return path;
        const interp = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${path} ${interp}`;
    },
}));

// Button (used in DialogFooter) imports `Link` from `@/i18n/navigation`.
// Short-circuit the locale-aware navigation module so the test doesn't
// pull in next-intl's createNavigation chain.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode; href?: string }) =>
        React.createElement('a', rest as Record<string, unknown>, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

import { UpgradeOrCreateDialog } from './UpgradeOrCreateDialog';

const fakeOrg: OrganizationResponse = {
    id: 'o-test-1',
    tenantId: 't-1',
    slug: 'acme',
    legalName: null,
    displayName: 'Acme Inc',
    countryCode: null,
    registrationProvider: null,
    registrationStatus: null,
    linkedWorkId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
};

describe('UpgradeOrCreateDialog — EW-661 Phase 9', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Upgrade radio is the default selection and gets focus on open
     * (spec §5.2 — "Default option: Upgrade current account").
     */
    it('defaults to the Upgrade radio and focuses it on open', async () => {
        render(<UpgradeOrCreateDialog open={true} organization={fakeOrg} onClose={vi.fn()} />);

        const upgradeRadio = screen.getByLabelText(/upgrade.upgradeOption/i, {
            exact: false,
        }) as HTMLInputElement;
        expect(upgradeRadio.checked).toBe(true);

        const emptyRadio = screen.getByLabelText(/upgrade.emptyOption/i, {
            exact: false,
        }) as HTMLInputElement;
        expect(emptyRadio.checked).toBe(false);

        // Focused element is the Upgrade radio (focus is scheduled with
        // setTimeout(0), so wait for it).
        await waitFor(() => {
            expect(document.activeElement).toBe(upgradeRadio);
        });
    });

    /**
     * Picking "Empty" + confirm dispatches NO fetch and reports
     * `didUpgrade=false` back to the parent.
     */
    it('empty branch: calls onClose(false) without firing the upgrade API', () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        const onClose = vi.fn();
        render(<UpgradeOrCreateDialog open={true} organization={fakeOrg} onClose={onClose} />);

        const emptyRadio = screen.getByLabelText(/upgrade.emptyOption/i, {
            exact: false,
        }) as HTMLInputElement;
        fireEvent.click(emptyRadio);
        expect(emptyRadio.checked).toBe(true);

        const confirm = screen.getByText('organizations.upgrade.confirm');
        fireEvent.click(confirm);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith(false);
    });

    /**
     * Picking "Upgrade" + confirm POSTs to the upgrade-from-account
     * endpoint and reports `didUpgrade=true` on success.
     */
    it('upgrade branch: POSTs to /upgrade-from-account and onClose(true) on success', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    organizationId: fakeOrg.id,
                    tenantId: fakeOrg.tenantId,
                    tierARowsUpdated: 0,
                    tierBRowsUpdated: 0,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const onClose = vi.fn();
        render(<UpgradeOrCreateDialog open={true} organization={fakeOrg} onClose={onClose} />);

        const confirm = screen.getByText('organizations.upgrade.confirm');
        fireEvent.click(confirm);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                `/api/organizations/${fakeOrg.id}/upgrade-from-account`,
                expect.objectContaining({ method: 'POST' }),
            );
            expect(onClose).toHaveBeenCalledWith(true);
        });
    });

    /**
     * 409 UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS — first-Org-only
     * guard fired on the API side. The dialog surfaces a generic
     * "not available" message and stays open.
     */
    it('handles 409 UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS gracefully', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: 'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS',
                    message: 'Already past the first-Org window',
                }),
                { status: 409, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const onClose = vi.fn();
        render(<UpgradeOrCreateDialog open={true} organization={fakeOrg} onClose={onClose} />);

        const confirm = screen.getByText('organizations.upgrade.confirm');
        fireEvent.click(confirm);

        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toContain(
                'organizations.upgrade.errors.notAvailable',
            );
        });
        // Did NOT close — user is still on the dialog so they can pick
        // "Empty" or dismiss.
        expect(onClose).not.toHaveBeenCalled();
    });
});
