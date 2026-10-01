import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T26 — where "Also sign out of Ever ID" comes back (S7, FR-36).
 *
 * A matching `state` clears the cookies and shows the S7 notice through the
 * non-secret `?signedOut=ever-id` marker; an absent or mismatched one degrades
 * silently to the plain sign-in page and touches nothing else. The remembered
 * state is cleared on every path.
 */

const jar = vi.hoisted(() => {
    const values = new Map<string, string>();
    const deletes: string[] = [];
    return {
        values,
        deletes,
        reset() {
            values.clear();
            deletes.length = 0;
        },
        store: {
            get: (name: string) =>
                values.has(name) ? { name, value: values.get(name)! } : undefined,
            set: (name: string, value: string) => {
                values.set(name, value);
            },
            delete: (arg: string | { name: string }) => {
                const name = typeof arg === 'string' ? arg : arg.name;
                deletes.push(name);
                values.delete(name);
            },
        },
    };
});

const { redirectMock, removeAuthAccessCookiesMock } = vi.hoisted(() => ({
    redirectMock: vi.fn(),
    removeAuthAccessCookiesMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => jar.store }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth', () => ({ removeAuthAccessCookies: removeAuthAccessCookiesMock }));

function request(state?: string) {
    const url = new URL('https://app.example/api/auth/ever-id/logout-return');
    if (state !== undefined) url.searchParams.set('state', state);
    return { nextUrl: url } as unknown as import('next/server').NextRequest;
}

async function run(state?: string): Promise<string> {
    const { GET } = await import('./route');
    await GET(request(state));
    expect(redirectMock).toHaveBeenCalledTimes(1);
    return redirectMock.mock.calls[0][0].href;
}

describe('GET /api/auth/ever-id/logout-return', () => {
    beforeEach(() => {
        jar.reset();
        redirectMock.mockReset();
        removeAuthAccessCookiesMock.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('a matching state signs the browser out and shows the S7 notice', async () => {
        jar.values.set('ew_everid_logout_state', 'state-123');

        const href = await run('state-123');

        expect(href).toBe('/login?signedOut=ever-id');
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
        expect(jar.deletes).toContain('ew_everid_logout_state');
        expect(href).not.toContain('state-123');
    });

    it('a mismatched state degrades silently to the plain sign-in page', async () => {
        jar.values.set('ew_everid_logout_state', 'state-123');

        const href = await run('state-999');

        expect(href).toBe('/login');
        expect(removeAuthAccessCookiesMock).not.toHaveBeenCalled();
        expect(jar.deletes).toContain('ew_everid_logout_state');
    });

    it('a state that only shares a prefix does not match', async () => {
        jar.values.set('ew_everid_logout_state', 'state-123');

        await expect(run('state-12')).resolves.toBe('/login');
    });

    it('no remembered state → plain sign-in, whatever the address says', async () => {
        const href = await run('state-123');

        expect(href).toBe('/login');
        expect(removeAuthAccessCookiesMock).not.toHaveBeenCalled();
    });

    it('no state in the address → plain sign-in, and the remembered one is spent', async () => {
        jar.values.set('ew_everid_logout_state', 'state-123');

        const href = await run();

        expect(href).toBe('/login');
        expect(jar.values.has('ew_everid_logout_state')).toBe(false);
    });

    it('an implausibly long state never matches', async () => {
        const long = 's'.repeat(600);
        jar.values.set('ew_everid_logout_state', long);

        await expect(run(long)).resolves.toBe('/login');
    });
});
