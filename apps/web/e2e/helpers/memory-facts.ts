import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './api';
import { loginViaUI } from './auth';

/**
 * Memory facts (AW-07) — shared e2e helpers.
 *
 * ## Isolation
 *
 * Facts are workspace data, and one spec forgets EVERY fact in its workspace.
 * Running that against the shared seeded user would wipe facts another spec
 * is asserting on in a parallel worker. So every memory-facts flow runs on a
 * FRESH user signed into its OWN browser context — the same isolation
 * `flow-chat-history-ui.spec.ts` uses for its empty-state flow — and works in
 * that user's personal workspace (`/memory`), which the BFF scopes as
 * `personal`.
 *
 * ## API shapes (see `apps/api/src/memory-facts/memory-facts.controller.ts`)
 *
 *   POST /api/memory/facts            { body, pinned? }  → 201 MemoryFactDto
 *   GET  /api/memory/facts?q&status   → 200 { facts, total, counts, semantic }
 *   POST /api/memory/facts/forget-all { confirm: 'FORGET ALL' } → 200 { forgotten }
 */

export interface FreshMemoryUser {
    user: RegisteredUser;
    context: BrowserContext;
    page: Page;
}

export async function withFreshMemoryUser(
    browser: Browser,
    request: APIRequestContext,
    run: (fresh: FreshMemoryUser) => Promise<void>,
): Promise<void> {
    const user = await registerUserViaAPI(request);
    // A brand-new user trips the auto-open onboarding wizard, whose modal
    // intercepts clicks. Dismiss it server-side BEFORE the UI login (mirrors
    // global-setup). Best-effort: harmless on an API without the route.
    await request
        .post(`${API_BASE}/api/onboarding/dismiss`, { headers: authedHeaders(user.access_token) })
        .catch(() => undefined);

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
        await loginViaUI(page, { email: user.email, password: user.password });
        await run({ user, context, page });
    } finally {
        await context.close();
    }
}

export async function rememberViaAPI(
    request: APIRequestContext,
    token: string,
    body: string,
): Promise<{ id: string; body: string; status: string }> {
    const res = await request.post(`${API_BASE}/api/memory/facts`, {
        headers: authedHeaders(token),
        data: { body },
    });
    expect(res.status(), `remember body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

export async function listFactsViaAPI(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{
    facts: Array<{ id: string; body: string; status: string }>;
    counts: { active: number; proposed: number; forgotten: number; pinned: number };
    semantic: boolean;
}> {
    const res = await request.get(`${API_BASE}/api/memory/facts${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

export async function gotoMemoryFacts(page: Page): Promise<Locator> {
    await page.goto('/memory', { waitUntil: 'domcontentloaded' });
    const panel = page.getByTestId('memory-facts-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
}

/**
 * Click `control` until `expected` is visible.
 *
 * `/memory` is server-rendered, so its controls pass actionability checks
 * before React hydrates and attaches `onClick`; a click in that window is
 * silently dropped. Re-issue the click only while the target state is still
 * absent, so a click that did land is never undone (same remedy as
 * `flow-memory-ui-journey.spec.ts`).
 */
export async function clickUntilVisible(
    control: Locator,
    expected: Locator,
    timeout = 45_000,
): Promise<void> {
    await expect(control).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
        if (!(await expected.isVisible().catch(() => false))) {
            await control.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(expected).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout });
}

/**
 * Type a search until the panel reflects it (hydration-safe).
 *
 * `until` must be a state that only the SEARCH RESULT can produce — a row the
 * query excludes becoming hidden, the no-results block, the exact-words note.
 * A locator that is already true before the search (a row that is visible
 * anyway) would let a fill that landed before hydration, and so never
 * reached React, pass as if the search had run.
 */
export async function searchFacts(
    panel: Locator,
    query: string,
    until: Locator,
    state: 'visible' | 'hidden' = 'visible',
): Promise<void> {
    const search = panel.getByTestId('memory-facts-search');
    await expect(async () => {
        await search.fill('');
        await search.fill(query);
        if (state === 'visible') {
            await expect(until).toBeVisible({ timeout: 5_000 });
        } else {
            await expect(until).toBeHidden({ timeout: 5_000 });
        }
    }).toPass({ timeout: 45_000 });
}
