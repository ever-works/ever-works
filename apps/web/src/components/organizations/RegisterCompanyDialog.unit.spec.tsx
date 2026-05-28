import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

// next-intl — return the key plus any `{var}` interpolations so the
// assertions match against the namespaced keys without coupling to
// translated copy. Same pattern as the Phase 9 modal tests.
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

const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode; href?: string }) =>
        React.createElement('a', rest as Record<string, unknown>, children),
    useRouter: () => ({
        push: routerPushMock,
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

import { RegisterCompanyDialog } from './RegisterCompanyDialog';
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from '@/lib/hooks/use-organizations';

function org(overrides: Partial<OrganizationResponse> = {}): OrganizationResponse {
    return {
        id: 'o-new',
        tenantId: 't-1',
        slug: 'acme',
        legalName: 'Acme Inc.',
        displayName: 'Acme Inc.',
        countryCode: 'US',
        registrationProvider: 'manual',
        registrationStatus: 'registered',
        linkedWorkId: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        ...overrides,
    };
}

describe('RegisterCompanyDialog — EW-662 Phase 10', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        routerPushMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('disables submit when name is empty and never fires the POST', () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        render(<RegisterCompanyDialog open={true} onOpenChange={vi.fn()} />);

        const submit = screen.getByTestId('register-company-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.click(submit);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an invalid country code inline (no POST fired)', () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        render(<RegisterCompanyDialog open={true} onOpenChange={vi.fn()} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'Acme Inc.' },
        });
        fireEvent.change(screen.getByTestId('register-company-country'), {
            target: { value: 'USA' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(
            screen.getByText('organizations.registerCompany.errors.countryCodeInvalid'),
        ).toBeTruthy();
    });

    /**
     * Happy path — 2nd Org (skips the upgrade dialog). Submits to the
     * register-company endpoint, navigates to the new Org's dashboard,
     * and closes the modal.
     */
    it('calls POST /api/organizations/register-company and navigates after success (2nd Org)', async () => {
        __seedOrganizationsStoreForTests({
            data: [org({ id: 'o-existing', slug: 'existing' })],
            isLoading: false,
            error: null,
        });
        const newOrg = org({ id: 'o-2', slug: 'globex', displayName: 'Globex LLC' });
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u === '/api/organizations/register-company' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (u === '/api/organizations') {
                // best-effort `mutate()` after success.
                return new Response(JSON.stringify([newOrg]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${u}`);
        });

        const onOpenChange = vi.fn();
        render(<RegisterCompanyDialog open={true} onOpenChange={onOpenChange} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'Globex LLC' },
        });
        fireEvent.change(screen.getByTestId('register-company-country'), {
            target: { value: 'de' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));

        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
            expect(routerPushMock).toHaveBeenCalledWith(`/${newOrg.slug}/dashboard`);
        });

        const postCall = fetchMock.mock.calls.find(
            ([u, init]) =>
                String(u) === '/api/organizations/register-company' &&
                (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        // countryCode is auto-uppercased before submit.
        expect(body).toEqual({ name: 'Globex LLC', countryCode: 'DE' });
    });

    /**
     * First-Org path — after a successful POST, hand off to the
     * UpgradeOrCreateDialog so the user can pick Upgrade vs Empty.
     */
    it('chains into the UpgradeOrCreateDialog when this is the user first Org', async () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        const newOrg = org({ id: 'o-first', slug: 'first-co', displayName: 'First Company' });
        vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u === '/api/organizations/register-company' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), { status: 201 });
            }
            return new Response(JSON.stringify([newOrg]), { status: 200 });
        });

        render(<RegisterCompanyDialog open={true} onOpenChange={vi.fn()} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'First Company' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));

        // The UpgradeOrCreateDialog renders the `organizations.upgrade.title` key.
        await waitFor(() => {
            expect(screen.queryByText('organizations.upgrade.title')).toBeTruthy();
        });
        // No direct router navigation yet — the upgrade dialog owns the next step.
        expect(routerPushMock).not.toHaveBeenCalled();
    });
});
