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

const { navigateToWorkspaceDashboardMock } = vi.hoisted(() => ({
    navigateToWorkspaceDashboardMock: vi.fn(),
}));
vi.mock('@/lib/workspace-navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/workspace-navigation')>()),
    navigateToWorkspaceDashboard: navigateToWorkspaceDashboardMock,
}));

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/constants')>()),
    API_URL: 'http://api.example',
}));

import { RegisterCompanyDialog } from './RegisterCompanyDialog';
import { POST as registerCompanyPost } from '@/app/api/organizations/register-company/route';
import { POST as persistScopePost } from '@/app/api/users/me/scope/route';
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
        vision: null,
        visionUpdatedAt: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        ...overrides,
    };
}

interface UpstreamCall {
    kind: 'register' | 'persist';
    init: RequestInit;
}

function installRealBffBoundary(
    newOrganization: OrganizationResponse,
    options: { persistStatus?: number; events?: string[] } = {},
) {
    const upstreamCalls: UpstreamCall[] = [];
    const events = options.events ?? [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === '/api/organizations/register-company' && init?.method === 'POST') {
                const headers = new Headers(init.headers);
                // A hostile browser may try to send the internal API header.
                // The actual BFF handler below must overwrite it from the
                // browser selector derived from the visible URL.
                headers.set('x-scope-slug', 'spoofed-yo');
                return registerCompanyPost(
                    new Request('http://web.example/api/organizations/register-company', {
                        ...init,
                        headers,
                    }) as Parameters<typeof registerCompanyPost>[0],
                );
            }
            if (url === '/api/users/me/scope' && init?.method === 'POST') {
                const headers = new Headers(init.headers);
                headers.set('x-scope-slug', 'spoofed-yo');
                return persistScopePost(
                    new Request('http://web.example/api/users/me/scope', {
                        ...init,
                        headers,
                    }) as Parameters<typeof persistScopePost>[0],
                );
            }
            if (url === '/api/organizations' && init?.method === 'GET') {
                return Response.json([newOrganization]);
            }
            if (url === 'http://api.example/organizations/register-company') {
                events.push('register');
                upstreamCalls.push({ kind: 'register', init: init ?? {} });
                return Response.json(newOrganization, { status: 201 });
            }
            if (url === 'http://api.example/users/me/scope') {
                events.push('persist');
                upstreamCalls.push({ kind: 'persist', init: init ?? {} });
                const status = options.persistStatus ?? 200;
                if (status !== 200) {
                    return Response.json({ error: 'Membership revoked' }, { status });
                }
                return Response.json({
                    tenantId: newOrganization.tenantId,
                    organizationId: newOrganization.id,
                    organizationSlug: newOrganization.slug,
                });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }),
    );

    navigateToWorkspaceDashboardMock.mockImplementation(() => {
        events.push('navigate');
    });

    return { upstreamCalls, events };
}

