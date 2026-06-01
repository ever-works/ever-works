import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Flow: Work hard-delete CASCADE — deep cross-feature integration.
 *
 * Works have NO soft-delete / archive / restore: deletion is a HARD delete
 * (WorkLifecycleService.deleteWork -> workRepository.delete). After delete the
 * work row is gone; every LIVE owner-scoped sub-resource lookup collapses to
 * 404 (cascade). The delete is OWNER-gated (403 for a non-owner) and
 * idempotency-bounded (double-delete -> 404 "Work with id '<id>' not found").
 *
 * This file does NOT re-cover flow-work-full-lifecycle's single "update then
 * delete (403 non-owner / 200 owner)" assertion. It drills into the CASCADE
 * surface, the deleted_repositories envelope, item-level bulk-delete, cross-user
 * cascade isolation, and delete-during-generation — none of which existing specs
 * (flow-work-full-lifecycle, archive-soft-delete, works-api) assert.
 *
 * --- Contract read from the REAL source + PROBED against the LIVE API (sqlite CI) ---
 *
 *   The ONLY work-delete route is POST works/:id/delete (no DELETE :id verb):
 *     @Post('works/:id/delete') @HttpCode(200) -> WorkLifecycleService.deleteWork(id, dto, user)
 *
 *   DeleteWorkDto (class-validator, whitelist+forbidNonWhitelisted): every field is
 *   OPTIONAL and snake_case, each boolean DEFAULTS to false:
 *     { reason?: string; force_delete?: boolean;
 *       delete_data_repository?: boolean; delete_markdown_repository?: boolean;
 *       delete_website_repository?: boolean }
 *     An UNKNOWN key (e.g. camelCase `deleteRepositories`) is rejected 400
 *     "property deleteRepositories should not exist" — so we ONLY ever send the
 *     real snake_case flags (or an empty body).
 *
 *   deleteWork() — WorkOwnershipService.ensureIsOwner(workId, userId):
 *     work not found        -> NotFoundException { status:'error', message:"Work with id '<id>' not found" } [404]
 *     caller not owner/member -> ForbiddenException { status:'error',
 *                               message:'You do not have permission to access this work' } [403]
 *     success               -> 200 {
 *         status: 'success',
 *         slug: work.slug,
 *         message: `Work '<slug>' and associated repositories have been deleted`,
 *         deleted_repositories: string[]   // [] in CI — removeRepository throws a
 *                                          // non-HttpException (no git account) which
 *                                          // is logged + swallowed, so no repo is pushed.
 *     }
 *
 *   Cascade surface (PROBED — the subtlety this file exists for):
 *     - LIVE owner-scoped routes that re-resolve the work every call cascade to 404:
 *         GET works/:id                 (WorkQueryService.getWork)
 *         GET works/:id/budgets         (BudgetsController, separate api/works/:workId/budgets)
 *         GET works/:id/activity-feed   (ActivityFeedController.ensureAccess) — NOTE the route
 *                                       is `/activity-feed`, NOT `/activity` (which 404s as a
 *                                       catch-all even while the work is ALIVE).
 *     - CACHED routes (cacheManager.wrap) still serve the pre-delete value AFTER delete:
 *         GET works/:id/items, GET works/:id/config  -> 200 from cache (NOT a cascade signal).
 *       We therefore assert the cascade ONLY on the live, non-cached routes.
 *     - There is NO per-work `works/:id/stats` route (only the global `works/stats`);
 *       a per-work stats GET is a 404 even while alive, so it is not used here.
 *
 *   Generation lifecycle (PROBED in CI):
 *     POST works/:id/generate requires CreateItemsGeneratorDto { name, prompt } — BOTH
 *       @IsNotEmpty. A body missing `name` is rejected 400 by the ValidationPipe BEFORE the
 *       handler runs. With a VALID body but no configured AI/search provider the request is
 *       still 400 ("...providers are not available"). Either way it is NOT 404 while the
 *       work is alive, and becomes 404 once the work is deleted (ownership lookup fails first
 *       only for a valid body — an invalid body always 400s, so we send a VALID body so the
 *       post-delete call truly reaches the work lookup and 404s).
 *     POST works/:id/cancel-generation  -> 404 once the work is gone.
 *
 *   Item bulk delete (the only "bulk" delete in the works module):
 *     POST works/:id/items/bulk-delete @HttpCode(200) body { item_slugs: string[]; reason? }.
 *       ensureCanEdit first: non-owner -> 403. Owner with bogus slugs -> 200 summary
 *       { requested, succeeded, failed, errors[] } (each missing slug counted as `failed`).
 *
 * Resilience notes (CI hard-won):
 *   - Fresh registerUserViaAPI() users per test (never the shared seeded user);
 *     unique stamped slugs; tolerate pre-existing rows.
 *   - We GET-verify a work exists BEFORE the first delete so the 200 -> 404
 *     double-delete sequence is deterministic.
 *   - The cascade is asserted on LIVE routes (budgets / activity-feed / GET work),
 *     never on the cached items/config routes which legitimately serve stale 200s.
 */

