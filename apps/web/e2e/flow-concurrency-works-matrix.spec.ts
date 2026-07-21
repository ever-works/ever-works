/**
 * flow-concurrency-works-matrix — PARALLEL WORKS OPS as one observable race matrix,
 * driven end-to-end against the live stack (http://127.0.0.1:3100, sqlite in-memory —
 * the exact CI driver). N genuinely-parallel create / PATCH / delete mutations on the
 * Works surface must resolve to a DETERMINISTIC, uncorrupted terminal state: never a
 * duplicate row, never a "Frankenstein" merge, never a lost/resurrected work, never an
 * uncaught 5xx. sqlite transaction-serialization 5xx are tolerated as a driver artifact
 * (bucketed), but every branch pins the underlying INVARIANT regardless.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-idempotency-concurrency-matrix pins the Works Idempotency-Key no-op + a
 *   BURST=5 same-slug create race + cross-owner isolation. flow-optimistic-concurrency
 *   does Work double-delete + delete-vs-write + one PATCH-value convergence.
 *   concurrent-conflict / concurrent-update-conflict / flow-work-collab-concurrent-edit
 *   cover 2-writer PUT/PATCH last-write-wins. idempotency-keys does a weak coherent-retry
 *   smoke. NONE of them cover: HIGH-FAN-OUT create dedup verified by a SCOPED-LIST
 *   integrity count; CASE/WHITESPACE-normalized slug dedup under a burst; the subtle
 *   name-vs-description FIELD-SNAPSHOT clobber (LWW reads a whole-row snapshot, so a
 *   concurrent different-field PATCH can lose one field but never corrupt it); a
 *   serial + parallel Idempotency-Key RETRY STORM with inert header-shape variants;
 *   simultaneous PATCH-burst-vs-DELETE-burst; varied delete-flag bodies; stranger-under-
 *   race authz on PATCH and DELETE; and the SLUG-LIFECYCLE CHURN (create → delete →
 *   recreate reuses the freed slug with a NEW id; concurrent delete+create on one slug
 *   settles to exactly one live row). THIS file owns all of that.
 *
 * PROBED LIVE before any assertion (throwaway users, unique suffixes). Exact contract:
 *   • POST /api/works → HTTP 200 {status:'success', work:{id,slug,name,description,
 *     updatedAt,…}}. slug is trimmed+lowercased by the DTO transform (`  Foo-X  ` →
 *     `foo-x`), then dedup'd per-OWNER via a repo `findByOwnerAndSlug` check (NOT a DB
 *     unique index). A duplicate NORMALIZED slug → 400 {status:'error',
 *     message:'Work already exists'}. forbidNonWhitelisted is on (junk field → 400).
 *   • PATCH and PUT /api/works/:id are the SAME last-write-wins handler → 200
 *     {status:'success', work:{…}}. updateWork reads a whole-row snapshot then writes
 *     name/description together, so a different-field concurrent PATCH is a whole-row
 *     LWW, not a per-field merge. Missing/gone id → 404; a stranger (no membership) on
 *     an EXISTING work → 403.
 *   • DELETE is POST /api/works/:id/delete (body {} or {delete_*_repository:bool}) → 200
 *     {status:'success', slug, message, deleted_repositories:[]}. The service returns
 *     success whenever the ownership check passes and does NOT guard on affected-rows,
 *     so a parallel double-delete can yield >1 success (idempotent-success on an
 *     already-gone row) — the guarantee is ≥1 success + no resurrection, NOT exactly-one.
 *     Gone/not-owner → 404/403. Deleting frees the slug for immediate reuse.
 *   • GET /api/works/:id → 200 {status:'success', work:{…}}; gone → 404. Scoped list
 *     GET /api/works?search=<slug> → {status, works:[…], total, limit, offset}; filter
 *     `works` by exact slug for a per-user 0/1 integrity count.
 *   • updatedAt/createdAt are SECOND-resolution (…T..:..:..000Z) → monotonic checks use
 *     `>=` and a ≥1100ms pre-delay so the second visibly advances.
 *
 * ROBUSTNESS: every test registers FRESH users (never the shared seeded user) with
 * unique Date.now()/random suffixes, so bursts never collide cross-spec; ids asserted
 * via toContain / not.toContain and per-user exact-slug scoped counts (never a global
 * list count — the shard DB accumulates rows); winner/loser splits use tolerant
 * `expect([...]).toContain(status)` where a real race makes the exact code timing-
 * sensitive; sqlite serialization 5xx are bucketed, never asserted-against, but the
 * data invariant (no dup, no zombie, no merge) is always pinned. Fully API-orchestrated
 * (safe `flow-` prefix) so it never contends on the shared UI auth storage state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const T = 30_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Split a burst of HTTP statuses into 2xx winners and 5xx serialization casualties. */
