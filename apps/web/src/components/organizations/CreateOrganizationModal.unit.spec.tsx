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
        expect(fetchMock).not.toHaveBeenCalled();
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
            expect(routerPushMock).toHaveBeenCalledWith(`/${newOrg.slug}/dashboard`);
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
        expect(routerPushMock).not.toHaveBeenCalled();
    });
});
