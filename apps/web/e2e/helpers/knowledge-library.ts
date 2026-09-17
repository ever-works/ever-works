import { expect, type Locator } from '@playwright/test';
import { API_BASE, authedHeaders, orgScopedHeaders } from './api';
import { loadSeededTestUser } from './seeded-test-user';

/**
 * Knowledge library e2e seeding.
 *
 * The library is an Organization's shelf, so every read and write here is
 * pinned with `X-Scope-Slug` — without it the API runs in the personal scope,
 * stamps nothing into the Organization, and the `/org/<slug>/memory?view=library`
 * page could never see the rows. `GET`/`POST /api/organizations` stay
 * bare-Bearer on purpose: both resolve from the user id.
 *
 * Seeding uses the shared seeded user (the same account the browser's
 * storageState is signed in as), so the Organization they own is one whose
 * shared folders they may manage.
 */

export interface LibrarySession {
    token: string;
    orgSlug: string;
}

export interface LibraryDoc {
    id: string;
    title: string;
    slug: string;
    path: string;
}

export function runStamp(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function libraryHeaders(session: LibrarySession): Record<string, string> {
    return {
        ...orgScopedHeaders(session.token, session.orgSlug),
        'content-type': 'application/json',
    };
}

export async function openLibrarySession(stamp: string): Promise<LibrarySession> {
    const creds = loadSeededTestUser();
    const login = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
    });
    if (!login.ok) throw new Error(`login failed ${login.status}: ${await login.text()}`);
    const token = ((await login.json()) as { access_token: string }).access_token;

    const orgsRes = await fetch(`${API_BASE}/api/organizations`, { headers: authedHeaders(token) });
    const orgs = orgsRes.ok ? ((await orgsRes.json()) as { slug?: string }[]) : [];
    let orgSlug = (Array.isArray(orgs) ? (orgs[0]?.slug ?? '') : '').trim();
    if (!orgSlug) {
        const created = await fetch(`${API_BASE}/api/organizations`, {
            method: 'POST',
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            body: JSON.stringify({ name: `Library Org ${stamp}` }),
        });
        if (!created.ok) {
            throw new Error(`org create failed ${created.status}: ${await created.text()}`);
        }
        orgSlug = (((await created.json()) as { slug?: string }).slug ?? '').trim();
    }
    if (!orgSlug) throw new Error('no Organization slug resolved for the seeded test user');
    return { token, orgSlug };
}

export async function createLibraryWork(
    session: LibrarySession,
    name: string,
    slug: string,
): Promise<string> {
    const res = await fetch(`${API_BASE}/api/works`, {
        method: 'POST',
        headers: libraryHeaders(session),
        body: JSON.stringify({
            name,
            slug,
            description: 'knowledge library e2e',
            organization: false,
        }),
    });
    if (!res.ok) throw new Error(`work create failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { work?: { id?: string }; id?: string };
    const id = body.work?.id ?? body.id;
    if (!id) throw new Error('work id missing from create response');
    return id;
}

export async function createLibraryDoc(
    session: LibrarySession,
    workId: string,
    input: { path: string; title: string; description?: string },
): Promise<LibraryDoc> {
    const res = await fetch(`${API_BASE}/api/works/${workId}/kb/documents`, {
        method: 'POST',
        headers: libraryHeaders(session),
        body: JSON.stringify({
            path: input.path,
            title: input.title,
            class: 'freeform',
            body: `# ${input.title}\n\nSeeded for the knowledge library.`,
            description: input.description ?? null,
            status: 'active',
        }),
    });
    if (!res.ok) throw new Error(`doc create failed ${res.status}: ${await res.text()}`);
    return (await res.json()) as LibraryDoc;
}

export async function createSharedFolder(
    session: LibrarySession,
    name: string,
    parentId?: string,
): Promise<{ id: string; name: string; path: string }> {
    const res = await fetch(`${API_BASE}/api/memory/files/folders`, {
        method: 'POST',
        headers: libraryHeaders(session),
        body: JSON.stringify({ name, scope: 'organization', ...(parentId ? { parentId } : {}) }),
    });
    if (!res.ok) throw new Error(`folder create failed ${res.status}: ${await res.text()}`);
    return (await res.json()) as { id: string; name: string; path: string };
}

export async function fileDocuments(
    session: LibrarySession,
    documentIds: string[],
    folderId: string | null,
): Promise<Response> {
    return fetch(`${API_BASE}/api/knowledge/documents/file`, {
        method: 'PATCH',
        headers: libraryHeaders(session),
        body: JSON.stringify({ documentIds, folderId }),
    });
}

/** The shelf row of one document, read straight from the API. */
export async function libraryRow(
    session: LibrarySession,
    docId: string,
): Promise<{ folderId: string | null; status: string } | null> {
    const res = await fetch(`${API_BASE}/api/knowledge/documents/${docId}`, {
        headers: libraryHeaders(session),
    });
    return res.ok ? ((await res.json()) as { folderId: string | null; status: string }) : null;
}

/**
 * Click `control` until `expected` is visible. `/memory` is server-rendered,
 * so a click can land before React attaches its handler and be dropped; the
 * suite's remedy is to re-issue the click only while the target state is
 * still absent (see `helpers/nav.ts`).
 */
export async function clickUntilVisible(
    control: Locator,
    expected: Locator,
    timeout = 45_000,
): Promise<void> {
    await expect(control).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
        if (!(await expected.isVisible().catch(() => false))) {
            await control.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(expected).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout });
}
