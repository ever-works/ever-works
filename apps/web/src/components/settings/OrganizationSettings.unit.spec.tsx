import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ResolvedMergePolicy } from '@ever-works/contracts';
import type { OrganizationResponse } from '@ever-works/contracts/api';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode; href?: string }) =>
        React.createElement('a', rest as Record<string, unknown>, children),
}));

vi.mock('./OrganizationMembersSection', () => ({
    OrganizationMembersSection: () => null,
}));

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/constants')>()),
    API_URL: 'http://api.example',
}));

import { PATCH } from '@/app/api/organizations/[id]/route';
import { OrganizationSettings } from './OrganizationSettings';
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from '@/lib/hooks/use-organizations';

const ORGANIZATION: OrganizationResponse = {
    id: 'org-ever',
    tenantId: 'tenant-ever',
    slug: 'ever',
    legalName: 'Ever Co',
    displayName: 'Ever',
    countryCode: 'ES',
    registrationProvider: 'manual',
    registrationStatus: 'registered',
    linkedWorkId: null,
    vision: null,
    visionUpdatedAt: null,
    mergePolicy: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
};

const RESOLUTION: ResolvedMergePolicy = {
    policy: {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: false,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main'],
    },
    source: 'default',
    chain: [{ scope: 'default', id: null, fields: [] }],
};

interface UpstreamCall {
    url: string;
    init: RequestInit;
}

function installRealOrganizationPatchBoundary() {
    const upstreamCalls: UpstreamCall[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('/api/merge-policy/resolve?')) {
                return Response.json(RESOLUTION);
            }
            if (url === '/api/organizations' && init?.method === 'GET') {
                return Response.json([ORGANIZATION]);
            }
            if (url === `/api/organizations/${ORGANIZATION.id}` && init?.method === 'PATCH') {
                const headers = new Headers(init.headers);
                // Simulate a hostile browser-supplied internal API header. The
                // real BFF must discard it in favour of the visible tab scope.
                headers.set('x-scope-slug', 'yo');
                return PATCH(
                    new Request(`http://web.example${url}`, { ...init, headers }) as Parameters<
                        typeof PATCH
                    >[0],
                    { params: Promise.resolve({ id: ORGANIZATION.id }) },
                );
            }
            if (url === `http://api.example/organizations/${ORGANIZATION.id}`) {
                const call = { url, init: init ?? {} };
                upstreamCalls.push(call);
                const body = JSON.parse(String(init?.body)) as Partial<OrganizationResponse>;
                return Response.json({ ...ORGANIZATION, ...body }, { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }),
    );

    return upstreamCalls;
}

async function renderLoadedSettings() {
    render(<OrganizationSettings />);
    await waitFor(() => expect(screen.getByTestId('organization-settings')).toBeInTheDocument());
    await waitFor(() =>
        expect(screen.getByTestId('organization-merge-policy-summary')).not.toHaveTextContent(
            'Loading the effective policy',
        ),
    );
}

describe('OrganizationSettings scoped BFF writes', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        __seedOrganizationsStoreForTests({
            data: [ORGANIZATION],
            isLoading: false,
            error: null,
        });
        window.history.replaceState({}, '', '/org/ever/settings/organization');
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it('saves Vision through the real BFF with visible scope overriding spoofed scope', async () => {
        const upstreamCalls = installRealOrganizationPatchBoundary();
        await renderLoadedSettings();

        fireEvent.change(screen.getByTestId('organization-settings-vision-input'), {
            target: { value: 'Build humane autonomous companies.' },
        });
        fireEvent.click(screen.getByTestId('organization-settings-vision-save'));

        await waitFor(() => expect(upstreamCalls).toHaveLength(1));
        expect(new Headers(upstreamCalls[0].init.headers).get('x-scope-slug')).toBe('ever');
        expect(JSON.parse(String(upstreamCalls[0].init.body))).toEqual({
            vision: 'Build humane autonomous companies.',
        });
    });

    it('saves merge policy through the same real scoped BFF boundary', async () => {
        const upstreamCalls = installRealOrganizationPatchBoundary();
        await renderLoadedSettings();

        fireEvent.click(screen.getByTestId('organization-merge-policy-requireHumanApproval'));

        await waitFor(() => expect(upstreamCalls).toHaveLength(1));
        expect(new Headers(upstreamCalls[0].init.headers).get('x-scope-slug')).toBe('ever');
        expect(JSON.parse(String(upstreamCalls[0].init.body))).toEqual({
            mergePolicy: { requireHumanApproval: true },
        });
    });

    it('proves the real BFF fails closed when a browser selector is absent', async () => {
        const upstreamCalls = installRealOrganizationPatchBoundary();
        const response = await PATCH(
            new Request(`http://web.example/api/organizations/${ORGANIZATION.id}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-scope-slug': 'yo',
                },
                body: JSON.stringify({ vision: 'Must not cross the boundary' }),
            }) as Parameters<typeof PATCH>[0],
            { params: Promise.resolve({ id: ORGANIZATION.id }) },
        );

        expect(response.status).toBe(400);
        expect(upstreamCalls).toHaveLength(0);
    });
});