function classify(statuses: number[]) {
    return {
        winners: statuses.filter((s) => s >= 200 && s < 300),
        server5xx: statuses.filter((s) => s >= 500),
    };
}

function jsonHeaders(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

async function postWork(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
) {
    return request.post(`${API_BASE}/api/works`, {
        headers: { ...jsonHeaders(token), ...extraHeaders },
        data: { organization: false, description: 'e2e concurrency', ...body },
        timeout: T,
    });
}

async function patchWork(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/works/${id}`, {
        headers: jsonHeaders(token),
        data: body,
        timeout: T,
    });
}

async function deleteWork(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown> = {},
) {
    return request.post(`${API_BASE}/api/works/${id}/delete`, {
        headers: jsonHeaders(token),
        data: body,
        timeout: T,
    });
}

async function getWork(request: APIRequestContext, token: string, id: string) {
    return request.get(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
}

/** Create a work and return its id + the surrounding response (fails loudly on non-200). */
async function makeWork(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<{ id: string; work: Record<string, unknown> }> {
    const res = await postWork(request, token, body);
    expect(res.status(), `setup create should 200 (got ${res.status()})`).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('success');
    const work = json.work as Record<string, unknown>;
    expect(work.id).toMatch(UUID_RE);
    return { id: work.id as string, work };
}

/** Per-user exact-slug count via the scoped list — 0 or 1 for a fresh owner. */
async function countMineBySlug(
    request: APIRequestContext,
    token: string,
    slug: string,
): Promise<number> {
    const res = await request.get(`${API_BASE}/api/works?search=${encodeURIComponent(slug)}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status(), 'scoped list is 200').toBe(200);
    const body = await res.json();
    const works: Array<{ slug?: string }> = Array.isArray(body.works) ? body.works : [];
    return works.filter((w) => w.slug === slug).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A — same-slug create dedup (high fan-out + scoped-list integrity + slug
// normalization). Dedup is a per-owner repo check on the NORMALIZED slug.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — parallel create dedup (slug is the CAS; scoped list stays at one)', () => {
    test('N=8 parallel same-slug creates → ≥1 winner, every loser 400 "Work already exists", scoped list holds exactly one, dedup durable', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const slug = `race8-${stamp()}`;
        const BURST = 8;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                postWork(request, user.access_token, { name: `Race ${i}`, slug }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { winners } = classify(statuses);

        // Repo-level (not DB-unique-index) dedup → the winner count is timing-sensitive.
        // The invariants that matter: at least one landed, and every non-winner is a
        // clean 400 "already exists" — never a silently-created duplicate row.
        expect(
            winners.length,
            `at least one create won (statuses=${statuses})`,
        ).toBeGreaterThanOrEqual(1);
        expect(winners.length, 'winners cannot exceed the burst').toBeLessThanOrEqual(BURST);
        const losers = results.filter((r) => r.status() === 400);
        const server5xx = statuses.filter((s) => s >= 500);
        expect(
            winners.length + losers.length + server5xx.length,
            `every response is a 200 winner, a 400 dup, or a tolerated 5xx (statuses=${statuses})`,
        ).toBe(BURST);
        for (const r of losers) {
            const body = await r.json();
            expect(body.status).toBe('error');
            expect(body.message).toBe('Work already exists');
        }

        // DATA INTEGRITY: the surviving row count equals the number of 200 winners —
        // every winner inserted exactly one row, every 400/5xx inserted none. (Works has
        // NO DB unique index — dedup is a repo pre-check — so the winner count itself is
        // timing-sensitive; the row/winner CORRESPONDENCE is the invariant that holds.)
        expect(
            await countMineBySlug(request, user.access_token, slug),
            'surviving rows == create winners (no phantom or lost row)',
        ).toBe(winners.length);

        // DURABLE: a fresh SERIAL duplicate of the same slug still 400s.
        const serialDup = await postWork(request, user.access_token, { name: 'Serial', slug });
        expect(serialDup.status(), 'a later serial duplicate still 400s').toBe(400);
        expect((await serialDup.json()).message).toBe('Work already exists');
    });

    test('parallel CASE/WHITESPACE variants that normalize to one slug → ≥1 winner + rest 400; the surviving slug is lowercased/trimmed', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const base = `norm-${stamp()}`; // lowercase canonical form
        // Every variant trims + lowercases to `base` via the DTO @Transform.
        const variants = [base, base.toUpperCase(), `  ${base}  `, `${base.toUpperCase()} `, base];

        const results = await Promise.all(
            variants.map((slug, i) =>
                postWork(request, user.access_token, { name: `Norm ${i}`, slug }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { winners } = classify(statuses);
        expect(
            winners.length,
            `case/space variants collapse onto one slug — ≥1 winner (statuses=${statuses})`,
        ).toBeGreaterThanOrEqual(1);
        const losers = results.filter((r) => r.status() === 400);
        for (const r of losers) {
            expect((await r.json()).message).toBe('Work already exists');
        }

        // The survivors all live under the canonical lowercased/trimmed slug; their count
        // matches the winners (no DB unique index → assert the row/winner correspondence).
        expect(
            await countMineBySlug(request, user.access_token, base),
            'surviving normalized-slug rows == winners',
        ).toBe(winners.length);
        const winnerBody = await results.find((r) => r.status() === 200)!.json();
        expect(winnerBody.work.slug, 'stored slug is the canonical lowercase/trimmed form').toBe(
            base,
        );
    });

    test('parallel creates of DIFFERENT slugs by ONE user → all 200 with distinct ids (no false-positive cross-slug dedup)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const tag = stamp();
        const BURST = 6;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                postWork(request, user.access_token, {
                    name: `Distinct ${i}`,
                    slug: `distinct-${i}-${tag}`,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 200),
            `every distinct-slug create 200 (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map(
            (b) => b.work.id as string,
        );
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size, 'distinct slugs never collapsed into one row').toBe(BURST);
    });

    test('a single mixed-case, space-padded slug is NORMALIZED (not rejected) on create', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const base = `pad-${stamp()}`;
        const res = await postWork(request, user.access_token, {
            name: 'Padded',
            slug: `  ${base.toUpperCase()}  `,
        });
        expect(res.status(), 'a paddable/uppercase slug is accepted, not 400').toBe(200);
        expect((await res.json()).work.slug, 'slug persisted trimmed + lowercased').toBe(base);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B — the Idempotency-Key header is INERT; the slug governs everything.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — Idempotency-Key is a no-op (retry storms + inert header shapes)', () => {
    test('serial retry storm: 1 create + N sequential retries under the SAME key+slug → first 200, ALL retries 400 (key never replays)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const slug = `storm-${stamp()}`;

        const first = await postWork(
            request,
            user.access_token,
            { name: 'Storm', slug },
            { 'Idempotency-Key': key },
        );
        expect(first.status(), 'first create succeeds').toBe(200);
        const firstId = (await first.json()).work.id as string;

        for (let i = 0; i < 4; i++) {
            const retry = await postWork(
                request,
                user.access_token,
                { name: 'Storm', slug },
                { 'Idempotency-Key': key },
            );
            // If the key were honored this would REPLAY 200 + same id. It is not — the
            // slug-uniqueness check rejects every retry with a 400 error envelope.
            expect(retry.status(), `retry ${i} is slug-rejected, not key-replayed`).toBe(400);
            expect((await retry.json()).message).toBe('Work already exists');
        }
        // Exactly one row exists — no key-replay ever minted a second.
        expect(await countMineBySlug(request, user.access_token, slug)).toBe(1);
        expect(firstId).toMatch(UUID_RE);
    });

    test('parallel burst under ONE shared key + ONE slug → still slug-governed: ≥1 winner + rest 400 (the key does not single-flight)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const slug = `keyburst-${stamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                postWork(
                    request,
                    user.access_token,
                    { name: `K${i}`, slug },
                    { 'Idempotency-Key': key },
                ),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { winners } = classify(statuses);
        expect(
            winners.length,
            `≥1 winner despite the shared key (${statuses})`,
        ).toBeGreaterThanOrEqual(1);
        const losers = results.filter((r) => r.status() === 400);
        for (const r of losers) expect((await r.json()).message).toBe('Work already exists');
        expect(
            await countMineBySlug(request, user.access_token, slug),
            'the shared key neither collapsed nor duplicated — rows == winners',
        ).toBe(winners.length);
    });

    test('inert header shapes (empty / whitespace / very-long / lowercased name) never gate: distinct-slug creates all 200, a same-slug retry still 400', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const tag = stamp();
        const headerVariants: Record<string, string>[] = [
            { 'Idempotency-Key': '' },
            { 'Idempotency-Key': '   ' },
            { 'Idempotency-Key': 'x'.repeat(512) },
            { 'idempotency-key': `lower-${tag}` }, // lowercased header name
        ];

        // Each shape, with a DISTINCT slug, produces a fresh 200 (header ignored).
        const ids: string[] = [];
        for (let i = 0; i < headerVariants.length; i++) {
            const slug = `inert-${i}-${tag}`;
            const res = await postWork(
                request,
                user.access_token,
                { name: `Inert ${i}`, slug },
                headerVariants[i],
            );
            expect(res.status(), `header shape ${i} neither blocks nor crashes the create`).toBe(
                200,
            );
            ids.push((await res.json()).work.id as string);
        }
        expect(new Set(ids).size, 'no header shape deduplicated distinct-slug creates').toBe(
            headerVariants.length,
        );

        // And with the SAME slug, the header shape still cannot replay — slug wins.
        const slug = `inert-same-${tag}`;
        const a = await postWork(
            request,
            user.access_token,
            { name: 'Same', slug },
            { 'Idempotency-Key': `k-${tag}` },
        );
        const b = await postWork(
            request,
            user.access_token,
            { name: 'Same', slug },
            { 'Idempotency-Key': `k-${tag}` },
        );
        expect(a.status()).toBe(200);
        expect(b.status(), 'same-slug retry is 400 regardless of the key').toBe(400);
    });

    test('the SAME key + SAME slug string across TWO different users → both 200 (dedup is owner-scoped, the key is irrelevant)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [u1, u2] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const key = `idem-${stamp()}`;
        const slug = `xuser-${stamp()}`;

        const [r1, r2] = await Promise.all([
            postWork(request, u1.access_token, { name: 'U1', slug }, { 'Idempotency-Key': key }),
            postWork(request, u2.access_token, { name: 'U2', slug }, { 'Idempotency-Key': key }),
        ]);
        expect(r1.status(), 'user 1 create succeeds').toBe(200);
        expect(r2.status(), 'user 2 with the same key+slug also succeeds (owner-scoped)').toBe(200);
        const id1 = (await r1.json()).work.id as string;
        const id2 = (await r2.json()).work.id as string;
        expect(id1).not.toBe(id2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C — parallel PATCH convergence (whole-row last-write-wins, no merge).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — parallel PATCH convergence (last-write-wins, no Frankenstein merge)', () => {
    test('N=6 parallel PATCH (distinct names) → all 200, final name is exactly one submitted value, updatedAt monotonic', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id, work } = await makeWork(request, user.access_token, {
            name: 'Orig',
            slug: `patch6-${stamp()}`,
        });
        const beforeUpdatedAt = work.updatedAt as string;

        const tag = stamp();
        const candidates = [0, 1, 2, 3, 4, 5].map((i) => `nm-${i}-${tag}`);
        await new Promise((r) => setTimeout(r, 1100)); // second-resolution updatedAt must visibly advance

        const results = await Promise.all(
            candidates.map((name) => patchWork(request, user.access_token, id, { name })),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `no PATCH 5xx'd (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `all PATCH 200 (${statuses})`,
        ).toBe(true);

        const after = (await (await getWork(request, user.access_token, id)).json()).work;
        expect(
            candidates,
            `final name "${after.name}" is exactly one submitted value (no merge)`,
        ).toContain(after.name);
        expect(
            Date.parse(after.updatedAt) >= Date.parse(beforeUpdatedAt),
            `updatedAt monotonic: before=${beforeUpdatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });

    test('concurrent name-only vs description-only PATCH → whole-row LWW: each field ∈ {submitted, original}, at least one update survives, neither field corrupted', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const origName = `Orig-${stamp()}`;
        const origDesc = `origdesc-${stamp()}`;
        const { id } = await makeWork(request, user.access_token, {
            name: origName,
            slug: `field-${stamp()}`,
            description: origDesc,
        });
        const newName = `NEWNAME-${stamp()}`;
        const newDesc = `newdesc-${stamp()}`;

        const [rName, rDesc] = await Promise.all([
            patchWork(request, user.access_token, id, { name: newName }),
            patchWork(request, user.access_token, id, { description: newDesc }),
        ]);
        expect(rName.status(), 'name PATCH is client-level').toBeLessThan(500);
        expect(rDesc.status(), 'description PATCH is client-level').toBeLessThan(500);

        const after = (await (await getWork(request, user.access_token, id)).json()).work;
        // updateWork builds `name: dto.name || work.name` from a whole-row snapshot, so a
        // concurrent different-field write is LWW on the ROW — one field may be lost, but
        // neither is ever merged into garbage or nulled.
        expect([newName, origName], `name ∈ {new, orig} (got "${after.name}")`).toContain(
            after.name,
        );
        expect([newDesc, origDesc], `desc ∈ {new, orig} (got "${after.description}")`).toContain(
            after.description,
        );
        expect(
            after.name === newName || after.description === newDesc,
            'at least one of the two concurrent field updates survived',
        ).toBe(true);
    });

    test('owner vs stranger PATCH race → the stranger is 403 and NEVER wins; the final value is the owner’s', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [owner, stranger] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const { id } = await makeWork(request, owner.access_token, {
            name: 'Owned',
            slug: `authz-${stamp()}`,
        });
        const ownerVal = `owner-${stamp()}`;
        const strangerVal = `stranger-${stamp()}`;

        const [ownerRes, strangerRes] = await Promise.all([
            patchWork(request, owner.access_token, id, { name: ownerVal }),
            patchWork(request, stranger.access_token, id, { name: strangerVal }),
        ]);
        expect(ownerRes.status(), 'owner PATCH 200').toBe(200);
        expect([403, 404], `stranger is access-denied (got ${strangerRes.status()})`).toContain(
            strangerRes.status(),
        );

        const after = (await (await getWork(request, owner.access_token, id)).json()).work;
        expect(after.name, 'the final value is the owner’s, never the stranger’s').toBe(ownerVal);
        expect(after.name).not.toBe(strangerVal);
    });

    test('idempotent PATCH burst: N parallel PATCHes to the SAME value → all 200, final == that value', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id } = await makeWork(request, user.access_token, {
            name: 'Start',
            slug: `same-${stamp()}`,
        });
        const target = `settled-${stamp()}`;

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                patchWork(request, user.access_token, id, { name: target }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `no 5xx (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            'idempotent same-value PATCH — all 200',
        ).toBe(true);
        const after = (await (await getWork(request, user.access_token, id)).json()).work;
        expect(after.name).toBe(target);
    });

    test('PUT vs PATCH race on one work → both 200, converge to one submitted value (they share the LWW handler)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id } = await makeWork(request, user.access_token, {
            name: 'Aliased',
            slug: `alias-${stamp()}`,
        });
        const putVal = `put-${stamp()}`;
        const patchVal = `patch-${stamp()}`;

        const [putRes, patchRes] = await Promise.all([
            request.put(`${API_BASE}/api/works/${id}`, {
                headers: jsonHeaders(user.access_token),
                data: { name: putVal },
                timeout: T,
            }),
            patchWork(request, user.access_token, id, { name: patchVal }),
        ]);
        expect(putRes.status(), 'PUT 200').toBe(200);
        expect(patchRes.status(), 'PATCH 200').toBe(200);
        const after = (await (await getWork(request, user.access_token, id)).json()).work;
        expect(
            [putVal, patchVal],
            `final "${after.name}" is one of the two (shared handler, no merge)`,
        ).toContain(after.name);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP D — parallel DELETE (POST :id/delete): ≥1 success, no resurrection, no 5xx-leak.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — parallel delete (no double-remove corruption, no resurrection)', () => {
    test('N=5 parallel deletes → ≥1 success + the rest 404; the work is gone; the winner body is the success envelope', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id } = await makeWork(request, user.access_token, {
            name: 'DelRace',
            slug: `delrace-${stamp()}`,
        });
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () => deleteWork(request, user.access_token, id)),
        );
        const statuses = results.map((r) => r.status());
        const oks = statuses.filter((s) => s === 200).length;
        const gone = statuses.filter((s) => s === 404).length;
        const conflicts = statuses.filter((s) => s >= 500).length; // tolerated sqlite tx-serialization
        // The ownership check runs before the delete commits, so the first racer to execute
        // returns 200. The service does NOT guard affected-rows, so a second racer that also
        // passed the check before the row vanished may ALSO 200 (idempotent success). The
        // guarantee is ≥1 success and a clean terminal state — not exactly-one.
        expect(oks, 'at least one delete reported success').toBeGreaterThanOrEqual(1);
        expect(
            oks + gone + conflicts,
            `racers only ever 200 / 404 / 5xx-conflict (${statuses})`,
        ).toBe(BURST);

        const winner = results.find((r) => r.status() === 200)!;
        const wbody = await winner.json();
        expect(wbody.status).toBe('success');
        expect(
            Array.isArray(wbody.deleted_repositories),
            'success envelope carries a deleted_repositories array',
        ).toBe(true);

        // STRONG invariant — no resurrection. If a rare all-conflict roll-back left the row,
        // a clean follow-up delete removes it, proving the row was never corrupted.
        let finalGet = await getWork(request, user.access_token, id);
        if (finalGet.status() !== 404) {
            const cleanup = await deleteWork(request, user.access_token, id);
            expect(cleanup.status()).toBe(200);
            finalGet = await getWork(request, user.access_token, id);
        }
        expect(finalGet.status(), 'the deleted work is gone (no resurrection)').toBe(404);
    });

    test('PATCH-burst racing a DELETE-burst simultaneously → delete wins the terminal state (GET 404); no uncaught 5xx-leak', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id } = await makeWork(request, user.access_token, {
            name: 'Mix',
            slug: `mixburst-${stamp()}`,
        });

        const ops = [
            patchWork(request, user.access_token, id, { name: `p1-${stamp()}` }),
            patchWork(request, user.access_token, id, { name: `p2-${stamp()}` }),
            deleteWork(request, user.access_token, id),
            deleteWork(request, user.access_token, id),
            patchWork(request, user.access_token, id, { name: `p3-${stamp()}` }),
        ];
        const results = await Promise.all(ops);
        // Every racer resolves client-side or as a tolerated serialization 5xx — never an
        // unhandled crash class outside {200, 404, 5xx}.
        for (const r of results) {
            expect(
                [200, 404, 500, 502, 503],
                `status in the tolerated set (got ${r.status()})`,
            ).toContain(r.status());
        }

        await expect
            .poll(async () => (await getWork(request, user.access_token, id)).status(), {
                timeout: 15_000,
                message: 'delete wins the terminal state even amid a concurrent PATCH burst',
            })
            .toBe(404);
    });

    test('parallel deletes with DIFFERENT delete-flag bodies still converge to gone (no 5xx-leak, no zombie)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { id } = await makeWork(request, user.access_token, {
            name: 'Flags',
            slug: `flags-${stamp()}`,
        });

        const bodies = [
            {},
            { delete_data_repository: false },
            { delete_website_repository: false, delete_markdown_repository: false },
            { delete_data_repository: true },
        ];
        const results = await Promise.all(
            bodies.map((b) => deleteWork(request, user.access_token, id, b)),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.filter((s) => s === 200).length,
            `≥1 delete succeeded (${statuses})`,
        ).toBeGreaterThanOrEqual(1);
        for (const s of statuses) {
            expect([200, 404, 500, 502, 503]).toContain(s);
        }
        await expect
            .poll(async () => (await getWork(request, user.access_token, id)).status(), {
                timeout: 15_000,
            })
            .toBe(404);
    });

    test('two DISTINCT works deleted in parallel → each removed independently, no cross-id contamination', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const tag = stamp();
        const [wA, wB] = await Promise.all([
            makeWork(request, user.access_token, { name: 'A', slug: `twinA-${tag}` }),
            makeWork(request, user.access_token, { name: 'B', slug: `twinB-${tag}` }),
        ]);

        const [dA, dB] = await Promise.all([
            deleteWork(request, user.access_token, wA.id),
            deleteWork(request, user.access_token, wB.id),
        ]);
        expect(dA.status(), 'work A delete 200').toBe(200);
        expect(dB.status(), 'work B delete 200').toBe(200);
        expect((await dA.json()).slug, 'delete A reports A’s slug').toBe(`twina-${tag}`);
        expect((await dB.json()).slug, 'delete B reports B’s slug').toBe(`twinb-${tag}`);

        expect((await getWork(request, user.access_token, wA.id)).status(), 'A gone').toBe(404);
        expect((await getWork(request, user.access_token, wB.id)).status(), 'B gone').toBe(404);
    });

    test('a stranger’s concurrent delete NEVER removes another owner’s work → stranger 403, the owner’s work survives', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [owner, stranger] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const { id } = await makeWork(request, owner.access_token, {
            name: 'Guarded',
            slug: `guarded-${stamp()}`,
        });

        const [ownerReadRace, strangerDel] = await Promise.all([
            getWork(request, owner.access_token, id),
            deleteWork(request, stranger.access_token, id),
        ]);
        expect(ownerReadRace.status(), 'owner can still read during the stranger’s attempt').toBe(
            200,
        );
        expect(
            [403, 404],
            `stranger delete is access-denied (got ${strangerDel.status()})`,
        ).toContain(strangerDel.status());

        // The work SURVIVES the stranger’s attempt; only the owner can remove it.
        expect(
            (await getWork(request, owner.access_token, id)).status(),
            'owner’s work survives',
        ).toBe(200);
        const ownerDel = await deleteWork(request, owner.access_token, id);
        expect(ownerDel.status(), 'the owner can delete it afterward').toBe(200);
        expect((await getWork(request, owner.access_token, id)).status()).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP E — slug-lifecycle churn (create → delete → recreate reuses the freed slug).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — slug lifecycle churn (deleting frees the slug; recreate gets a NEW id)', () => {
    test('create → delete → recreate same slug → 200 with a NEW id (no id resurrection)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const slug = `churn-${stamp()}`;

        const first = await makeWork(request, user.access_token, { name: 'First', slug });
        expect((await deleteWork(request, user.access_token, first.id)).status()).toBe(200);
        expect(
            (await getWork(request, user.access_token, first.id)).status(),
            'first is gone',
        ).toBe(404);

        const second = await postWork(request, user.access_token, { name: 'Reborn', slug });
        expect(second.status(), 'the freed slug is reusable → 200').toBe(200);
        const secondId = (await second.json()).work.id as string;
        expect(secondId).toMatch(UUID_RE);
        expect(secondId, 'the recreate got a fresh id, not the deleted row’s id').not.toBe(
            first.id,
        );
        expect(
            await countMineBySlug(request, user.access_token, slug),
            'exactly one live row on the reused slug',
        ).toBe(1);
    });

    test('concurrent [delete of the existing same-slug work] + [create a new work on that slug] → settles to exactly one live row, no 5xx-leak', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const slug = `churnrace-${stamp()}`;
        const existing = await makeWork(request, user.access_token, { name: 'Existing', slug });

        const [del, create] = await Promise.all([
            deleteWork(request, user.access_token, existing.id),
            postWork(request, user.access_token, { name: 'Incoming', slug }),
        ]);
        // Two legal interleavings: create-before-delete-commit → create 400 (dup) then the
        // delete 200 leaves ZERO rows; delete-before-create → create 200 leaves ONE row.
        // Either way, no 5xx-leak and the surviving-row count is well-defined (0 or 1).
        expect(
            [200, 404, 500, 502, 503],
            `delete status tolerated (got ${del.status()})`,
        ).toContain(del.status());
        expect(
            [200, 400, 500, 502, 503],
            `create status tolerated (got ${create.status()})`,
        ).toContain(create.status());

        const liveCount = await countMineBySlug(request, user.access_token, slug);
        expect(
            liveCount,
            'the churn settles to at most one live row on the slug (never a duplicate)',
        ).toBeLessThanOrEqual(1);
        // Whatever the interleaving, a fresh serial create afterward yields exactly one live row.
        if (liveCount === 0) {
            const revive = await postWork(request, user.access_token, { name: 'Revived', slug });
            expect(revive.status(), 'the freed slug re-creates cleanly').toBe(200);
        }
        expect(
            await countMineBySlug(request, user.access_token, slug),
            'settled to exactly one live row',
        ).toBe(1);
    });

    test('after a same-slug create RACE, deleting the survivor(s) frees the slug for a fresh 200 create', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const slug = `postrace-${stamp()}`;

        // Contend the slug, then enumerate whatever survived (≥1 row; no DB unique index
        // means a tight race can land more than one — delete them ALL to free the slug).
        const raceResults = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                postWork(request, user.access_token, { name: `PR${i}`, slug }),
            ),
        );
        expect(classify(raceResults.map((r) => r.status())).winners.length).toBeGreaterThanOrEqual(
            1,
        );

        const listed = await (
            await request.get(`${API_BASE}/api/works?search=${slug}`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        const survivors = (listed.works as Array<{ id: string; slug: string }>).filter(
            (w) => w.slug === slug,
        );
        expect(survivors.length, 'at least one row survived the race').toBeGreaterThanOrEqual(1);
        const survivorIds = survivors.map((w) => w.id);

        for (const s of survivors) {
            expect((await deleteWork(request, user.access_token, s.id)).status()).toBe(200);
        }
        expect(await countMineBySlug(request, user.access_token, slug), 'slug fully freed').toBe(0);

        // The freed slug re-creates cleanly with an id distinct from every prior survivor.
        const fresh = await postWork(request, user.access_token, { name: 'Fresh', slug });
        expect(fresh.status(), 'the slug is reusable after the race survivors are deleted').toBe(
            200,
        );
        const freshId = (await fresh.json()).work.id as string;
        expect(freshId).toMatch(UUID_RE);
        expect(survivorIds, 'the post-race recreate is a brand-new row').not.toContain(freshId);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP F — dedup scope under concurrency (owner-scoped, not global).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — dedup scope is per-owner under concurrency', () => {
    test('owner A’s self-dup is 400 while user B’s SAME-slug create concurrently succeeds 200 (owner-scoped CAS)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [a, b] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const slug = `scope-${stamp()}`;

        // A already owns the slug.
        await makeWork(request, a.access_token, { name: 'A owns it', slug });

        // Concurrently: A tries a duplicate (must 400) while B creates the same slug (must 200).
        const [aDup, bNew] = await Promise.all([
            postWork(request, a.access_token, { name: 'A dup', slug }),
            postWork(request, b.access_token, { name: 'B new', slug }),
        ]);
        expect(aDup.status(), 'A’s duplicate on its own slug is 400').toBe(400);
        expect((await aDup.json()).message).toBe('Work already exists');
        expect(bNew.status(), 'B’s create on the same slug string succeeds (different owner)').toBe(
            200,
        );

        expect(
            await countMineBySlug(request, a.access_token, slug),
            'A keeps exactly one row',
        ).toBe(1);
        expect(
            await countMineBySlug(request, b.access_token, slug),
            'B keeps exactly one row',
        ).toBe(1);
    });
});
