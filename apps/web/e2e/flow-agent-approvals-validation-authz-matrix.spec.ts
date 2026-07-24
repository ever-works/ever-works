/**
 * Agent Action Approval Queue — VALIDATION + AUTHZ MATRIX (#1690, complementary
 * to `flow-agent-approvals-queue-deep.spec.ts`).
 *
 * The queue-deep sibling already pins the happy-path list/get/approve/reject/
 * approve-all surface plus the first tier of 400/401/404. This file is
 * deliberately ADDITIVE: it exhausts the *edges* the sibling does not touch —
 * enum case-sensitivity, present-vs-absent query semantics, query-DTO
 * whitelisting, the HTTP-method matrix on every route, element-level `ids[]`
 * validation, cross-org isolation, and malformed-Authorization variants.
 *
 *   GET    /api/agent-approvals              list (?status ?organizationId ?limit ?offset)
 *   GET    /api/agent-approvals/:id          get one
 *   POST   /api/agent-approvals/:id/approve  approve a pending proposal
 *   POST   /api/agent-approvals/:id/reject   reject a pending proposal
 *   POST   /api/agent-approvals/approve-all  bulk-approve (optional `ids` subset)
 *
 * ── Verified live (http://127.0.0.1:3100, sqlite in-memory, all flags on)
 *    before every assertion below. Probed contract (edges vs the sibling):
 *
 *   • `?status=` is a STRICT, CASE-SENSITIVE enum — `PENDING`/`Approved`/`csv`/
 *     a repeated param (→ array) all 400 with "status must be one of the
 *     following values". `status` ABSENT → 200 (default `pending`), but
 *     `status=` PRESENT-BUT-EMPTY → 400: presence, not just absence, is checked.
 *   • `?limit=` is `@IsInt @Min(1) @Max(200)` after a Number() transform — a
 *     float (`1.5`) → 400 "must be an integer number"; `200.5` → BOTH the
 *     max + integer messages; present-but-empty → 400 "must not be less than 1"
 *     (empty ⇒ 0); a repeated param → 400. `?offset=` huge (1e9) → 200, echoed
 *     verbatim into `meta.offset` (no upper bound).
 *   • `?organizationId=` present-but-empty → 400 "must be a UUID". `meta` only
 *     ever echoes `{ total, limit, offset }` — `status`/`organizationId` never
 *     leak into it. An UNKNOWN query key → 400 "property <k> should not exist"
 *     (the query DTO is forbidNonWhitelisted too).
 *   • organizationId is a pure userId-scoped WHERE filter: user B filtering by
 *     user A's REAL org id → 200 empty, never 403 — no existence leak, no
 *     cross-tenant read.
 *   • get / approve / reject are 404-never-403: an unknown-but-valid uuid and a
 *     cross-user uuid are INDISTINGUISHABLE (same 404, same "Proposal <id> not
 *     found." body). A body on approve/reject is ignored (no `@Body`) → still
 *     404, not a forbidNonWhitelisted 400. Every non-declared method
 *     (GET/PUT/PATCH/DELETE on /:id/approve; PUT/PATCH/DELETE on /:id) → 404
 *     "Cannot <METHOD> <path>".
 *   • approve-all `ids[]` is element-validated: `[null]`, `[123]`, a mixed
 *     valid+bad array → 400 "each value in ids must be a UUID". A non-array
 *     `ids` (""/{}/5) → the array/size/each cluster. A JSON-array *body*
 *     ([1,2,3]) → "property <n> should not exist"; an extra key beside a valid
 *     `ids` → "property foo should not exist". A duplicate-id array is a valid
 *     no-op → { approved: 0, skipped: 0 } (dedup is not required).
 *   • Malformed Authorization (garbage bearer / empty bearer / Basic scheme /
 *     bare token) → 401 { message: "Unauthorized", statusCode: 401 }.
 *
 *   ⚠ CONTRACT NOTE (same as the sibling): there is NO public endpoint that
 *     *creates* a pending proposal (creation is internal to
 *     `AgentApprovalsService.createProposal` at dispatch time). So a fresh
 *     user's queue is always empty and a real pending→approved/rejected
 *     transition is unreachable over HTTP. This suite therefore asserts the
 *     validation + authz + isolation MATRIX exhaustively rather than a live
 *     state transition.
 *
 * Isolation discipline: fresh registerUserViaAPI() owners per test; the write
 * throttle (30/min approve/reject/approve-all) is per-user so it is never
 * contended across tests. Fully API-orchestrated (safe `flow-` prefix).
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

const AQ_BASE = `${API_BASE}/api/agent-approvals`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A proper random v4 uuid — valid for BOTH the route ParseUUIDPipe and the
 * DTO `@IsUUID`, so probes exercise the service (not the validator). */
function randomUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** class-validator returns `message` as string[]; NestJS built-ins as a
 * string. Flatten both to one searchable string. */
function messageText(body: { message?: unknown }): string {
    const m = body.message;
    return Array.isArray(m) ? m.join(' | ') : String(m ?? '');
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// ─────────────────────────────────────────────────────────────────────────────
// A. list — the ?status enum + query-presence semantics
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals list — status enum + query presence', () => {
    test('the ?status enum is CASE-SENSITIVE: every upper/mixed-case variant → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const bad of ['PENDING', 'Approved', 'Rejected', 'PeNdInG']) {
            const res = await request.get(`${AQ_BASE}?status=${bad}`, { headers: H });
            expect(res.status(), `status=${bad}`).toBe(400);
            const body = await res.json();
            expect(body.statusCode).toBe(400);
            expect(messageText(body)).toContain('status must be one of the following values');
        }
    });

    test('status ABSENT → 200 default pending, but status PRESENT-BUT-EMPTY → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // Absent → the default pending queue.
        const absent = await request.get(AQ_BASE, { headers: H });
        expect(absent.status()).toBe(200);
        expect((await absent.json()).meta).toEqual({ total: 0, limit: 50, offset: 0 });

        // Present-but-empty is a defined-empty-string value → fails the enum.
        const empty = await request.get(`${AQ_BASE}?status=`, { headers: H });
        expect(empty.status()).toBe(400);
        expect(messageText(await empty.json())).toContain(
            'status must be one of the following values',
        );
    });

    test('a repeated ?status param (→ array) and a CSV value both → 400 (single enum only)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const dup = await request.get(`${AQ_BASE}?status=pending&status=approved`, { headers: H });
        expect(dup.status()).toBe(400);
        expect(messageText(await dup.json())).toContain(
            'status must be one of the following values',
        );

        const csv = await request.get(`${AQ_BASE}?status=pending,approved`, { headers: H });
        expect(csv.status()).toBe(400);
        expect(messageText(await csv.json())).toContain(
            'status must be one of the following values',
        );
    });

    test('an UNKNOWN query key → 400 (the query DTO is forbidNonWhitelisted)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?bogusKey=1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('property bogusKey should not exist');
    });

    test('all four filters combined → 200; meta echoes ONLY { total, limit, offset }', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `AQ Combined ${stamp()}`,
        );
        expect(org.id).toMatch(UUID_RE);
        const res = await request.get(
            `${AQ_BASE}?status=approved&limit=10&offset=5&organizationId=${org.id}`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        // status + organizationId are pure filters — they never surface in meta.
        expect(body.meta).toEqual({ total: 0, limit: 10, offset: 5 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. list — pagination numeric edges + organizationId presence
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals list — numeric edges', () => {
    test('a non-integer limit (1.5) → 400 "must be an integer number"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?limit=1.5`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('limit must be an integer number');
    });

    test('limit=200.5 trips BOTH the max-bound and integer checks → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?limit=200.5`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const msg = messageText(await res.json());
        expect(msg).toContain('limit must not be greater than 200');
        expect(msg).toContain('limit must be an integer number');
    });

    test('limit present-but-empty (⇒ 0) → 400 min; a repeated limit param → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const empty = await request.get(`${AQ_BASE}?limit=`, { headers: H });
        expect(empty.status()).toBe(400);
        expect(messageText(await empty.json())).toContain('limit must not be less than 1');

        // A repeated param arrives as an array → the Number() transform yields
        // NaN and every numeric constraint reports; we only pin the 400.
        const dup = await request.get(`${AQ_BASE}?limit=5&limit=10`, { headers: H });
        expect(dup.status()).toBe(400);
        expect(messageText(await dup.json())).toContain('limit');
    });

    test('a huge offset (1e9) → 200 empty and is echoed verbatim (no upper bound)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?offset=999999999`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 999999999 });
    });

    test('organizationId present-but-empty → 400 "must be a UUID"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${AQ_BASE}?organizationId=`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('organizationId must be a UUID');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. cross-org / cross-user isolation (404-never-403 posture)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals — isolation matrix', () => {
    test("filtering by ANOTHER user's real org id → 200 empty, never 403 (userId-scoped filter)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `AQ Iso ${stamp()}`,
        );
        expect(org.id).toMatch(UUID_RE);

        // The intruder scopes the list to the owner's org. Because the WHERE is
        // { userId: intruder, organizationId }, the row set is empty — the query
        // never crosses the user boundary and never leaks the org's existence.
        const res = await request.get(`${AQ_BASE}?organizationId=${org.id}`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('two different users GETting the SAME arbitrary uuid get byte-identical 404s (no leak)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const id = randomUuid();

        const ra = await request.get(`${AQ_BASE}/${id}`, {
            headers: authedHeaders(a.access_token),
        });
        const rb = await request.get(`${AQ_BASE}/${id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(ra.status()).toBe(404);
        expect(rb.status()).toBe(404);
        const ba = await ra.json();
        const bb = await rb.json();
        // The response cannot distinguish "not yours" from "does not exist".
        expect(ba.message).toBe(`Proposal ${id} not found.`);
        expect(bb.message).toBe(`Proposal ${id} not found.`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. approve / reject — unknown, wrong-method, ignored-body posture
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals decide — 404-never-403 + method matrix', () => {
    test('get / approve / reject of one unknown-but-valid uuid are all 404 with the SAME body', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const id = randomUuid();

        const get = await request.get(`${AQ_BASE}/${id}`, { headers: H });
        const approve = await request.post(`${AQ_BASE}/${id}/approve`, { headers: H });
        const reject = await request.post(`${AQ_BASE}/${id}/reject`, { headers: H });
        for (const res of [get, approve, reject]) {
            expect(res.status()).toBe(404);
            const body = await res.json();
            expect(body.statusCode).toBe(404);
            expect(body.message).toBe(`Proposal ${id} not found.`);
        }
    });

    test('approving THEN rejecting the same unknown id both 404 (no state to transition)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const id = randomUuid();

        const first = await request.post(`${AQ_BASE}/${id}/approve`, { headers: H });
        expect(first.status()).toBe(404);
        const second = await request.post(`${AQ_BASE}/${id}/reject`, { headers: H });
        expect(second.status()).toBe(404);
    });

    test('the nil uuid and a random v4 uuid are treated identically (both valid shapes, both 404)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const id of [NIL_UUID, randomUuid()]) {
            const res = await request.post(`${AQ_BASE}/${id}/approve`, { headers: H });
            expect(res.status(), `approve ${id}`).toBe(404);
            expect((await res.json()).message).toBe(`Proposal ${id} not found.`);
        }
    });

    test('a request BODY on approve/reject is ignored (no @Body) → still 404, not a 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), ...JSON_HEADERS };
        const id = randomUuid();

        // A stray/extra body does NOT trip forbidNonWhitelisted — these routes
        // declare no body DTO, so the service runs and 404s on the unknown id.
        const approve = await request.post(`${AQ_BASE}/${id}/approve`, {
            headers: H,
            data: { foo: 'bar', status: 'approved' },
        });
        expect(approve.status()).toBe(404);
        expect((await approve.json()).message).toBe(`Proposal ${id} not found.`);

        const reject = await request.post(`${AQ_BASE}/${id}/reject`, {
            headers: H,
            data: { anything: 123 },
        });
        expect(reject.status()).toBe(404);
    });

    test("cross-user approve of a random v4 uuid → 404 (owner's rows are never reachable)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        void owner; // owner has no proposals to steal (no create endpoint)
        const res = await request.post(`${AQ_BASE}/${randomUuid()}/approve`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(404);
    });

    test('every non-declared method on /:id/approve → 404 "Cannot <METHOD>"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const url = `${AQ_BASE}/${randomUuid()}/approve`;

        const get = await request.get(url, { headers: H });
        expect(get.status()).toBe(404);
        expect(messageText(await get.json())).toContain('Cannot GET');

        const put = await request.put(url, { headers: H });
        expect(put.status()).toBe(404);
        expect(messageText(await put.json())).toContain('Cannot PUT');

        const patch = await request.patch(url, { headers: H });
        expect(patch.status()).toBe(404);
        expect(messageText(await patch.json())).toContain('Cannot PATCH');

        const del = await request.delete(url, { headers: H });
        expect(del.status()).toBe(404);
        expect(messageText(await del.json())).toContain('Cannot DELETE');
    });

    test('there is no update/delete route on /:id: PUT / PATCH / DELETE → 404 "Cannot <METHOD>"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const url = `${AQ_BASE}/${randomUuid()}`;

        const put = await request.put(url, { headers: H });
        expect(put.status()).toBe(404);
        expect(messageText(await put.json())).toContain('Cannot PUT');

        const patch = await request.patch(url, { headers: H });
        expect(patch.status()).toBe(404);
        expect(messageText(await patch.json())).toContain('Cannot PATCH');

        const del = await request.delete(url, { headers: H });
        expect(del.status()).toBe(404);
        expect(messageText(await del.json())).toContain('Cannot DELETE');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. approve-all — element-level + shape validation of the ids[] body
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals approve-all — ids[] validation matrix', () => {
    test('element-level: [null], [123], and a mixed valid+invalid array all → 400 (each value UUID)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        const nul = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: [null] },
        });
        expect(nul.status()).toBe(400);
        expect(messageText(await nul.json())).toContain('each value in ids must be a UUID');

        const num = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: [123] },
        });
        expect(num.status()).toBe(400);
        expect(messageText(await num.json())).toContain('each value in ids must be a UUID');

        const mixed = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: [randomUuid(), 'not-a-uuid'] },
        });
        expect(mixed.status()).toBe(400);
        expect(messageText(await mixed.json())).toContain('each value in ids must be a UUID');
    });

    test('a non-array ids ("" / {} / 5) → 400 with the array/size/each cluster', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        for (const bad of ['', {}, 5] as const) {
            const res = await request.post(`${AQ_BASE}/approve-all`, {
                headers: H,
                data: { ids: bad },
            });
            expect(res.status(), `ids=${JSON.stringify(bad)}`).toBe(400);
            expect(messageText(await res.json())).toContain('ids must be an array');
        }
    });

    test('a JSON-array BODY (not an object) → 400 "property <n> should not exist"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { ...authedHeaders(user.access_token), ...JSON_HEADERS },
            data: [1, 2, 3],
        });
        expect(res.status()).toBe(400);
        // Array indices surface as forbidden properties on the DTO.
        expect(messageText(await res.json())).toContain('property 0 should not exist');
    });

    test('an extra key ALONGSIDE a valid ids array → 400 "property foo should not exist"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AQ_BASE}/approve-all`, {
            headers: { ...authedHeaders(user.access_token), ...JSON_HEADERS },
            data: { ids: [randomUuid()], foo: 1 },
        });
        expect(res.status()).toBe(400);
        expect(messageText(await res.json())).toContain('property foo should not exist');
    });

    test('a duplicate-id array is a valid no-op → { approved: 0, skipped: 0 }; trailing slash also 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { ...authedHeaders(user.access_token), ...JSON_HEADERS };

        // Dedup is not required — the same (unowned) id twice matches nothing.
        const dup = await request.post(`${AQ_BASE}/approve-all`, {
            headers: H,
            data: { ids: [NIL_UUID, NIL_UUID] },
        });
        expect(dup.status()).toBe(200);
        expect(await dup.json()).toEqual({ approved: 0, skipped: 0 });

        // The route also matches with a trailing slash.
        const slash = await request.post(`${AQ_BASE}/approve-all/`, { headers: H, data: {} });
        expect(slash.status()).toBe(200);
        expect(await slash.json()).toEqual({ approved: 0, skipped: 0 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. auth — malformed Authorization variants
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Approvals — malformed Authorization → 401', () => {
    test('garbage bearer / empty bearer / Basic scheme / bare token all → 401 Unauthorized', async ({
        request,
    }) => {
        const variants: Record<string, string> = {
            'garbage bearer': 'Bearer garbage.token.not-a-jwt',
            'empty bearer': 'Bearer ',
            'basic scheme': 'Basic dXNlcjpwYXNz',
            'bare token (no scheme)': 'deadbeefdeadbeefdeadbeef',
        };
        for (const [label, value] of Object.entries(variants)) {
            const res = await request.get(AQ_BASE, { headers: { authorization: value } });
            expect(res.status(), label).toBe(401);
            const body = await res.json();
            expect(body.statusCode).toBe(401);
            expect(body.message).toBe('Unauthorized');
        }
    });

    test('a malformed token is rejected on the WRITE routes too (approve / reject / approve-all → 401)', async ({
        request,
    }) => {
        const H = { authorization: 'Bearer garbage.token.not-a-jwt', ...JSON_HEADERS };
        const approve = await request.post(`${AQ_BASE}/${randomUuid()}/approve`, { headers: H });
        expect(approve.status()).toBe(401);
        const reject = await request.post(`${AQ_BASE}/${randomUuid()}/reject`, { headers: H });
        expect(reject.status()).toBe(401);
        const bulk = await request.post(`${AQ_BASE}/approve-all`, { headers: H, data: {} });
        expect(bulk.status()).toBe(401);
    });
});
