import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Organization Vision (PR-6, review §23.5) — the org's long-term direction as
 * a plain nullable FIELD (`vision` text + `visionUpdatedAt` timestamp) on
 * `organizations`, per the operator ruling: a field, not an entity; optional
 * at creation, editable in settings; its one consumer is fenced prompt
 * context for agents (Idea generation, agent-run assembly, mission ticks).
 *
 * Purely additive to the sibling org suite:
 *   - flow-org-lifecycle-deep.spec.ts       → POST/list/check-slug/get-by-slug.
 *   - flow-org-settings-persistence.spec.ts → PATCH profile fields + the full
 *     authz boundary (cross-tenant 404 not-leak / no-tenant 401 / anon 401).
 * NEITHER touches the new `vision` / `visionUpdatedAt` columns.
 *
 * CONTRACT (from the PR-6 lead brief — this spec is written concurrently with
 * the backend change, so impl-defined edges are asserted TOLERANTLY, in the
 * suite's environment-adaptive style, with the tolerance called out inline):
 *   - POST  /api/organizations  { name, vision? } → 201; omitted vision → NULL.
 *   - GET   /api/organizations/:slug (global resolver, sibling-verified 200
 *     for any authed user) exposes `vision` + `visionUpdatedAt`.
 *   - PATCH /api/organizations/:id { vision } → 200, `visionUpdatedAt`
 *     advances (>= previous — same-second writes are legal); `vision: null`
 *     clears the field (nullable column ⇒ the sibling-documented
 *     "@IsOptional + null = explicit clear" semantics, like legalName).
 *   - Injected prompt text is capped (~2000 chars) DOWNSTREAM; the STORAGE
 *     cap is impl-defined → over-cap probe accepts reject-or-trim (see flow 4).
 *   - Authz: identical to the sibling PATCH contract — cross-tenant callers
 *     get the 404 not-leak (NOT a 403; verified live in
 *     flow-org-settings-persistence flow 5a).
 *
 * Cross-spec isolation: every flow runs on a FRESH registerUserViaAPI() user
 * (Date.now()-unique names) so the shared in-memory DB stays clean; the seeded
 * storageState user is never touched and nothing loads at module scope (the
 * e2e-1000 sharding gotcha: module-scope loads run at collection in EVERY
 * shard, before setup). `flow-` filename ⇒ authed project, safe vs the
 * playwright.config no-auth testMatch/testIgnore regexes.
 */

const VISION_TEXT = 'Be the best cat-business platform';

interface OrgVisionRow {
    id: string;
    tenantId: string;
    slug: string;
    displayName: string | null;
    vision?: string | null;
    visionUpdatedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** POST /api/organizations (raw — caller inspects status; body may carry `vision`). */
function createOrgRaw(request: APIRequestContext, token: string, body: Record<string, unknown>) {
    return request.post(`${API_BASE}/api/organizations`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** POST and assert 201 + return the parsed row. */
async function createOrgOk(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<OrgVisionRow> {
    const res = await createOrgRaw(request, token, body);
    expect(
        res.status(),
        `POST /api/organizations ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(201);
    return res.json();
}

/** PATCH /api/organizations/:id (raw — caller inspects status). */
function patchOrgRaw(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/organizations/${id}`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** PATCH and assert 200 + return the parsed row. */
async function patchOrgOk(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
): Promise<OrgVisionRow> {
    const res = await patchOrgRaw(request, token, id, body);
    expect(
        res.status(),
        `PATCH ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(200);
    return res.json();
}

/** GET /api/organizations/:slug — the global slug resolver (fresh DB read). */
async function getBySlug(
    request: APIRequestContext,
    token: string,
    slug: string,
): Promise<OrgVisionRow> {
    const res = await request.get(`${API_BASE}/api/organizations/${encodeURIComponent(slug)}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `get-by-slug body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Millis of a serialized timestamp, or NaN when null/undefined/garbage. */
function millis(ts: string | null | undefined): number {
    return ts ? new Date(ts).getTime() : NaN;
}

test.describe('Organization Vision field (PR-6)', () => {
    test('flow 1: create WITHOUT vision → 201 with vision + visionUpdatedAt both null, durable across the slug-resolver re-read', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const org = await createOrgOk(request, token, { name: `No Vision Org ${s}` });
        expect(org.id).toBeTruthy();
        expect(org.slug).toBeTruthy();
        // POST echo: `?? null` tolerates the create-echo undefined-vs-null
        // ambiguity (an unset nullable column can be absent from the insert
        // echo) while still failing on ANY actual value.
        expect(org.vision ?? null, 'omitted vision must not default to a value').toBeNull();
        expect(org.visionUpdatedAt ?? null, 'no vision ⇒ no vision timestamp').toBeNull();

        // Durable, fresh DB read via the global slug resolver: both columns
        // are truly NULL, not just missing from the create echo.
        const fresh = await getBySlug(request, token, org.slug);
        expect(fresh.id).toBe(org.id);
        expect(fresh.vision ?? null).toBeNull();
        expect(fresh.visionUpdatedAt ?? null).toBeNull();
    });

    test('flow 2: create WITH vision → 201, GET returns the exact text + a parseable visionUpdatedAt timestamp', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const org = await createOrgOk(request, token, {
            name: `Vision Org ${s}`,
            vision: VISION_TEXT,
        });
        expect(org.vision, 'create must accept + echo the optional vision').toBe(VISION_TEXT);

        // Fresh read: the vision persisted verbatim and the change timestamp
        // was stamped. Assert "ISO" tolerantly — a string that parses to a
        // real date — rather than a strict `T`-format regex, because the
        // sqlite e2e driver's timestamp serialization is driver-defined
        // (siblings compare via Date.parse for the same reason).
        const fresh = await getBySlug(request, token, org.slug);
        expect(fresh.vision).toBe(VISION_TEXT);
        expect(typeof fresh.visionUpdatedAt, 'setting vision must stamp visionUpdatedAt').toBe(
            'string',
        );
        expect(
            Number.isFinite(millis(fresh.visionUpdatedAt)),
            `visionUpdatedAt should be a parseable timestamp, got: ${fresh.visionUpdatedAt}`,
        ).toBe(true);
    });

    test('flow 3: PATCH updates vision and advances visionUpdatedAt (>= previous); PATCH vision:null clears it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Born WITH a vision so there is a previous timestamp to advance from.
        const org = await createOrgOk(request, token, {
            name: `Vision Patch Org ${s}`,
            vision: `Original direction ${s}`,
        });
        const before = await getBySlug(request, token, org.slug);
        const t1 = millis(before.visionUpdatedAt);
        expect(Number.isFinite(t1), 'baseline visionUpdatedAt must exist').toBe(true);

        // 1. Update the vision → new text, timestamp advances. >= (not >)
        //    because a same-second write is legal on second-resolution stores.
        const patched = await patchOrgOk(request, token, org.id, { vision: 'New direction' });
        expect(patched.vision).toBe('New direction');
        const t2 = millis(patched.visionUpdatedAt);
        expect(Number.isFinite(t2)).toBe(true);
        expect(
            t2,
            'visionUpdatedAt must advance (or hold) on a vision change',
        ).toBeGreaterThanOrEqual(t1);

        // Durable via a fresh read (persisted, not just echoed).
        const afterPatch = await getBySlug(request, token, org.slug);
        expect(afterPatch.vision).toBe('New direction');
        expect(millis(afterPatch.visionUpdatedAt)).toBeGreaterThanOrEqual(t1);

        // 2. EXPLICIT CLEAR: vision:null wipes the text (nullable column ⇒
        //    null is a valid "clear", per the sibling-documented legalName
        //    semantics on this endpoint).
        const cleared = await patchOrgOk(request, token, org.id, { vision: null });
        expect(cleared.vision ?? null, 'vision:null must clear the field').toBeNull();

        const afterClear = await getBySlug(request, token, org.slug);
        expect(afterClear.vision ?? null).toBeNull();
        // Whether the clear NULLs the timestamp too or bumps it is
        // impl-defined (the lead brief pins only the vision column) — accept
        // either, but reject a garbage/unparseable leftover.
        const clearedTs = afterClear.visionUpdatedAt ?? null;
        if (clearedTs !== null) {
            expect(
                Number.isFinite(millis(clearedTs)),
                `post-clear visionUpdatedAt must be null or a real timestamp, got: ${clearedTs}`,
            ).toBe(true);
        }
    });

    test('flow 4: over-cap vision (6000 chars) → either a 400 reject (row inert) or stored trimmed to the cap (<= 5000)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const org = await createOrgOk(request, token, { name: `Vision Cap Org ${s}` });
        const longVision = 'V'.repeat(6000);

        // TOLERANT BY DESIGN: the PROMPT-side cap is ~2000 chars, but the
        // STORAGE-side behaviour for oversized input is impl-defined at the
        // time this spec is written (concurrent backend agent): a validation
        // 400 and a store-trimmed-to-cap 200 are BOTH acceptable contracts.
        // Anything else (unmapped 500, or storing the full 6000 chars
        // untrimmed) is a real bug this test must catch.
        const res = await patchOrgRaw(request, token, org.id, { vision: longVision });
        expect(
            [400, 200],
            `over-cap vision PATCH must reject or trim, got ${res.status()}: ${await res
                .text()
                .catch(() => '')}`,
        ).toContain(res.status());

        const fresh = await getBySlug(request, token, org.slug);
        if (res.status() === 400) {
            // Rejected write is inert — the row never had a vision and still
            // must not (the ValidationPipe short-circuits before the service).
            expect(fresh.vision ?? null, 'a 400-rejected vision must not land').toBeNull();
        } else {
            // Accepted ⇒ stored value must be capped. 5000 is the generous
            // upper bound from the PR-6 brief (any DTO cap ≤ 5000 passes);
            // the stored text must still be a prefix of what we sent.
            expect(typeof fresh.vision).toBe('string');
            const stored = fresh.vision as string;
            expect(
                stored.length,
                `stored vision must be trimmed to the cap, got length ${stored.length}`,
            ).toBeLessThanOrEqual(5000);
            expect(stored.length).toBeGreaterThan(0);
            expect(longVision.startsWith(stored), 'trimmed vision must be a prefix').toBe(true);
        }
    });

    test('flow 5: authz — a cross-tenant caller PATCHing another user’s org vision gets the 404 not-leak, and the owner’s vision survives untouched', async ({
        request,
    }) => {
        const s = stamp();

        // Owner A with a known vision.
        const userA = await registerUserViaAPI(request);
        const orgA = await createOrgOk(request, userA.access_token, {
            name: `Vision AuthZ A ${s}`,
            vision: `A's true north ${s}`,
        });

        // Attacker B HAS their own tenant (clears the no-tenant 401 guard, so
        // we exercise the ownership check itself — mirrors
        // flow-org-settings-persistence flow 5a, where the contract is a 404
        // not-leak: cross-tenant is reported identically to a missing id, so
        // B cannot even confirm A's org exists. NOT a 403.
        const userB = await registerUserViaAPI(request);
        await createOrgOk(request, userB.access_token, { name: `Vision AuthZ B ${s}` });

        const crossRes = await patchOrgRaw(request, userB.access_token, orgA.id, {
            vision: 'HIJACKED VISION',
        });
        expect(
            crossRes.status(),
            `cross-tenant vision PATCH must 404 not-leak, body=${await crossRes
                .text()
                .catch(() => '')}`,
        ).toBe(404);
        const crossBody = await crossRes.json();
        expect(crossBody.error).toBe('Not Found');
        expect(String(crossBody.message)).toContain(orgA.id);

        // The rejected foreign write never landed: A's vision is intact on a
        // fresh read (and B reading it through the GLOBAL slug resolver —
        // sibling-verified world-readable — sees the original, proving the
        // 404 above was the write guard, not a read failure).
        const freshA = await getBySlug(request, userA.access_token, orgA.slug);
        expect(freshA.vision, 'owner vision must survive the foreign probe').toBe(
            `A's true north ${s}`,
        );
        const readByB = await getBySlug(request, userB.access_token, orgA.slug);
        expect(readByB.vision).toBe(`A's true north ${s}`);
    });
});