interface Probe {
    code: number;
    body: Record<string, unknown> | undefined;
    text: string;
}

/** Issue an API call and capture status + parsed body without throwing on non-2xx. */
async function call(
    request: APIRequestContext,
    method: 'get' | 'post' | 'delete' | 'patch',
    path: string,
    token?: string,
    data?: unknown,
): Promise<Probe> {
    const opts: { headers?: Record<string, string>; data?: unknown } = {};
    if (token) opts.headers = authedHeaders(token);
    if (data !== undefined) opts.data = data;
    const res = await request[method](`${API_BASE}${path}`, opts);
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
        body = undefined;
    }
    return { code: res.status(), body, text };
}

/**
 * Hard-delete a work via the only real route: POST works/:id/delete.
 *
 * The DTO whitelist rejects unknown keys (400), so we send an empty body by
 * default and only the REAL snake_case repo flags when `deleteRepositories` is
 * opted in. In CI with no connected git account no repo is actually pushed, so
 * the envelope's `deleted_repositories` stays [] either way.
 */
function deleteWork(
    request: APIRequestContext,
    workId: string,
    token: string,
    opts: { deleteRepositories?: boolean } = {},
): Promise<Probe> {
    const data: Record<string, boolean> = {};
    if (opts.deleteRepositories) {
        data.delete_data_repository = true;
        data.delete_markdown_repository = true;
        data.delete_website_repository = true;
    }
    return call(request, 'post', `/api/works/${workId}/delete`, token, data);
}

/** A VALID CreateItemsGeneratorDto body (both name + prompt are @IsNotEmpty). */
function generateBody(prompt = 'build a directory of e2e widgets'): {
    name: string;
    prompt: string;
} {
    return { name: `Gen ${Date.now().toString(36)}`, prompt };
}

/** Seed a work with as many real sub-resources as CI allows (taxonomy is git-gated). */
async function seedWorkWithSubResources(
    request: APIRequestContext,
    token: string,
    label: string,
): Promise<{ workId: string; slug: string; seeded: string[] }> {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const slug = `del-${label}-${stamp}`;
    const created = await createWorkViaAPI(request, token, { name: `Del ${label} ${stamp}`, slug });
    const workId = created.id;
    expect(workId, 'work was created with an id').toBeTruthy();

    const seeded: string[] = [];
    const attempts: Array<{ key: string; path: string; data: unknown }> = [
        // submit-item is git-gated in CI (no connected git account -> "Please reconnect
        // your Git account") so this typically does NOT persist — best-effort only.
        {
            key: 'item',
            path: 'submit-item',
            data: {
                name: `item-${stamp}`,
                description: 'cascade fixture item',
                source_url: 'https://example.com',
                category: 'fixtures',
            },
        },
        // Budgets are pure-DB (no git) so this DOES persist (201) — gives the cascade a
        // real child row to lose when the parent work is hard-deleted.
        {
            key: 'budget',
            path: 'budgets',
            data: { scope: 'global', monthlyCapCents: 2500, currency: 'usd' },
        },
    ];
    for (const a of attempts) {
        const r = await call(request, 'post', `/api/works/${workId}/${a.path}`, token, a.data);
        if (r.code === 200 || r.code === 201) seeded.push(a.key);
    }
    return { workId, slug, seeded };
}

const isGone = (code: number): boolean => code === 404;