describe('RegisterCompanyDialog — EW-662 Phase 10', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        routerPushMock.mockReset();
        navigateToWorkspaceDashboardMock.mockReset();
        window.history.replaceState({}, '', '/dashboard');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
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
    it('uses the visible Organization scope, persists, then canonically navigates after a later-Org create', async () => {
        __seedOrganizationsStoreForTests({
            data: [org({ id: 'o-existing', slug: 'existing' })],
            isLoading: false,
            error: null,
        });
        window.history.replaceState({}, '', '/org/ever/works');
        const newOrg = org({ id: 'o-2', slug: 'globex', displayName: 'Globex LLC' });
        const { upstreamCalls, events } = installRealBffBoundary(newOrg);

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
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: newOrg.slug,
            });
        });

        expect(routerPushMock).not.toHaveBeenCalled();
        expect(events).toEqual(['register', 'persist', 'navigate']);
        const registerCall = upstreamCalls.find((call) => call.kind === 'register');
        const persistCall = upstreamCalls.find((call) => call.kind === 'persist');
        expect(new Headers(registerCall?.init.headers).get('x-scope-slug')).toBe('ever');
        expect(new Headers(persistCall?.init.headers).get('x-scope-slug')).toBe('ever');
        const body = JSON.parse(String(registerCall?.init.body));
        // countryCode is sent raw; the server normalizes (single source of
        // truth — Greptile P2 on PR #1071).
        expect(body).toEqual({ name: 'Globex LLC', countryCode: 'de' });
        expect(JSON.parse(String(persistCall?.init.body))).toEqual({
            organizationSlug: newOrg.slug,
        });
    });

    /**
     * Regression — first-org classification races the initial org-list
     * fetch. While `isLoading` is true the store's `data` is still `[]`, so
     * an existing-org user must NOT be able to submit (and be misclassified
     * as first-org → routed into upgrade-from-account, which 409s for 2nd+
     * orgs). Submit stays gated until the fetch settles. (Greptile + Codex
     * P1 on PR #1071.)
     */
    it('gates submit while the org list is still loading', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: true, error: null });
        const fetchMock = vi.spyOn(global, 'fetch');
        render(<RegisterCompanyDialog open={true} onOpenChange={vi.fn()} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'Acme Inc.' },
        });
        const submit = screen.getByTestId('register-company-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.click(submit);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * First-Org path — after a successful POST, hand off to the
     * UpgradeOrCreateDialog so the user can pick Upgrade vs Empty.
     */
    it('chains into the UpgradeOrCreateDialog when this is the user first Org', async () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        const newOrg = org({ id: 'o-first', slug: 'first-co', displayName: 'First Company' });
        installRealBffBoundary(newOrg);

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

    it('persists personal scope before completing a first-Org empty create and navigating', async () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        window.history.replaceState({}, '', '/dashboard');
        const newOrg = org({ id: 'o-first', slug: 'first-co', displayName: 'First Company' });
        const { upstreamCalls, events } = installRealBffBoundary(newOrg);
        const onOpenChange = vi.fn();
        render(<RegisterCompanyDialog open={true} onOpenChange={onOpenChange} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'First Company' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));
        await screen.findByText('organizations.upgrade.title');
        fireEvent.click(document.getElementById('upgrade-or-create-empty') as HTMLInputElement);
        fireEvent.click(screen.getByText('organizations.upgrade.confirm'));

        await waitFor(() =>
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: newOrg.slug,
            }),
        );
        expect(events).toEqual(['register', 'persist', 'navigate']);
        for (const call of upstreamCalls) {
            expect(new Headers(call.init.headers).get('x-scope-slug')).toBe('@personal');
        }
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('does not close or navigate when active-Organization persistence rejects membership', async () => {
        __seedOrganizationsStoreForTests({
            data: [org({ id: 'o-existing', slug: 'ever' })],
            isLoading: false,
            error: null,
        });
        window.history.replaceState({}, '', '/org/ever/works');
        const newOrg = org({ id: 'o-revoked', slug: 'revoked-co' });
        const { events } = installRealBffBoundary(newOrg, { persistStatus: 404 });
        const onOpenChange = vi.fn();
        render(<RegisterCompanyDialog open={true} onOpenChange={onOpenChange} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'Revoked Company' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));

        await screen.findByText('Failed to persist active Organization (404)');
        expect(events).toEqual(['register', 'persist']);
        expect(navigateToWorkspaceDashboardMock).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('keeps the first-Org completion dialog open when persistence fails', async () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        const newOrg = org({ id: 'o-first', slug: 'first-co' });
        const { events } = installRealBffBoundary(newOrg, { persistStatus: 404 });
        const onOpenChange = vi.fn();
        render(<RegisterCompanyDialog open={true} onOpenChange={onOpenChange} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'First Company' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));
        await screen.findByText('organizations.upgrade.title');
        fireEvent.click(document.getElementById('upgrade-or-create-empty') as HTMLInputElement);
        fireEvent.click(screen.getByText('organizations.upgrade.confirm'));

        await screen.findByText('Failed to persist active Organization (404)');
        expect(events).toEqual(['register', 'persist']);
        expect(screen.getByText('organizations.upgrade.title')).toBeInTheDocument();
        expect(navigateToWorkspaceDashboardMock).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('proves register-company BFF rejects a missing browser selector before upstream', async () => {
        const newOrg = org();
        const { upstreamCalls } = installRealBffBoundary(newOrg);
        const response = await registerCompanyPost(
            new Request('http://web.example/api/organizations/register-company', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-scope-slug': 'spoofed-yo',
                },
                body: JSON.stringify({ name: 'Must fail closed' }),
            }) as Parameters<typeof registerCompanyPost>[0],
        );

        expect(response.status).toBe(400);
        expect(upstreamCalls).toHaveLength(0);
    });

    /**
     * Regression — when the org-list GET errored, `organizations` is `[]`
     * but unreliable, so the user must NOT be treated as first-org (which
     * would route into upgrade-from-account → 409 for 2nd+ orgs). A
     * successful register navigates straight to the dashboard instead.
     * (Greptile P2 on PR #1077.)
     */
    it('does not misclassify as first-org when the org-list fetch errored', async () => {
        __seedOrganizationsStoreForTests({
            data: [],
            isLoading: false,
            error: new Error('GET /api/organizations failed'),
        });
        const newOrg = org({ id: 'o-3', slug: 'initech', displayName: 'Initech' });
        installRealBffBoundary(newOrg);

        const onOpenChange = vi.fn();
        render(<RegisterCompanyDialog open={true} onOpenChange={onOpenChange} />);

        fireEvent.change(screen.getByTestId('register-company-name'), {
            target: { value: 'Initech' },
        });
        fireEvent.click(screen.getByTestId('register-company-submit'));

        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: newOrg.slug,
            });
        });
        // The upgrade dialog (first-org path) must NOT appear.
        expect(screen.queryByText('organizations.upgrade.title')).toBeNull();
    });
});
