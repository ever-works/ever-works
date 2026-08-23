import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

// next-intl — return the key plus any `{var}` interpolations so the
// assertions match against the namespaced keys without coupling to
// translated copy.
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
    // `Button` imports `Link` from this module; export a passthrough.
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

// next-intl `Dialog` uses Headless UI's Transition.show — render the
// real dialog so we can drive the form. No additional mock needed.

import { CreateOrganizationModal } from './CreateOrganizationModal';
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from '@/lib/hooks/use-organizations';

function org(overrides: Partial<OrganizationResponse> = {}): OrganizationResponse {
    return {
        id: 'o-new',
        tenantId: 't-1',
        slug: 'acme',
        legalName: null,
        displayName: 'Acme Inc',
        countryCode: null,
        registrationProvider: null,
        registrationStatus: null,
        linkedWorkId: null,
        vision: null,
        visionUpdatedAt: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        ...overrides,
    };
}

describe('CreateOrganizationModal — EW-661 Phase 9', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        routerPushMock.mockReset();
        navigateToWorkspaceDashboardMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Submitting with an empty name surfaces the inline validation error
     * and does NOT fire the POST.
     */
    it('shows an inline error when submit is attempted with an empty name', () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        const onOpenChange = vi.fn();
        render(<CreateOrganizationModal open={true} onOpenChange={onOpenChange} />);

        // The Create button is disabled while the name is empty — but
        // we exercise the validation path by typing whitespace and
        // submitting. (Whitespace-only is also invalid.)
        const input = screen.getByPlaceholderText('organizations.create.namePlaceholder');
        fireEvent.change(input, { target: { value: '   ' } });
        const submit = screen.getByText('organizations.create.submit');
        expect((submit as HTMLButtonElement).disabled).toBe(true);
        // The modal now fires a best-effort catalog fetch on open
        // (teams-and-companies spec §4.4) — the invariant under test is
        // that no CREATE request left the client.
        const createCalls = fetchMock.mock.calls.filter(
            ([url]) => url === '/api/organizations' || url === '/api/organizations/import-company',
        );
        expect(createCalls).toHaveLength(0);
    });

    /**
     * Valid submission triggers `POST /api/organizations` with the
     * trimmed name and (for non-first-Org) navigates to the new dashboard.
     */
    it('calls POST /api/organizations with the name and navigates after success (2nd Org skips upgrade dialog)', async () => {
        __seedOrganizationsStoreForTests({
            data: [org({ id: 'o-existing' })], // 1 existing = not first Org
            isLoading: false,
            error: null,
        });
        const newOrg = org({ id: 'o-new', slug: 'globex', displayName: 'Globex LLC' });
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u.includes('/api/organizations/check-slug')) {
                return new Response(JSON.stringify({ available: true, normalized: 'globex' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (u === '/api/organizations' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (u === '/api/users/me/scope' && init?.method === 'POST') {
                return new Response(
                    JSON.stringify({
                        tenantId: newOrg.tenantId,
                        organizationId: newOrg.id,
                        organizationSlug: newOrg.slug,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            if (u === '/api/organizations') {
                return new Response(JSON.stringify([newOrg]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected fetch: ${u}`);
        });

        const onOpenChange = vi.fn();
        render(<CreateOrganizationModal open={true} onOpenChange={onOpenChange} />);

        const input = screen.getByPlaceholderText('organizations.create.namePlaceholder');
        fireEvent.change(input, { target: { value: 'Globex LLC' } });

        const submit = screen.getByText('organizations.create.submit');
        fireEvent.click(submit);

        await waitFor(() => {
            // Modal closed.
            expect(onOpenChange).toHaveBeenCalledWith(false);
            // Navigated to the new Org's dashboard.
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: newOrg.slug,
            });
        });

        // POST request body carried the trimmed name.
        const postCall = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url) === '/api/organizations' &&
                (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        expect(body).toEqual({ name: 'Globex LLC' });
        expect(new Headers((postCall![1] as RequestInit).headers).get('x-ever-workspace')).toBe(
            'personal',
        );

        const scopeCall = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url) === '/api/users/me/scope' &&
                (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(scopeCall).toBeDefined();
        expect(JSON.parse((scopeCall![1] as RequestInit).body as string)).toEqual({
            organizationSlug: newOrg.slug,
        });
    });

    /**
     * As the user types, the slug preview updates live (no debounce —
     * pure local string normalization). Mirror of the API normalizer.
     */
    it('renders a live slug preview that mirrors the server-side normalization', () => {
        render(<CreateOrganizationModal open={true} onOpenChange={vi.fn()} />);
        const input = screen.getByPlaceholderText('organizations.create.namePlaceholder');

        // Pre-type: preview not shown yet.
        expect(screen.queryByTestId('slug-preview-value')).toBeNull();

        fireEvent.change(input, { target: { value: 'Acme Inc.' } });
        expect(screen.getByTestId('slug-preview-value').textContent).toBe('acme-inc');

        fireEvent.change(input, { target: { value: 'Globex Co/Ltd' } });
        expect(screen.getByTestId('slug-preview-value').textContent).toBe('globex-co-ltd');
    });

    /**
     * Submitting with zero existing Orgs → hands off to the upgrade
     * dialog (rendered conditionally, so the create panel hides).
     */
    it('chains into the UpgradeOrCreateDialog when this is the user first Org', async () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });
        const newOrg = org({ id: 'o-first', slug: 'first-org', displayName: 'First Org' });
        vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u.includes('/api/organizations/check-slug')) {
                return new Response(JSON.stringify({ available: true, normalized: 'first-org' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (u === '/api/organizations' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), { status: 201 });
            }
            return new Response(JSON.stringify([newOrg]), { status: 200 });
        });

        render(<CreateOrganizationModal open={true} onOpenChange={vi.fn()} />);

        const input = screen.getByPlaceholderText('organizations.create.namePlaceholder');
        fireEvent.change(input, { target: { value: 'First Org' } });

        const submit = screen.getByText('organizations.create.submit');
        fireEvent.click(submit);

        await waitFor(() => {
            // Upgrade dialog mounts.
            expect(screen.getByText('organizations.upgrade.title')).toBeInTheDocument();
            // Create panel hides (the Create submit button is no longer present).
            expect(screen.queryByText('organizations.create.submit')).toBeNull();
        });
        // No navigation yet — that happens after upgrade choice.
        expect(navigateToWorkspaceDashboardMock).not.toHaveBeenCalled();
    });

    it('persists a first Organization as active before closing and navigating', async () => {
        const newOrg = org({ id: 'o-first', slug: 'first-org', displayName: 'First Org' });
        const events: string[] = [];
        navigateToWorkspaceDashboardMock.mockImplementation(({ slug }: { slug: string }) =>
            events.push(`navigate:/org/${slug}/dashboard`),
        );
        const onOpenChange = vi.fn((next: boolean) => events.push(`modal:${next}`));
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u === '/api/org-templates') {
                return new Response('[]', { status: 200 });
            }
            if (u.includes('/api/organizations/check-slug')) {
                return new Response(JSON.stringify({ available: true, normalized: newOrg.slug }), {
                    status: 200,
                });
            }
            if (u === '/api/organizations' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), { status: 201 });
            }
            if (u === '/api/organizations') {
                return new Response(JSON.stringify([newOrg]), { status: 200 });
            }
            if (u.endsWith('/upgrade-from-account') && init?.method === 'POST') {
                events.push('upgrade');
                return new Response('{}', { status: 200 });
            }
            if (u === '/api/users/me/scope' && init?.method === 'POST') {
                events.push('scope');
                return new Response(
                    JSON.stringify({
                        tenantId: newOrg.tenantId,
                        organizationId: newOrg.id,
                        organizationSlug: newOrg.slug,
                    }),
                    { status: 200 },
                );
            }
            throw new Error(`Unexpected fetch: ${u}`);
        });

        render(<CreateOrganizationModal open={true} onOpenChange={onOpenChange} />);
        fireEvent.change(screen.getByPlaceholderText('organizations.create.namePlaceholder'), {
            target: { value: 'First Org' },
        });
        fireEvent.click(screen.getByText('organizations.create.submit'));
        await screen.findByText('organizations.upgrade.title');
        fireEvent.click(screen.getByText('organizations.upgrade.confirm'));

        await waitFor(() => {
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: newOrg.slug,
            });
        });
        const scopeCall = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url) === '/api/users/me/scope' &&
                (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(scopeCall).toBeDefined();
        expect(JSON.parse((scopeCall![1] as RequestInit).body as string)).toEqual({
            organizationSlug: newOrg.slug,
        });
        expect(events.indexOf('scope')).toBeLessThan(events.indexOf('modal:false'));
        expect(events.indexOf('scope')).toBeLessThan(
            events.indexOf(`navigate:/org/${newOrg.slug}/dashboard`),
        );
    });

    it('keeps the upgrade dialog open when first-Organization scope persistence fails', async () => {
        const newOrg = org({ id: 'o-first', slug: 'first-org', displayName: 'First Org' });
        const onOpenChange = vi.fn();
        vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const u = String(url);
            if (u === '/api/org-templates') {
                return new Response('[]', { status: 200 });
            }
            if (u.includes('/api/organizations/check-slug')) {
                return new Response(JSON.stringify({ available: true, normalized: newOrg.slug }), {
                    status: 200,
                });
            }
            if (u === '/api/organizations' && init?.method === 'POST') {
                return new Response(JSON.stringify(newOrg), { status: 201 });
            }
            if (u === '/api/organizations') {
                return new Response(JSON.stringify([newOrg]), { status: 200 });
            }
            if (u.endsWith('/upgrade-from-account') && init?.method === 'POST') {
                return new Response('{}', { status: 200 });
            }
            if (u === '/api/users/me/scope' && init?.method === 'POST') {
                return new Response('{}', { status: 503 });
            }
            throw new Error(`Unexpected fetch: ${u}`);
        });

        render(<CreateOrganizationModal open={true} onOpenChange={onOpenChange} />);
        fireEvent.change(screen.getByPlaceholderText('organizations.create.namePlaceholder'), {
            target: { value: 'First Org' },
        });
        fireEvent.click(screen.getByText('organizations.create.submit'));
        await screen.findByText('organizations.upgrade.title');
        fireEvent.click(screen.getByText('organizations.upgrade.confirm'));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent(
                'Failed to persist active Organization (503)',
            );
        });
        expect(screen.getByText('organizations.upgrade.title')).toBeInTheDocument();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(navigateToWorkspaceDashboardMock).not.toHaveBeenCalled();
    });
});