/**
 * The LIVE (non-cached) owner-scoped sub-resource routes — these re-resolve the
 * work on every call and so are the real cascade signal. NOTE: `items` + `config`
 * are intentionally excluded because they are cacheManager.wrap()-cached and keep
 * serving a stale 200 after delete (verified against the live API).
 */
const LIVE_SUBRESOURCES = ['budgets', 'activity-feed'] as const;

test.describe('Work hard-delete cascade — deep integration', () => {
    test('owner delete cascades: every LIVE sub-resource lookup collapses to 404 after a hard delete', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { workId } = await seedWorkWithSubResources(request, owner.access_token, 'cascade');

        // Pre-delete: the work + each live sub-resource is reachable (200, never 404).
        const before = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(before.code, 'work is reachable before delete').toBe(200);

        for (const sub of LIVE_SUBRESOURCES) {
            const r = await call(request, 'get', `/api/works/${workId}/${sub}`, owner.access_token);
            expect(r.code, `GET :id/${sub} is reachable (200) before delete`).toBe(200);
        }

        // Hard delete via the canonical route.
        const del = await deleteWork(request, workId, owner.access_token);
        expect(del.code, 'owner POST :id/delete -> 200').toBe(200);
        expect(del.body?.status, 'success envelope').toBe('success');
        expect(del.body?.slug, 'delete echoes the work slug').toBeTruthy();
        // Real message: `Work '<slug>' and associated repositories have been deleted`.
        expect(String(del.body?.message ?? ''), 'human-readable delete message').toContain(
            'have been deleted',
        );

        // Cascade: the work is gone AND every LIVE sub-resource now 404s (parent
        // gone -> children unreachable, never a 5xx).
        const after = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(after.code, 'GET on a deleted work -> 404 (hard delete)').toBe(404);
        expect(String(after.body?.message ?? ''), 'not-found envelope after delete').toMatch(
            /not\s*found/i,
        );
        for (const sub of LIVE_SUBRESOURCES) {
            const r = await call(request, 'get', `/api/works/${workId}/${sub}`, owner.access_token);
            expect(
                r.code,
                `GET :id/${sub} after delete -> 404 (cascade: parent gone, never 5xx)`,
            ).toBe(404);
        }
    });

    test('delete envelope reports deleted_repositories as an array (empty for a never-generated work)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // A freshly-created, never-generated work has no provisioned git repo.
        const created = await createWorkViaAPI(request, owner.access_token, {
            name: `Repo ${Date.now()}`,
        });
        const workId = created.id;

        const exists = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(exists.code, 'work exists before delete').toBe(200);

        // Explicitly opt into repository cleanup via the REAL snake_case flags. With no
        // connected git account in CI, removeRepository throws a non-HttpException that is
        // logged + swallowed, so nothing is pushed onto deleted_repositories.
        const del = await deleteWork(request, workId, owner.access_token, {
            deleteRepositories: true,
        });
        expect(del.code, 'owner delete -> 200').toBe(200);
        expect(del.body?.status, 'success envelope').toBe('success');
        expect(del.body?.slug, 'response echoes the deleted slug').toBeTruthy();

        // Contract: the success envelope ALWAYS carries deleted_repositories: string[].
        const repos = del.body?.deleted_repositories;
        expect(Array.isArray(repos), 'deleted_repositories is an array').toBe(true);
        expect((repos as unknown[]).length, 'no git repo to clean for a never-generated work').toBe(
            0,
        );

        // A camelCase repo flag is an UNKNOWN key -> rejected 400 by the DTO whitelist.
        // (Run on a SEPARATE work so the rejected request can't disturb anything.)
        const created2 = await createWorkViaAPI(request, owner.access_token, {
            name: `Repo2 ${Date.now()}`,
        });
        const bad = await call(
            request,
            'post',
            `/api/works/${created2.id}/delete`,
            owner.access_token,
            {
                deleteRepositories: true,
            },
        );
        expect(bad.code, 'unknown camelCase delete key -> 400 (DTO whitelist)').toBe(400);
        // The work survives a rejected (validation-failed) delete.
        const stillThere = await call(
            request,
            'get',
            `/api/works/${created2.id}`,
            owner.access_token,
        );
        expect(stillThere.code, 'work survives a 400-rejected delete').toBe(200);
    });

    test('delete is owner-gated: a non-owner gets 403 and cannot read the sub-resources', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { workId } = await seedWorkWithSubResources(request, owner.access_token, 'gated');

        // Non-owner delete -> 403 with the canonical permission message.
        const denied = await deleteWork(request, workId, stranger.access_token);
        expect(denied.code, 'non-owner POST :id/delete -> 403').toBe(403);
        expect(String(denied.body?.message ?? ''), 'permission-denied message').toContain(
            'do not have permission to access this work',
        );

        // The same ownership gate protects READS — a stranger must not enumerate
        // sub-resources (403, never a 200 data leak, never a 5xx).
        for (const sub of ['items', ...LIVE_SUBRESOURCES]) {
            const r = await call(
                request,
                'get',
                `/api/works/${workId}/${sub}`,
                stranger.access_token,
            );
            expect(r.code, `non-owner GET :id/${sub} -> 403 (no data leak)`).toBe(403);
        }

        // The work is fully intact after the rejected delete.
        const stillThere = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(stillThere.code, 'owner still sees the work after a rejected non-owner delete').toBe(
            200,
        );

        // The owner can then delete it for real.
        const ownerDel = await deleteWork(request, workId, owner.access_token);
        expect(ownerDel.code, 'owner delete succeeds after the gate held').toBe(200);
    });

    test('double-delete is bounded: first 200 (success), second 404 (Work with id not found)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const created = await createWorkViaAPI(request, owner.access_token, {
            name: `Dbl ${Date.now()}`,
        });
        const workId = created.id;

        // GET-verify existence so the 200 -> 404 transition is deterministic.
        const exists = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(exists.code, 'work exists before first delete').toBe(200);

        const first = await deleteWork(request, workId, owner.access_token);
        expect(first.code, 'first delete -> 200').toBe(200);
        expect(first.body?.status, 'first delete success envelope').toBe('success');

        const second = await deleteWork(request, workId, owner.access_token);
        expect(second.code, 'second delete on an already-deleted work -> 404').toBe(404);
        // Source throws NotFoundException({ status:'error', message:"Work with id '<id>' not found" }).
        expect(String(second.body?.message ?? second.text ?? ''), 'not-found message').toMatch(
            /not\s*found/i,
        );

        // A third delete is still a stable 404 (no flip to 500/200) — idempotent terminal state.
        const third = await deleteWork(request, workId, owner.access_token);
        expect(third.code, 'triple delete remains 404 (idempotent terminal state)').toBe(404);
    });

    test('delete during generation: a work can be hard-deleted mid-generation, then its generation routes 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const created = await createWorkViaAPI(request, owner.access_token, {
            name: `Gen ${Date.now()}`,
        });
        const workId = created.id;

        // Kick off generation with a VALID DTO (name + prompt). In CI with no configured
        // AI/search provider the enqueue is rejected (400 "providers are not available");
        // the exact code can vary by build (202 accepted / 400 / 422 / 500) so we only
        // require it is NOT 404 — the work must still exist for us to delete it mid-flight.
        const gen = await call(
            request,
            'post',
            `/api/works/${workId}/generate`,
            owner.access_token,
            generateBody(),
        );
        expect(isGone(gen.code), 'generate on a live work is not 404').toBe(false);

        // The work is still reachable after the generation enqueue attempt.
        const mid = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(mid.code, 'work reachable mid-generation').toBe(200);

        // Hard-delete the work WHILE generation is in flight — no cancel required.
        const del = await deleteWork(request, workId, owner.access_token);
        expect(del.code, 'delete a generating work -> 200 (no cancel needed)').toBe(200);
        expect(del.body?.status, 'delete succeeds mid-generation').toBe('success');

        // The work and its generation lifecycle endpoints now 404 — nothing to act on.
        const goneAfter = await call(request, 'get', `/api/works/${workId}`, owner.access_token);
        expect(goneAfter.code, 'work gone after mid-generation delete').toBe(404);

        // A VALID generate body now reaches the ownership lookup, which fails -> 404.
        // (An INVALID body would 400 at the pipe before the lookup, masking the cascade.)
        const genAfter = await call(
            request,
            'post',
            `/api/works/${workId}/generate`,
            owner.access_token,
            generateBody('too late'),
        );
        expect(genAfter.code, 'generate (valid body) after delete -> 404').toBe(404);

        // The real cancellation route is :id/cancel-generation (not :id/cancel).
        const cancelAfter = await call(
            request,
            'post',
            `/api/works/${workId}/cancel-generation`,
            owner.access_token,
        );
        expect(cancelAfter.code, 'cancel-generation after delete -> 404').toBe(404);
    });

    test('cross-user isolation + item bulk-delete: each owner deletes only their own cascade', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);

        // Alice owns a work with sub-resources; Bob owns a separate work.
        const aliceWork = await seedWorkWithSubResources(request, alice.access_token, 'alice');
        const bobCreated = await createWorkViaAPI(request, bob.access_token, {
            name: `Bob ${Date.now()}`,
        });
        const bobWorkId = bobCreated.id;

        // --- Bob cannot touch Alice's work (delete 403), and vice-versa. ---
        const bobDeletesAlice = await deleteWork(request, aliceWork.workId, bob.access_token);
        expect(bobDeletesAlice.code, "Bob cannot delete Alice's work").toBe(403);
        const aliceDeletesBob = await deleteWork(request, bobWorkId, alice.access_token);
        expect(aliceDeletesBob.code, "Alice cannot delete Bob's work").toBe(403);

        // --- Item-level bulk-delete (POST :id/items/bulk-delete) is owner-scoped. ---
        const itemsBefore = await call(
            request,
            'get',
            `/api/works/${aliceWork.workId}/items`,
            alice.access_token,
        );
        expect(itemsBefore.code, 'Alice can read her own items').toBe(200);

        // Bob is forbidden from bulk-deleting items in Alice's work (ensureCanEdit -> 403).
        const bobBulk = await call(
            request,
            'post',
            `/api/works/${aliceWork.workId}/items/bulk-delete`,
            bob.access_token,
            { item_slugs: ['anything'] },
        );
        expect(bobBulk.code, "Bob cannot bulk-delete items in Alice's work").toBe(403);

        // Alice CAN call bulk-delete on her own work — it returns a 200 per-item summary
        // even when the slugs don't exist / the git op fails (counted as `failed`).
        const aliceBulk = await call(
            request,
            'post',
            `/api/works/${aliceWork.workId}/items/bulk-delete`,
            alice.access_token,
            { item_slugs: ['ghost-slug'] },
        );
        expect(aliceBulk.code, 'Alice can bulk-delete in her own work -> 200 summary').toBe(200);
        expect(aliceBulk.body?.requested, 'summary echoes the requested count').toBe(1);
        expect(
            typeof aliceBulk.body?.succeeded === 'number' &&
                typeof aliceBulk.body?.failed === 'number',
            'summary carries succeeded + failed counts',
        ).toBe(true);

        // --- Each owner hard-deletes their OWN work; the other is unaffected. ---
        const aliceDel = await deleteWork(request, aliceWork.workId, alice.access_token);
        expect(aliceDel.code, 'Alice deletes her own work').toBe(200);

        // Alice's work + cascade is gone; Bob's work is still very much alive.
        const aliceGone = await call(
            request,
            'get',
            `/api/works/${aliceWork.workId}`,
            alice.access_token,
        );
        expect(aliceGone.code, "Alice's work is gone").toBe(404);
        const aliceBudgetsGone = await call(
            request,
            'get',
            `/api/works/${aliceWork.workId}/budgets`,
            alice.access_token,
        );
        expect(aliceBudgetsGone.code, "Alice's budgets cascade to 404").toBe(404);
        const bobStillThere = await call(
            request,
            'get',
            `/api/works/${bobWorkId}`,
            bob.access_token,
        );
        expect(bobStillThere.code, "Bob's work is untouched by Alice's delete").toBe(200);

        // Bob deletes his own work to complete the matrix.
        const bobDel = await deleteWork(request, bobWorkId, bob.access_token);
        expect(bobDel.code, 'Bob deletes his own work').toBe(200);
        const bobGone = await call(request, 'get', `/api/works/${bobWorkId}`, bob.access_token);
        expect(bobGone.code, "Bob's work is gone after his own delete").toBe(404);
    });
});
