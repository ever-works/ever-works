import type { APIRequestContext } from '@playwright/test';

/**
 * API helpers for e2e tests. Use these to set up state quickly without
 * driving the UI (much faster than UI-based setup).
 *
 * All helpers default to the env-overridable API base URL.
 */

export const API_BASE = process.env.API_URL || 'http://localhost:3100';

export interface RegisteredUser {
    name: string;
    email: string;
    password: string;
    access_token: string;
    refresh_token?: string;
    user: { id: string; email: string; username?: string };
}

/**
 * Generate a unique user record (not yet registered).
 */
export function makeTestUser(prefix = 'e2e'): {
    name: string;
    email: string;
    password: string;
} {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return {
        name: `${prefix} User ${suffix}`,
        email: `${prefix}-${suffix}@test.local`,
        password: 'TestPass1!secure',
    };
}

/**
 * Register a brand-new user via API and return the registered user
 * including auth tokens.
 */
export async function registerUserViaAPI(
    request: APIRequestContext,
    overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<RegisteredUser> {
    const base = makeTestUser();
    const u = { ...base, ...overrides };

    const res = await request.post(`${API_BASE}/api/auth/register`, {
        data: { username: u.name, email: u.email, password: u.password },
    });
    if (!res.ok()) {
        const body = await res.text();
        throw new Error(`registerUserViaAPI failed (${res.status()}): ${body}`);
    }
    const json = await res.json();
    return {
        name: u.name,
        email: u.email,
        password: u.password,
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        user: json.user,
    };
}

/**
 * Login an existing user via API.
 */
export async function loginViaAPI(
    request: APIRequestContext,
    credentials: { email: string; password: string },
): Promise<{ access_token: string; refresh_token?: string }> {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: credentials,
    });
    if (!res.ok()) {
        const body = await res.text();
        throw new Error(`loginViaAPI failed (${res.status()}): ${body}`);
    }
    return res.json();
}

/**
 * Authenticated GET request shortcut.
 *
 * This carries NO scope header, which since 8f28edca0 means the request runs in
 * the PERSONAL scope — that is the contract for an unprefixed bare-Bearer call,
 * not an oversight. Reads will not see Organization-stamped rows and writes land
 * unstamped. When a request is meant to act inside an Organization, use
 * {@link orgScopedHeaders} instead of adding a header at the call site.
 */
export function authedHeaders(token: string): { Authorization: string } {
    return { Authorization: `Bearer ${token}` };
}

/**
 * Authenticated request headers bound to an Organization scope.
 *
 * An Organization scope requires either this explicit `X-Scope-Slug` header or an
 * `/api/<slug>/…` path; the API deliberately refuses to infer one from the user's
 * last-active Organization, which is what keeps two tabs on different Orgs
 * isolated. See `apps/api/src/scope/session-scope.guard.ts`.
 */
export function orgScopedHeaders(
    token: string,
    orgSlug: string,
): { Authorization: string; 'X-Scope-Slug': string } {
    return { ...authedHeaders(token), 'X-Scope-Slug': orgSlug };
}

/**
 * Create a Work via the API. Returns the parsed response (caller can pull
 * `work.id` out of it).
 */
export async function createWorkViaAPI(
    request: APIRequestContext,
    token: string,
    payload: {
        name: string;
        slug?: string;
        description?: string;
    },
): Promise<{ id: string; raw: unknown }> {
    const slug = payload.slug || payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: payload.name,
            slug,
            description: payload.description || `e2e ${payload.name}`,
            organization: false,
        },
    });
    if (!res.ok()) {
        const body = await res.text();
        throw new Error(`createWorkViaAPI failed (${res.status()}): ${body}`);
    }
    const json = await res.json();
    const id = json?.work?.id ?? json?.id ?? json?.data?.id ?? json?.work?.work_id ?? '';
    return { id, raw: json };
}

/**
 * Build the URL for a given API path.
 */
export function apiUrl(path: string): string {
    if (path.startsWith('http')) return path;
    return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
