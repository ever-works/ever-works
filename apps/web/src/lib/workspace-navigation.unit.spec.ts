import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigateToWorkspaceDashboard, persistActiveOrganization } from './workspace-navigation';

describe('navigateToWorkspaceDashboard', () => {
    it('performs a canonical same-origin document navigation for an Organization', () => {
        const assign = vi.fn();

        navigateToWorkspaceDashboard(
            { kind: 'organization', slug: 'ever' },
            { origin: 'https://works.example', assign },
        );

        expect(assign).toHaveBeenCalledWith('https://works.example/org/ever/dashboard');
    });

    it('uses the explicit unprefixed personal dashboard contract', () => {
        const assign = vi.fn();

        navigateToWorkspaceDashboard(
            { kind: 'personal' },
            { origin: 'https://works.example', assign },
        );

        expect(assign).toHaveBeenCalledWith('https://works.example/dashboard');
    });
});

describe('persistActiveOrganization', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('persists the exact Organization slug with the scoped browser transport', async () => {
        window.history.replaceState({}, '', '/org/ever/works');
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            Response.json({ organizationSlug: 'new-company' }, { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await persistActiveOrganization('new-company');

        const [url, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(url).toBe('/api/users/me/scope');
        expect(new Headers(init.headers).get('x-ever-workspace')).toBe('org:ever');
        expect(JSON.parse(String(init.body))).toEqual({ organizationSlug: 'new-company' });
    });

    it('rejects a failed membership-validated persistence response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 })),
        );

        await expect(persistActiveOrganization('revoked-company')).rejects.toThrow(
            'Failed to persist active Organization (404)',
        );
    });

    it('rejects a response that persisted a different Organization', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ organizationSlug: 'yo' }, { status: 200 })),
        );

        await expect(persistActiveOrganization('ever')).rejects.toThrow(
            'The persisted active Organization did not match the selection',
        );
    });
});
